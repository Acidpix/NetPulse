<div align="center">

<script type="text/javascript" src="https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js" data-name="bmc-button" data-slug="Acidpix" data-color="#5F7FFF" data-emoji=""  data-font="Lato" data-text="Buy me what you want" data-outline-color="#000000" data-font-color="#ffffff" data-coffee-color="#FFDD00" ></script>

# 🟢 NetPulse

**Lightweight, self-hosted network monitoring dashboard — no heavy dependencies required.**

Monitor your VMs, servers, workstations and switches in real time via ICMP ping,  
with persistent history, automatic network discovery, and a modern dark UI.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Debian%2012-orange)](https://debian.org)

</div>

---

## ✨ Features

- **Real ICMP ping** — live reachability checks with latency in ms
- **Persistent history** — up to 100 entries per host, saved in `hosts.json`
- **Network Discovery** — CIDR subnet scan with automatic DNS + NetBIOS resolution
- **Grid / List view** — instant toggle, sortable columns (name, type, latency, uptime)
- **Edit & delete hosts** — modal editor with warning if IP changes (history reset)
- **JSON export** — download the full configuration (hosts + history)
- **systemd service** — automatic restart on boot and on crash
- **No database** — 100% JSON file storage

---

## 📸 Preview

```
┌─────────────────────────────────────────────────────────┐
│  🟢 NETPULSE   [Grid] [List]  [Discovery] [Export]      │
│  Real backend · 192.168.1.10 (debian-srv)               │
├───────────┬───────────┬───────────┬───────────┐         │
│  Online 7 │ Offline 1 │ Checking 0│ Total   8 │         │
├───────────┴───────────┴───────────┴───────────┘         │
│  [All] [Online] [Offline] [VM] [Servers] [Switch]       │
│                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│  │ Server       │ │ VM           │ │ Switch       │    │
│  │ web-srv-01   │ │ vm-dev-01    │ │ sw-core-01   │    │
│  │ 192.168.1.10 │ │ 192.168.1.101│ │ 192.168.1.254│    │
│  │ ● Online     │ │ ● Online     │ │ ● Online     │    │
│  │ 3ms  100%    │ │ 12ms  95%    │ │ 1ms   100%   │    │
│  └──────────────┘ └──────────────┘ └──────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 📁 File structure

```
netpulse/
├── server.js              # Node.js backend (API + Discovery + ping)
├── network-monitor.html   # Frontend (served statically by Express)
├── package.json           # npm dependencies
├── netpulse.service       # systemd unit file
├── hosts.json             # Created automatically on first run
└── README.md              # This file
```

---

# 🚀 Installation on Debian 12

### Step 1 — Update the system

```bash
sudo apt update && sudo apt upgrade -y
```

### Step 2 — Install Node.js 20

Debian 12 ships with an outdated version of Node.js. Use the official NodeSource repository:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# Verify
node -v   # → v20.x.x
npm -v    # → 10.x.x
```

### Step 3 — Create the application folder

```bash
sudo mkdir -p /opt/netpulse
sudo chown $USER:$USER /opt/netpulse
```

### Step 4 — Copy the files

**From your local machine (SCP):**
```bash
cd /opt/netpulse
wget https://github.com/Acidpix/NetPulse/releases/download/Main_release/NetPulse_v0.1_Release.zip
unzip NetPulse_v0.1_Release.zip
```

### Step 5 — Install npm dependencies

```bash
npm install
```
### Step 6 — (Optional) Manual test

```bash
sudo node /opt/netpulse/server.js
```

Open `http://SERVER_IP:3000/network-monitor.html` in your browser.  
If the page loads correctly, everything is working. Stop with **Ctrl+C** and move to the next step.

### Step 7 — Install the systemd service

```bash
# Copy the service file
sudo cp /opt/netpulse/netpulse.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable netpulse
sudo systemctl start netpulse

# Verify
sudo systemctl status netpulse
# → Active: active (running) ✅
```

### Step 8 — Open the firewall port (if UFW is active)

```bash
sudo ufw status
sudo ufw allow 3000/tcp
sudo ufw reload
```

### Step 9 — Access the dashboard

```
http://SERVER_IP:3000/network-monitor.html
```

The banner at the top should display **"Real backend"** in green, along with the server IP and hostname detected automatically.

---

# Usage

## 🔍 Network Discovery

Click the **Discovery** button in the header to open the scan panel:

1. The server's subnet is **pre-filled automatically** (e.g. `192.168.1.0/24`)
2. Click **Scan** to ping every IP in the subnet in parallel batches
3. Each live host goes through a **multi-protocol name resolution cascade**
4. Click **+ Add** per device, or **+ Add all** to import the entire result at once

Supported subnet sizes: `/16` to `/30` (larger subnets are rejected to prevent abuse).

---

### 🔎 Name resolution cascade

NetPulse tries each protocol in order and stops at the first successful result.  
The two groups run in parallel to minimize total scan time.

| Priority | Protocol | Method | Best for |
|:---:|---|---|---|
| 1 | **DNS reverse (PTR)** | System DNS server | Domain-joined machines, servers |
| 2 | **mDNS** (Avahi) | `avahi-resolve-address` | Linux/Mac with Avahi, printers, IoT |
| 3 | **LLMNR** | `systemd-resolve` | Windows PCs, Windows servers |
| 4 | **NetBIOS** | `nmblookup` | Windows workgroups, NAS, older devices |
| 5 | **SNMP sysName** | `snmpget` OID `1.3.6.1.2.1.1.5.0` | Switches, routers, managed equipment |
| 6 | **SNMP sysDescr** | `snmpget` OID `1.3.6.1.2.1.1.1.0` | Fallback SNMP (model/OS as name) |
| 7 | **IP address** | — | Final fallback if all else fails |

The resolved method is displayed as a badge on each discovered host (`DNS`, `mDNS`, `LLMNR`, `NetBIOS`, `SNMP`, `SNMP-descr`, `IP`).

---

### 📦 System packages required for extended resolution

Install once on the Debian server:

```bash
sudo apt install -y avahi-utils samba-common-bin snmp
sudo systemctl restart netpulse
```

| Package | Protocols enabled |
|---|---|
| `avahi-utils` | mDNS (`.local` names) |
| `samba-common-bin` | NetBIOS |
| `snmp` | SNMP sysName / sysDescr |

> All three are optional — NetPulse gracefully skips any protocol whose tool is not installed.  
> DNS reverse and LLMNR use system tools already present on Debian (`systemd-resolve`).

---

### 🤖 Automatic type detection

The device type is guessed from the resolved name:

| Name pattern | Detected type |
|---|---|
| `sw-*`, `switch`, `core`, `access`, `dist` | Switch |
| `router`, `rt`, `gw`, `gateway` | Router |
| `srv`, `server`, `dc`, `db`, `web`, `mail` | Server |
| `vm`, `virt` | VM |
| *(anything else)* | Workstation |

---

## 🔄 Day-to-day commands

| Action | Command |
|---|---|
| Check service status | `sudo systemctl status netpulse` |
| Follow live logs | `sudo journalctl -u netpulse -f` |
| Last 100 log lines | `sudo journalctl -u netpulse -n 100` |
| Restart | `sudo systemctl restart netpulse` |
| Stop | `sudo systemctl stop netpulse` |
| Disable autostart | `sudo systemctl disable netpulse` |

---

## ⚙️ Configuration

### Change the port

In `server.js`:
```js
const PORT = process.env.PORT || 3000; // ← change here
```

Or via the service file (no code change needed):
```bash
sudo nano /etc/systemd/system/netpulse.service
# Edit: Environment=PORT=8080
sudo systemctl daemon-reload && sudo systemctl restart netpulse
```

### Change the history limit

In `server.js`:
```js
const MAX_HISTORY = 100; // ← increase if needed
```

### Change the refresh interval

In `network-monitor.html`, find the `setInterval` line:
```js
setInterval(checkAll, 30000); // ← milliseconds (30s by default)
```

---

## 🌐 (Optional) Expose via Nginx

To serve NetPulse on port 80 with a domain name or internal hostname:

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/netpulse
```

```nginx
server {
    listen 80;
    server_name netpulse.yourdomain.local;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/netpulse /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx
```

Access via: `http://netpulse.yourdomain.local`

---

## 🔁 Updating files

```bash
sudo systemctl stop netpulse
sudo cp server.js network-monitor.html /opt/netpulse/
cd /opt/netpulse && npm install   # only if package.json changed
sudo systemctl start netpulse
```

---

## ❓ Troubleshooting

### The service won't start

```bash
sudo journalctl -u netpulse -n 50
# Read the error messages
```

### All hosts show as offline

ICMP ping requires root privileges. Verify the service is running as root:
```bash
sudo systemctl status netpulse
# The "User=" line should be absent or set to root
```

### The banner stays in "Simulation" mode despite the backend running

The frontend is most likely opened from your local PC while the backend runs on a remote server.  
Access the frontend **directly through the server's IP**:
```
http://SERVER_IP:3000/network-monitor.html
```
Auto-detection works because `window.location.hostname` then returns the server's IP, which is used to probe the backend.

### Discovery: resolution tools not found

Install the missing packages:
```bash
sudo apt install -y avahi-utils samba-common-bin snmp
sudo systemctl restart netpulse
```

Check which tools are available:
```bash
which avahi-resolve-address   # mDNS
which nmblookup               # NetBIOS
which snmpget                 # SNMP
which systemd-resolve         # LLMNR (usually pre-installed)
```

NetPulse skips any tool that is not installed — only the available protocols are used.

### Port 3000 already in use

```bash
sudo lsof -i :3000        # find which process uses the port
# Then change the port in the service file (see Configuration section)
```

---

## 📦 Dependencies

| Package | Version | Role |
|---|---|---|
| `express` | ^4.18 | HTTP server, static file serving |
| `ping` | ^0.4 | Native ICMP ping |
| `cors` | ^2.8 | CORS headers for cross-origin access |

Native Node.js modules used (no install needed): `fs`, `os`, `dns`, `child_process`

---

## 📄 License

MIT — free to use, modify and redistribute.
