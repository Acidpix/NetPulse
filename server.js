/**
 * NetPulse — Backend Node.js
 * Fonctionnalités : persistance JSON, ping ICMP, network discovery
 *
 * Résolution de nom (cascade) :
 *   1. DNS inverse (PTR record)
 *   2. mDNS / Avahi  (.local — via avahi-resolve-address)
 *   3. LLMNR          (via systemd-resolve)
 *   4. NetBIOS        (via nmblookup)
 *   5. SNMP sysName   (via snmpget, communauté "public")
 *   6. Fallback : IP brute
 *
 * Paquets système requis pour la résolution étendue :
 *   sudo apt install -y avahi-utils samba-common-bin snmp
 *
 * Dépendances npm :
 *   npm install express ping cors
 *
 * Lancement :
 *   sudo node server.js
 */

const express      = require('express');
const ping         = require('ping');
const cors         = require('cors');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const dns          = require('dns').promises;
const dgram        = require('dgram');
const { execFile } = require('child_process');

const app         = express();
const PORT        = process.env.PORT || 3000;
const HOSTS_FILE  = path.join(__dirname, 'hosts.json');
const MAX_HISTORY = 100;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Utilitaires réseau ──────────────────────────────────────────────────────

function getNetworkInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({
          interface: name,
          ip:        addr.address,
          netmask:   addr.netmask,
          subnet:    cidrFromIpMask(addr.address, addr.netmask),
        });
      }
    }
  }
  return result;
}

function cidrFromIpMask(ip, mask) {
  const parts = ip.split('.').slice(0, 3).join('.');
  const bits  = mask.split('.').reduce((acc, o) =>
    acc + (parseInt(o) >>> 0).toString(2).replace(/0/g, '').length, 0);
  return `${parts}.0/${bits}`;
}

