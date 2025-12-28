# WASMTerminal Development Plan

## Current Focus: Configure Cloudflare R2

### Remaining Setup

1. Create Cloudflare R2 bucket
2. Configure CORS for browser access
3. Upload Node.js Wasm binary (~50MB)
4. Update `site/pkg-registry.js` with actual URL

---

## Completed: On-Demand Package System

### What's Built

Full infrastructure for downloading large Wasm binaries (like Node.js ~50MB):

**Browser-side (JavaScript):**
- `site/pkg-registry.js` - Package definitions and URLs
- `site/pkg-download.js` - Download manager with streaming progress
- `site/linux.js` - Added pkg_* message handlers
- `site/linux-worker.js` - Added wasm_pkg_* syscalls

**Kernel-side (C/Shell):**
- `linux-wasm/patches/initramfs/pkghelper.c` - C helper binary
- `linux-wasm/patches/initramfs/bin/lwpkg` - Updated for large packages
- `linux-wasm/patches/initramfs/init` - Boot-time auto-restore

**Build system:**
- `linux-wasm/tools/build-pkghelper.sh` - Build script
- `linux-wasm/linux-wasm.sh` - Added pkghelper to build

### Usage (after R2 setup)
```bash
lwpkg install nodejs    # Downloads from CDN with progress bar
node --version          # Works immediately
# After browser refresh, auto-restores from IndexedDB
```

---

## Paused: Memory Isolation

Infrastructure is built but disabled. Each process has its own Wasm instance (execution isolation), but they share kernel memory (no memory isolation).

**Status:** Paused - current partial isolation is sufficient for most use cases.

**To enable full isolation:** Would need argv/envp pointer translation when copying stack from kernel to user memory.

---

## Completed Features

- [x] Per-process Wasm instances (execution isolation)
- [x] CLONE_VM detection for thread memory sharing
- [x] Syscall pointer translation infrastructure (25+ syscalls)
- [x] IndexedDB filesystem persistence
- [x] WebSocket networking proxy
- [x] Basic package manager (lwpkg)
- [x] On-demand package download system (browser-side)
- [x] Terminal progress bar for downloads
- [x] Boot-time package restoration from IndexedDB
- [x] QuickJS JavaScript runtime (qjs) - ~1MB
