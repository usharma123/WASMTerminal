# WASMTerminal

A WebAssembly-based Linux terminal running in the browser, built on top of [linux-wasm](https://github.com/joelseverin/linux-wasm).

## License

This project is based on [joelseverin/linux-wasm](https://github.com/joelseverin/linux-wasm), which is licensed under **GPL-2.0-only**.

### License Attribution

- **Original linux-wasm code**: GPL-2.0-only (see `linux-wasm/LICENSE`)
- **Additional modifications to linux-wasm files**: GPL-2.0-only (inherited from original)
- **New server components** (`server/` directory): MIT License
- **New browser runtime components** (`site/fs-persist.js`, `site/net-proxy.js`): MIT License
- **Documentation and configuration files**: See individual file headers

All GPL-2.0 licensed code maintains compliance with the original license terms. New MIT-licensed components are separate modules that interface with the GPL-2.0 codebase.

## Overview

This project extends the original linux-wasm with:

1. **Persistent filesystem** - IndexedDB-backed storage for user files
2. **WebSocket networking proxy** - Secure TCP networking via WebSocket
3. **Package management system** - On-demand download and installation of Wasm binaries
4. **Enhanced runtime** - Improved terminal UI and user experience
5. **Production-ready server** - Secure WebSocket proxy server with authentication

## Additional Features

### Filesystem Persistence

- **File**: `site/fs-persist.js` (MIT License)
- Provides IndexedDB-backed persistent storage for `/home`, `/root`, and `/opt` directories
- Automatically saves and restores files across browser sessions
- Integrated into the Linux/Wasm runtime

### WebSocket Networking Proxy

- **Server**: `server/ws-proxy.js` (MIT License)
- **Client**: `site/net-proxy.js` (MIT License)
- Secure WebSocket-to-TCP proxy with:
  - JWT authentication
  - IP address filtering (blocks private/internal ranges)
  - Rate limiting (connections, bandwidth)
  - DNS rebinding protection
  - Port allowlist (80, 443 by default)
- Production-ready with Railway deployment configuration

### Package Management System

- **Package Helper**: `linux-wasm/patches/initramfs/pkghelper.c` (GPL-2.0-only)
- **Build Script**: `linux-wasm/tools/build-pkghelper.sh`
- **Browser Components**: `site/pkg-registry.js`, `site/pkg-download.js`
- On-demand download of large Wasm binaries (e.g., Node.js ~50MB)
- Progress reporting with terminal progress bars
- Automatic restoration from IndexedDB on boot
- Package registry system for managing available packages

### Enhanced Runtime Files

Modified files in `site/` directory (based on `linux-wasm/runtime/`):

- **`index.html`**: Enhanced UI with loading states and better error handling
- **`linux.js`**: Added package system integration, filesystem persistence hooks
- **`linux-worker.js`**: Added `wasm_pkg_*` syscalls, enhanced networking support
- **`server.py`**: Added CORS headers for cross-origin isolation
- **`_headers`**: Cloudflare Pages headers for SharedArrayBuffer support

### Additional Initramfs Components

New binaries in `linux-wasm/patches/initramfs/`:

- **`pkghelper`**: Package management helper binary (GPL-2.0-only)
- **`qjs`**: QuickJS JavaScript runtime (~1MB)
- **`sqlite3`**: SQLite database
- **`jq`**: JSON processor

Build scripts in `linux-wasm/tools/`:
- `build-pkghelper.sh`
- `build-quickjs.sh`
- `build-sqlite.sh`
- `build-jq.sh`
- `build-lwtcp.sh` (enhanced)

### Server Infrastructure

- **`server/`** directory: Node.js WebSocket proxy server
  - `ws-proxy.js`: Main proxy server (MIT License)
  - `package.json`: Dependencies (ws, jsonwebtoken)
  - `railway.json`: Railway deployment configuration

## Directory Structure

```
WASMTerminal/
├── linux-wasm/              # Original linux-wasm repository (GPL-2.0-only)
│   ├── patches/
│   │   └── initramfs/
│   │       ├── pkghelper.c   # NEW: Package helper (GPL-2.0-only)
│   │       ├── qjs           # NEW: QuickJS runtime
│   │       ├── sqlite3       # NEW: SQLite database
│   │       └── ...
│   ├── runtime/              # Original runtime files
│   └── tools/
│       ├── build-pkghelper.sh  # NEW: Build script for pkghelper
│       ├── build-quickjs.sh    # NEW: Build script for QuickJS
│       ├── build-sqlite.sh     # NEW: Build script for SQLite
│       └── ...
├── server/                   # NEW: WebSocket proxy server (MIT License)
│   ├── ws-proxy.js
│   ├── package.json
│   └── railway.json
├── site/                     # Enhanced runtime files
│   ├── index.html            # Modified: Enhanced UI
│   ├── linux.js              # Modified: Added package/fs/net support
│   ├── linux-worker.js       # Modified: Added syscalls
│   ├── fs-persist.js         # NEW: IndexedDB persistence (MIT License)
│   ├── net-proxy.js          # NEW: WebSocket proxy client (MIT License)
│   ├── pkg-registry.js       # NEW: Package registry
│   ├── pkg-download.js       # NEW: Package download manager
│   ├── server.py             # Modified: Added CORS headers
│   └── _headers              # NEW: Cloudflare Pages headers
└── plan.md                   # Development plan document
```

## Building

Follow the original linux-wasm build instructions, then build additional components:

```bash
# Build original linux-wasm components
cd linux-wasm
./linux-wasm.sh all

# Build additional components
./tools/build-pkghelper.sh
./tools/build-quickjs.sh
./tools/build-sqlite.sh
./tools/build-jq.sh
```

## Running

### Local Development

1. **Start the WebSocket proxy server** (optional, for networking):
   ```bash
   cd server
   npm install
   npm start
   ```

2. **Serve the site directory**:
   ```bash
   cd site
   python3 server.py
   ```

3. Open `http://localhost:8000` in your browser

### Production Deployment

- **Site**: Deploy `site/` directory to Cloudflare Pages or similar
- **Server**: Deploy `server/` to Railway or similar platform
- Configure environment variables:
  - `JWT_SECRET`: Secure random string for JWT authentication
  - `PORT`: Server port (default: 8080)
  - `AUTH_ENABLED`: Set to `false` for development (default: `true`)

## Usage

### Package Management

```bash
# Install a package (downloads from CDN with progress)
lwpkg install nodejs

# Check if package is cached
pkghelper check nodejs

# List cached packages
pkghelper list

# Restore package from cache
pkghelper restore nodejs /opt/nodejs
```

### Networking

Networking is automatically configured if the WebSocket proxy server is running. The browser client connects to the proxy server specified in `site/net-proxy.js`.

### Filesystem Persistence

Files in `/home`, `/root`, and `/opt` are automatically persisted to IndexedDB. They are restored on the next browser session.

## Changes from Original linux-wasm

### Modified Files (GPL-2.0-only)

All modifications maintain GPL-2.0-only license:

- `linux-wasm/patches/initramfs/init` - Added package restoration on boot
- `linux-wasm/patches/initramfs/bin/lwpkg` - Enhanced for large package downloads
- `site/linux.js` - Added package system, filesystem persistence, networking
- `site/linux-worker.js` - Added `wasm_pkg_*` syscalls, enhanced syscall handling
- `site/index.html` - Enhanced UI and error handling
- `site/server.py` - Added CORS headers

### New Files

**GPL-2.0-only:**
- `linux-wasm/patches/initramfs/pkghelper.c` - Package helper binary
- `linux-wasm/tools/build-pkghelper.sh` - Build script
- `linux-wasm/tools/build-quickjs.sh` - QuickJS build script
- `linux-wasm/tools/build-sqlite.sh` - SQLite build script
- `linux-wasm/tools/build-jq.sh` - jq build script

**MIT License:**
- `server/ws-proxy.js` - WebSocket proxy server
- `site/fs-persist.js` - IndexedDB persistence layer
- `site/net-proxy.js` - WebSocket proxy client

**Configuration/Documentation:**
- `server/package.json` - Node.js dependencies
- `server/railway.json` - Railway deployment config
- `site/_headers` - Cloudflare Pages headers
- `site/pkg-registry.js` - Package registry (no license header, configuration file)
- `site/pkg-download.js` - Package download manager (no license header, configuration file)
- `plan.md` - Development plan

## License Compliance

This project maintains GPL-2.0 compliance for all code derived from linux-wasm:

1. **Original linux-wasm code**: All files in `linux-wasm/` maintain GPL-2.0-only license
2. **Modifications**: All modifications to linux-wasm files inherit GPL-2.0-only
3. **New GPL-2.0 code**: New files that interface with kernel/userland are GPL-2.0-only
4. **Separate modules**: New MIT-licensed components (`server/`, `site/fs-persist.js`, `site/net-proxy.js`) are separate modules that interface with but do not modify GPL-2.0 code

## Acknowledgments

- Original linux-wasm project: [joelseverin/linux-wasm](https://github.com/joelseverin/linux-wasm)
- Linux kernel: GPL-2.0-only
- musl libc: MIT License
- BusyBox: GPL-2.0-only
- QuickJS: MIT License
- SQLite: Public Domain

## Contributing

When contributing, please ensure:

1. GPL-2.0-only code remains GPL-2.0-only
2. New features that don't require GPL can use MIT License
3. All license headers are properly maintained
4. Changes are documented in this README