function cidrToIpList(cidr) {
  const [base, prefix] = cidr.split('/');
  const bits = parseInt(prefix);
  if (bits < 16) throw new Error('Subnet trop large (min /16)');
  const parts  = base.split('.').map(Number);
  const count  = Math.pow(2, 32 - bits) - 2;
  const ipNums = [];
  const baseNum = (parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3];
  const netNum  = baseNum & (~((1 << (32 - bits)) - 1));
  for (let i = 1; i <= count && i < 254 * 4; i++) {
    const n = netNum + i;
    if ((n & 0xFF) === 0 || (n & 0xFF) === 255) continue;
    ipNums.push([(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF].join('.'));
  }
  return ipNums;
}

// ─── Protocoles de résolution de nom ─────────────────────────────────────────

/**
 * 1. DNS inverse (PTR)
 * Interroge le serveur DNS configuré sur le système.
 */
async function tryDnsReverse(ip) {
  try {
    const names = await dns.reverse(ip);
    // Nettoyer le FQDN : retirer le domaine si souhaité
    const name = names[0]?.replace(/\.$/, '') || null;
    return name ? { name, method: 'DNS' } : null;
  } catch { return null; }
}

/**
 * 2. mDNS — via avahi-resolve-address (Avahi daemon requis)
 * Résout les noms .local sur le segment local sans serveur DNS.
 * Requis : sudo apt install avahi-utils
 */
function tryMdns(ip) {
  return new Promise(resolve => {
    execFile('avahi-resolve-address', ['-4', ip], { timeout: 2500 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Format : "192.168.1.10\thostname.local"
      const match = stdout.match(/\S+\.local/i);
      resolve(match ? { name: match[0].replace(/\.$/, ''), method: 'mDNS' } : null);
    });
  });
}

/**
 * 3. LLMNR — via systemd-resolve (Link-Local Multicast Name Resolution)
 * Protocole Windows/Linux pour la résolution sans DNS sur le LAN.
 * Disponible si systemd-resolved est actif.
 */
function tryLlmnr(ip) {
  return new Promise(resolve => {
    execFile('systemd-resolve', ['--llmnr=yes', ip], { timeout: 2500 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Format : "192.168.1.10: hostname"  ou  "hostname: 192.168.1.10"
      const match = stdout.match(/:\s+([A-Za-z0-9][\w\-.]+)/);
      if (!match) return resolve(null);
      const name = match[1].replace(/\.$/, '');
      // Éviter de retourner une IP comme nom
      if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return resolve(null);
      resolve({ name, method: 'LLMNR' });
    });
  });
}

/**
 * 4. NetBIOS — via nmblookup (Windows workgroups, NAS, imprimantes)
 * Requis : sudo apt install samba-common-bin
 */
function tryNetbios(ip) {
  return new Promise(resolve => {
    execFile('nmblookup', ['-A', ip], { timeout: 2500 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Cherche le nom de machine (type <00>) en ignorant le groupe (type <00> GROUP)
      const match = stdout.match(/^\s+([A-Za-z0-9_\-]{1,15})\s+<00>\s+-\s+[^G]/m);
      if (!match) {
        // Fallback : prendre la première ligne <00> quel que soit le type
        const m2 = stdout.match(/^\s+([A-Za-z0-9_\-]{1,15})\s+<00>/m);
        return resolve(m2 ? { name: m2[1].trim(), method: 'NetBIOS' } : null);
      }
      resolve({ name: match[1].trim(), method: 'NetBIOS' });
    });
  });
}

/**
 * 5. SNMP sysName (OID 1.3.6.1.2.1.1.5.0)
 * Fonctionne sur les équipements réseau (switch, routeur, NAS, serveurs Linux/Windows
 * avec snmpd configuré). Communauté "public" par défaut.
 * Requis : sudo apt install snmp
 */
function trySnmp(ip) {
  return new Promise(resolve => {
    execFile(
      'snmpget',
      ['-v2c', '-c', 'public', '-t', '2', '-r', '1', '-OqvU', ip, '1.3.6.1.2.1.1.5.0'],
      { timeout: 3500 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const name = stdout.trim().replace(/^"|"$/g, '').replace(/\x00/g, '').trim();
        resolve(name && name.length > 0 && !/no such/i.test(name)
          ? { name, method: 'SNMP' }
          : null);
      }
    );
  });
}

/**
 * 6. SNMP sysDescr comme dernier recours SNMP
 * Retourne le premier mot de la description (souvent l'OS ou le modèle).
 */
function trySnmpDescr(ip) {
  return new Promise(resolve => {
    execFile(
      'snmpget',
      ['-v2c', '-c', 'public', '-t', '2', '-r', '1', '-OqvU', ip, '1.3.6.1.2.1.1.1.0'],
      { timeout: 3500 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const raw  = stdout.trim().replace(/^"|"$/g, '');
        const word = raw.split(/[\s,;]/)[0];
        resolve(word && word.length > 2 && !/no such/i.test(word)
          ? { name: word, method: 'SNMP-descr' }
          : null);
      }
    );
  });
}

/**
 * Cascade complète de résolution.
 * Chaque méthode est tentée en parallèle par groupe pour minimiser la latence.
 * Ordre de priorité : DNS > mDNS > LLMNR > NetBIOS > SNMP sysName > SNMP descr > IP
 */
async function resolveName(ip) {
  // Groupe 1 : méthodes rapides en parallèle (DNS + mDNS + LLMNR)
  const [dns_, mdns, llmnr] = await Promise.all([
    tryDnsReverse(ip),
    tryMdns(ip),
    tryLlmnr(ip),
  ]);
  if (dns_)  return dns_;
  if (mdns)  return mdns;
  if (llmnr) return llmnr;

  // Groupe 2 : méthodes plus lentes en parallèle (NetBIOS + SNMP)
  const [netbios, snmp, snmpDescr] = await Promise.all([
    tryNetbios(ip),
    trySnmp(ip),
    trySnmpDescr(ip),
  ]);
  if (netbios)  return netbios;
  if (snmp)     return snmp;
  if (snmpDescr) return snmpDescr;

  // Fallback : IP brute
  return { name: ip, method: 'IP' };
}

// ─── Persistance JSON ────────────────────────────────────────────────────────

function loadHosts() {
  try {
    if (fs.existsSync(HOSTS_FILE))
      return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  } catch (err) {
    console.error('Erreur lecture hosts.json :', err.message);
  }
  return [];
}

function saveHosts(hosts) {
  try {
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
  } catch (err) {
    console.error('Erreur écriture hosts.json :', err.message);
  }
}

// ─── Route : info serveur ────────────────────────────────────────────────────

app.get('/api/server-info', (req, res) => {
  res.json({ interfaces: getNetworkInterfaces(), hostname: os.hostname() });
});

// ─── Routes hôtes ────────────────────────────────────────────────────────────

app.get('/api/hosts', (req, res) => res.json(loadHosts()));

app.post('/api/hosts', (req, res) => {
  const { name, ip, type } = req.body;
  if (!name || !ip || !type)
    return res.status(400).json({ error: 'name, ip et type sont requis.' });
  const hosts   = loadHosts();
  const maxId   = hosts.reduce((m, h) => Math.max(m, h.id), 0);
  const newHost = { id: maxId + 1, name, ip, type, history: [] };
  hosts.push(newHost);
  saveHosts(hosts);
  console.log(`✚ Hôte ajouté : ${name} (${ip})`);
  res.status(201).json(newHost);
});

app.put('/api/hosts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { name, ip, type } = req.body;
  if (!name || !ip || !type)
    return res.status(400).json({ error: 'name, ip et type sont requis.' });
  const hosts  = loadHosts();
  const target = hosts.find(h => h.id === id);
  if (!target) return res.status(404).json({ error: 'Hôte introuvable.' });
  const ipChanged = target.ip !== ip;
  target.name = name; target.ip = ip; target.type = type;
  if (ipChanged) target.history = [];
  saveHosts(hosts);
  console.log(`✎ Hôte modifié : ${name} (${ip})${ipChanged ? ' [historique réinitialisé]' : ''}`);
  res.json(target);
});

