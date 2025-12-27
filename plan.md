 Building lwtcp Guest Tool for Networking

 Overview

 Create a guest-side TCP client (lwtcp) that allows programs inside the Linux terminal to make HTTP
  requests through the WebSocket proxy.

 Architecture

 Userland (lwtcp)
     ↓ open/read/write/ioctl on /dev/lwnet
 Kernel Driver (net_wasm.c)
     ↓ wasm_net_* host callbacks
 JavaScript Host (linux-worker.js)
     ↓ postMessage
 Main Thread (linux.js → NetProxy)
     ↓ WebSocket
 Proxy Server (Railway)
     ↓ TCP
 Internet

 ---
 Implementation Steps

 Step 1: Create Kernel Patch

 File: linux-wasm/patches/kernel/0015-Add-Wasm-network-support.patch

 Creates:
 - arch/wasm/drivers/net_wasm.c - Misc char device driver
 - Updates arch/wasm/drivers/Kconfig - Add NET_WASM option
 - Updates arch/wasm/drivers/Makefile - Build net_wasm.o
 - Updates arch/wasm/configs/wasm_defconfig - Enable CONFIG_NET_WASM

 Driver design (net_wasm.c):
 #include <linux/miscdevice.h>
 #include <linux/fs.h>
 #include <linux/uaccess.h>

 extern int wasm_net_open(const char *host, int port);
 extern int wasm_net_write(int connId, const char *buf, int len);
 extern int wasm_net_read(int connId, char *buf, int count);
 extern int wasm_net_poll(int connId);
 extern void wasm_net_close(int connId);

 // ioctl commands
 #define LWNET_IOC_MAGIC 'N'
 #define LWNET_OPEN    _IOWR(LWNET_IOC_MAGIC, 1, struct lwnet_open_args)
 #define LWNET_CLOSE   _IOW(LWNET_IOC_MAGIC, 2, int)

 struct lwnet_open_args {
     char host[256];
     int port;
     int connId;  // output
 };

 // Device provides:
 // - ioctl(LWNET_OPEN) → open connection, get connId
 // - ioctl(LWNET_CLOSE) → close connection
 // - read() → read from current connection
 // - write() → write to current connection

 Step 2: Create lwtcp Userland Tool

 File: linux-wasm/patches/initramfs/lwtcp.c

 #include <stdio.h>
 #include <stdlib.h>
 #include <fcntl.h>
 #include <unistd.h>
 #include <sys/ioctl.h>
 #include <string.h>

 int main(int argc, char *argv[]) {
     if (argc != 3) {
         fprintf(stderr, "Usage: lwtcp <host> <port>\n");
         return 1;
     }

     int fd = open("/dev/lwnet", O_RDWR);
     // ioctl to open connection
     // read from stdin, write to device
     // read from device, write to stdout
     // close
 }

 Step 3: Build Script for lwtcp

 File: linux-wasm/tools/build-lwtcp.sh

 #!/bin/bash
 $LW_INSTALL/llvm/bin/clang \
     --target=wasm32-unknown-unknown \
     -Xclang -target-feature -Xclang +atomics \
     -Xclang -target-feature -Xclang +bulk-memory \
     -fPIC --sysroot=$LW_INSTALL/musl \
     -o lwtcp.wasm lwtcp.c

 Step 4: Update Build Script

 File: linux-wasm/linux-wasm.sh

 Add after line 65 (kernel patches):
 git -C "$LW_SRC/kernel" am < "$LW_ROOT/patches/kernel/0015-Add-Wasm-network-support.patch"

 Add lwtcp to initramfs build (after BusyBox):
 # Build and add lwtcp
 tools/build-lwtcp.sh
 cp lwtcp.wasm $LW_INSTALL/initramfs/bin/lwtcp

 Step 5: Update init Script

 File: linux-wasm/patches/initramfs/init

 Add device node creation:
 mknod /dev/lwnet c 10 123  # misc device

 Step 6: Rebuild and Deploy

 cd linux-wasm

 # Rebuild kernel with new driver
 ./linux-wasm.sh build-kernel

 # Rebuild initramfs with lwtcp
 ./linux-wasm.sh build-initramfs

 # Copy to site
 cp install/vmlinux.wasm ../site/
 cp install/initramfs/initramfs.cpio.gz ../site/

 ---
 Files Summary

 | File                                               | Action                           |
 |----------------------------------------------------|----------------------------------|
 | patches/kernel/0015-Add-Wasm-network-support.patch | CREATE - Kernel driver           |
 | patches/initramfs/lwtcp.c                          | CREATE - Userland tool           |
 | tools/build-lwtcp.sh                               | CREATE - Build script            |
 | linux-wasm.sh                                      | MODIFY - Add patch + lwtcp build |
 | patches/initramfs/init                             | MODIFY - Create /dev/lwnet       |

 ---
 Usage After Implementation

 # Fetch a webpage
 echo -e "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n" | lwtcp example.com 80

 # Download a file
 lwtcp httpbin.org 80 < request.txt > response.txt

 ---
 Previous Plan (Reference)

 Overview

 Extend the linux-wasm browser terminal with:
 1. Networking - WebSocket proxy for TCP connections (HTTP/HTTPS)
 2. Persistent Storage - IndexedDB-backed filesystem
 3. Package Management - Lightweight system to install pre-compiled WASM tools

 ---
 Architecture Diagram

 +-----------------------------------------------------------------------------------+
 |                                    BROWSER                                         |
 +-----------------------------------------------------------------------------------+
 |                                                                                    |
 |  +----------------+     postMessage()     +-------------------+                    |
 |  |   Main Thread  |<--------------------->|   linux-worker.js |                   |
 |  |   (linux.js)   |   SharedArrayBuffer   |   (Web Worker)    |                   |
 |  +----------------+   Atomics.wait/notify +-------------------+                    |
 |         |                                          |                               |
 |    +----+----+                                     | runs                          |
 |    |         |                                     v                               |
 |  +-v----+ +--v------+                      +-------------------+                   |
 |  |NetPrx| |IndexedDB|                      |  vmlinux.wasm     |                   |
 |  |Client| |  Sync   |                      |  (Linux kernel)   |                   |
 |  +------+ +---------+                      +-------------------+                   |
 |      |         |                                   |                               |
 |      | WSS     | persist                           | host_callbacks               |
 |      v         v                                   v                               |
 |  +------+  +--------+                      +-------------------+                   |
 |  | Proxy|  |Browser |                      | lwtcp, lwpkg     |                   |
 |  |Server|  |Storage |                      | (guest CLI tools) |                  |
 |  +------+  +--------+                      +-------------------+                   |
 +-----------------------------------------------------------------------------------+

 ---
 PHASE 1: Networking Layer

 1.1 Components

 | Component                 | Location             | Purpose
 |
 |---------------------------|----------------------|----------------------------------------------
 |
 | WebSocket Proxy Server    | server/ws-proxy.js   | Node.js server that bridges WebSocket to TCP
 |
 | NetProxy Client           | site/net-proxy.js    | Browser-side WebSocket client
 |
 | linux.js additions        | site/linux.js        | Message handlers for net_* operations
 |
 | linux-worker.js additions | site/linux-worker.js | Host callbacks (wasm_net_*)
 |
 | lwtcp CLI                 | initramfs/bin/lwtcp  | Guest-side TCP client
 |

 1.2 Security Requirements (MANDATORY)

 const SECURITY_CONFIG = {
   // Port allowlist - ONLY these ports allowed
   allowedPorts: [80, 443],

   // Blocked IP ranges (SSRF protection)
   blockedCIDRs: [
     '10.0.0.0/8',           // Private Class A
     '172.16.0.0/12',        // Private Class B
     '192.168.0.0/16',       // Private Class C
     '127.0.0.0/8',          // Loopback
     '169.254.0.0/16',       // Link-local
     '169.254.169.254/32',   // Cloud metadata (AWS/GCP/Azure)
     '::1/128',              // IPv6 loopback
     'fc00::/7',             // IPv6 private
     'fe80::/10'             // IPv6 link-local
   ],

   // Rate limits
   rateLimits: {
     bytesPerMinute: 10 * 1024 * 1024,  // 10 MB/min
     connectionsPerMinute: 30,
     maxConcurrentConnections: 5,
     connectionTimeout: 30000,          // 30 seconds
     idleTimeout: 60000                 // 1 minute
   },

   // Authentication
   auth: {
     enabled: true,
     jwtSecret: process.env.JWT_SECRET  // MUST be set
   }
 };

 1.3 Protocol (JSON + Base64)

 // Client → Server
 {t:"open", id, host, port}    // Open connection
 {t:"write", id, b64}          // Write data (base64 encoded)
 {t:"close", id}               // Close connection

 // Server → Client
 {t:"opened", id}              // Connection opened
 {t:"data", id, b64}           // Data received (base64 encoded)
 {t:"closed", id}              // Connection closed
 {t:"error", id, msg}          // Error occurred

 1.4 TLS Strategy

 Approach: TLS Termination at Proxy Server
 - Guest sends HTTP to proxy on port 443
 - Proxy upgrades to HTTPS when connecting to target
 - Avoids compiling TLS library to WASM
 - Server handles certificate validation

 1.5 Files to Create/Modify

 New Files:

 1. server/ws-proxy.js - WebSocket-to-TCP bridge (~400 lines)
 2. server/package.json - Node.js dependencies (ws, jsonwebtoken)
 3. site/net-proxy.js - Browser NetProxy client (~200 lines)

 Modified Files:

 1. site/linux.js - Add net_* message callbacks after line 110
 2. site/linux-worker.js - Add wasm_net_* host callbacks after line 250
 3. site/index.html - Include net-proxy.js, initialize NetProxy

 ---
 PHASE 2: Persistent Storage

 2.1 Strategy: IndexedDB + Memory Sync

 Approach:
 1. On page load: Restore files from IndexedDB into memory before kernel boots
 2. On file write: Sync changed files to IndexedDB
 3. On page unload: Final sync of any pending changes

 2.2 Filesystem Structure

 /                     (ramfs - volatile)
 ├── bin/              (from initramfs - read-only)
 ├── dev/              (devices - volatile)
 ├── proc/             (procfs - volatile)
 ├── sys/              (sysfs - volatile)
 ├── tmp/              (volatile)
 ├── home/             (PERSISTENT - IndexedDB backed)
 │   └── user/
 ├── root/             (PERSISTENT - IndexedDB backed)
 └── opt/              (PERSISTENT - for installed packages)
     └── packages/

 2.3 Implementation Approach

 Option A: Userland Sync Tool (Simpler - Recommended for MVP)

 - Create lwsync CLI tool that runs in guest
 - Periodically syncs /home, /root, /opt to IndexedDB via host callback
 - User runs lwsync save before leaving
 - On boot, init script runs lwsync restore

 Option B: Automatic VFS Hook (More Complex)

 - Hook into filesystem syscalls in linux-worker.js
 - Intercept write/unlink operations for persistent paths
 - Automatically sync to IndexedDB

 2.4 Files to Create/Modify

 New Files:

 1. site/fs-persist.js - IndexedDB filesystem wrapper (~150 lines)

 Modified Files:

 1. site/linux.js - Add fs_* message callbacks for persistence
 2. site/linux-worker.js - Add wasm_fs_* host callbacks
 3. site/index.html - Load persisted state before boot

 ---
 PHASE 3: Package Management

 3.1 Strategy: Pre-compiled WASM Binaries

 Since we can't run npm/brew directly (they require their runtimes), we'll:
 1. Pre-compile popular tools to WASM
 2. Host them on a package registry (CDN or your server)
 3. Create lwpkg CLI to download and install

 3.2 Package Format

 {
   "name": "jq",
   "version": "1.7",
   "description": "Command-line JSON processor",
   "binary": "https://packages.example.com/jq-1.7.wasm",
   "size": 245000,
   "sha256": "abc123..."
 }

 3.3 Package Registry

 Host a simple JSON index:
 https://packages.example.com/index.json
 {
   "packages": {
     "jq": { "version": "1.7", "url": "...", "sha256": "..." },
     "vim": { "version": "9.0", "url": "...", "sha256": "..." },
     "python": { "version": "3.11", "url": "...", "sha256": "..." }
   }
 }

 3.4 lwpkg CLI Commands

 lwpkg update              # Fetch latest package index
 lwpkg search <query>      # Search available packages
 lwpkg install <name>      # Download and install package
 lwpkg list                # List installed packages
 lwpkg remove <name>       # Remove package

 3.5 Files to Create

 1. site/pkg-registry.js - Package index fetcher
 2. Guest tool: lwtcp + custom logic = lwpkg
 3. Package registry server (or use static JSON on CDN)

 ---
 Implementation Order

 Step 1: WebSocket Proxy Server (Node.js)

 # Create server directory
 mkdir -p server
 cd server
 npm init -y
 npm install ws jsonwebtoken

 # Create ws-proxy.js with security controls

 Key code sections:
 - IPValidator class (block private ranges)
 - RateLimiter class
 - DNSResolver with rebinding protection
 - Authenticator (JWT validation)
 - WSProxyServer main class

 Step 2: Browser NetProxy Client

 # Create site/net-proxy.js

 Key methods:
 - open(host, port) → Promise
 - write(connId, data)
 - onData(connId, callback)
 - close(connId)

 Step 3: Modify linux.js

 Add after line 110 (after log: callback):

 net_open: async (message, worker) => {
   // Open connection via NetProxy
   // Store in netConnections map
   // Signal completion via Atomics
 },

 net_write: (message, worker) => {
   // Write to connection
   // Read data from shared memory at message.buffer
 },

 net_read: (message, worker) => {
   // Read buffered data
   // Write to shared memory at message.buffer
 },

 net_close: (message, worker) => {
   // Close connection and cleanup
 },

 Step 4: Modify linux-worker.js

 Add after line 250 (after console driver callbacks):

 wasm_net_open: (host_ptr, port) => {
   // Read host string from memory
   // Post net_open message to main thread
   // Wait on Atomics for response
   // Return connId or -1
 },

 wasm_net_write: (connId, buffer, len) => {
   // Post net_write message
   // Wait for completion
 },

 wasm_net_read: (connId, buffer, count) => {
   // Post net_read message
   // Wait for data
   // Return bytes read
 },

 wasm_net_close: (connId) => {
   // Post net_close message
 },

 Step 5: Update index.html

 <!-- Add after xterm.js include -->
 <script src="net-proxy.js"></script>
 <script src="fs-persist.js"></script>

 // After creating os object:
 const WS_PROXY_URL = 'wss://your-server.com/ws';
 os.initNetProxy(WS_PROXY_URL);

 // Before boot, restore filesystem:
 await restoreFilesystemFromIndexedDB();

 Step 6: Create lwtcp Guest Tool

 Simple C program that:
 1. Parses host:port from args
 2. Calls wasm_net_open()
 3. Reads stdin, calls wasm_net_write()
 4. Polls wasm_net_read(), writes to stdout
 5. Calls wasm_net_close()

 # Usage in guest:
 echo -e "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n" | lwtcp example.com 80

 Step 7: Persistent Storage (fs-persist.js)

 class FilesystemPersist {
   constructor() {
     this.db = null;
     this.STORE_NAME = 'files';
   }

   async init() {
     // Open IndexedDB
   }

   async saveFile(path, content) {
     // Store file in IndexedDB
   }

   async loadFile(path) {
     // Retrieve file from IndexedDB
   }

   async listFiles(prefix) {
     // List files with path prefix
   }

   async deleteFile(path) {
     // Remove file from IndexedDB
   }
 }

 Step 8: Package Manager (lwpkg)

 1. Fetch package index via lwtcp
 2. Parse JSON, find package
 3. Download WASM binary via lwtcp
 4. Save to /opt/packages/ (persisted via IndexedDB)
 5. Create symlink in /usr/local/bin/

 ---
 Deployment Architecture

                     Internet
                         │
             ┌───────────┴───────────┐
             │                       │
             v                       v
     +---------------+      +------------------+
     | Cloudflare    |      | WebSocket Proxy  |
     | Pages (Static)|      | (Node.js Server) |
     +---------------+      +------------------+
     | - index.html  |      | - ws-proxy.js    |
     | - linux.js    |      | - JWT validation |
     | - vmlinux.wasm|      | - Rate limiting  |
     | - initramfs   |      | - SSRF protection|
     | - net-proxy.js|      | - TLS termination|
     +---------------+      +------------------+
           │                       │
           │    wss://            │ TCP
           └───────┬──────────────┘
                   │
                   v
            Target Servers
            (example.com:80/443)

 ---
 Security Warnings

 +------------------------------------------------------------------+
 |                    !! SECURITY WARNING !!                         |
 |                                                                   |
 | The WebSocket proxy creates SSRF (Server-Side Request Forgery)   |
 | risks. ALL security measures are MANDATORY:                       |
 |                                                                   |
 | 1. Port allowlist (80/443 only)                                  |
 | 2. IP range blocking (private, loopback, metadata)               |
 | 3. DNS rebinding protection                                       |
 | 4. Rate limiting (connections, bandwidth)                        |
 | 5. Authentication (JWT)                                          |
 | 6. TLS for WebSocket connection (wss://)                         |
 |                                                                   |
 | Without these, attackers could:                                  |
 | - Access internal services (Redis, databases)                    |
 | - Scan internal networks                                          |
 | - Access cloud metadata endpoints                                |
 | - Exfiltrate data                                                |
 +------------------------------------------------------------------+

 ---
 Testing Checklist

 Phase 1: Networking

 - WebSocket proxy starts without errors
 - Connections to allowed ports (80, 443) succeed
 - Connections to blocked ports fail
 - Connections to private IPs blocked
 - Rate limits enforced
 - lwtcp can fetch HTTP response from example.com

 Phase 2: Persistence

 - Files saved to IndexedDB survive page refresh
 - lwsync save/restore works
 - /home and /opt directories persist
 - Large files (>1MB) handled correctly

 Phase 3: Packages

 - lwpkg update fetches index
 - lwpkg install downloads and installs package
 - Installed packages persist across reloads
 - lwpkg remove cleans up correctly

 ---
 File Summary

 New Files to Create:

 | File                | Purpose              | Lines (est.) |
 |---------------------|----------------------|--------------|
 | server/ws-proxy.js  | WebSocket-TCP bridge | ~400         |
 | server/package.json | Node.js deps         | ~10          |
 | site/net-proxy.js   | Browser WS client    | ~200         |
 | site/fs-persist.js  | IndexedDB wrapper    | ~150         |

 Files to Modify:

 | File                 | Changes                                       |
 |----------------------|-----------------------------------------------|
 | site/linux.js        | Add net_*, fs_* message callbacks             |
 | site/linux-worker.js | Add wasm_net_*, wasm_fs_* host callbacks      |
 | site/index.html      | Include new JS, init networking + persistence |

 Guest Tools (requires initramfs rebuild):

 | Tool   | Purpose                       |
 |--------|-------------------------------|
 | lwtcp  | TCP client via host callbacks |
 | lwsync | Filesystem sync to IndexedDB  |
 | lwpkg  | Package manager               |

 ---
 Proxy Server Deployment (Railway/Render)

 Railway Deployment

 Create server/railway.json:
 {
   "$schema": "https://railway.app/railway.schema.json",
   "build": {
     "builder": "NIXPACKS"
   },
   "deploy": {
     "startCommand": "node ws-proxy.js",
     "healthcheckPath": "/health",
     "restartPolicyType": "ON_FAILURE"
   }
 }

 Environment variables to set in Railway dashboard:
 JWT_SECRET=<generate-secure-random-string>
 AUTH_ENABLED=true
 PORT=8080
 NODE_ENV=production

 Deploy:
 cd server
 railway login
 railway init
 railway up

 Render Deployment

 Create server/render.yaml:
 services:
   - type: web
     name: ws-proxy
     env: node
     buildCommand: npm install
     startCommand: node ws-proxy.js
     envVars:
       - key: JWT_SECRET
         generateValue: true
       - key: AUTH_ENABLED
         value: true
       - key: NODE_ENV
         value: production

 Health Check Endpoint

 Add to ws-proxy.js:
 // Health check for load balancers
 server.on('request', (req, res) => {
   if (req.url === '/health') {
     res.writeHead(200);
     res.end('OK');
   }
 });