app.delete('/api/hosts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  let hosts = loadHosts();
  const before = hosts.length;
  hosts = hosts.filter(h => h.id !== id);
  if (hosts.length === before)
    return res.status(404).json({ error: 'Hôte introuvable.' });
  saveHosts(hosts);
  console.log(`✖ Hôte supprimé : id=${id}`);
  res.json({ deleted: id });
});

// ─── Export ──────────────────────────────────────────────────────────────────

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="netpulse-config.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(loadHosts());
});

// ─── Route ping ──────────────────────────────────────────────────────────────

app.get('/api/ping', async (req, res) => {
  const { host, id } = req.query;
  if (!host) return res.status(400).json({ error: 'Paramètre "host" manquant.' });

  let online = false, latency = null;
  try {
    const result = await ping.promise.probe(host, { timeout: 3, extra: ['-c', '1'] });
    online  = result.alive;
    latency = result.alive ? parseFloat(result.avg) : null;
  } catch (err) {
    console.error(`Erreur ping ${host} :`, err.message);
  }

  const timestamp = new Date().toISOString();

  if (id) {
    const hostId = parseInt(id);
    const hosts  = loadHosts();
    const target = hosts.find(h => h.id === hostId);
    if (target) {
      if (!target.history) target.history = [];
      target.history.unshift({ online, latency, timestamp });
      if (target.history.length > MAX_HISTORY)
        target.history = target.history.slice(0, MAX_HISTORY);
      saveHosts(hosts);
    }
  }
  res.json({ host, online, latency, timestamp });
});

// ─── Network Discovery (SSE) ─────────────────────────────────────────────────

app.get('/api/discover', async (req, res) => {
  const subnet = req.query.subnet;
  if (!subnet) return res.status(400).json({ error: 'Paramètre "subnet" manquant.' });

  let ips;
  try { ips = cidrToIpList(subnet); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send  = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const BATCH = 30;
  const found = [];
  let scanned = 0;

  send({ type: 'start', total: ips.length });

  for (let i = 0; i < ips.length; i += BATCH) {
    const batch = ips.slice(i, i + BATCH);
    await Promise.all(batch.map(async ip => {
      try {
        const result = await ping.promise.probe(ip, { timeout: 1, extra: ['-c', '1'] });
        if (result.alive) {
          const { name, method } = await resolveName(ip);
          const entry = { ip, name, method, latency: parseFloat(result.avg) };
          found.push(entry);
          send({ type: 'found', ...entry });
        }
      } catch { /* hôte inaccessible */ }
      scanned++;
      send({ type: 'progress', scanned: Math.min(scanned, ips.length), total: ips.length });
    }));
  }

  send({ type: 'done', found: found.length });
  res.end();
});

// ─── Démarrage ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const ifaces = getNetworkInterfaces();
  console.log(`\n✅ NetPulse backend démarré`);
  ifaces.forEach(i =>
    console.log(`   Accessible sur : http://${i.ip}:${PORT}/network-monitor.html  (${i.interface})`));
  console.log(`   Hôtes persistés dans : ${HOSTS_FILE}`);
  console.log(`   Subnet(s) détecté(s) : ${ifaces.map(i => i.subnet).join(', ')}`);
  console.log(`\n   Résolution de nom : DNS → mDNS → LLMNR → NetBIOS → SNMP\n`);
});
