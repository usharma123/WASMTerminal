#!/bin/bash
# Build pkghelper for Linux/Wasm
#
# This script compiles pkghelper.c into a Wasm binary that provides
# access to browser-side package download and caching functionality.

set -e

# macOS-compatible realpath
_realpath() {
    local path="$1"
    if [[ -d "$path" ]]; then
        (cd "$path" && pwd)
    elif [[ -f "$path" ]]; then
        echo "$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"
    else
        local dir=$(dirname "$path")
        if [[ -d "$dir" ]]; then
            echo "$(cd "$dir" && pwd)/$(basename "$path")"
        elif [[ "$path" = /* ]]; then
            echo "$path"
        else
            echo "$(pwd)/$path"
        fi
    fi
}

LW_ROOT="$(_realpath "$(dirname "$0")/..")"

# Default paths (can be overridden)
: "${LW_INSTALL:=$LW_ROOT/workspace/install}"
LW_INSTALL="$(_realpath "$LW_INSTALL")"

CLANG="$LW_INSTALL/llvm/bin/clang"
SYSROOT="$LW_INSTALL/musl"

SRC="$LW_ROOT/patches/initramfs/pkghelper.c"
OUT="$LW_ROOT/patches/initramfs/pkghelper"

if [ ! -f "$CLANG" ]; then
    echo "Error: LLVM not found at $CLANG"
    echo "Please build LLVM first: ./linux-wasm.sh build-llvm"
    exit 1
fi

if [ ! -d "$SYSROOT" ]; then
    echo "Error: musl sysroot not found at $SYSROOT"
    echo "Please build musl first: ./linux-wasm.sh build-musl"
    exit 1
fi

echo "Building pkghelper..."
echo "  Source: $SRC"
echo "  Output: $OUT"

# Use wasm-ld flags that match how BusyBox is linked
# These flags create a proper dynamic Wasm executable for Linux/Wasm
"$CLANG" \
    --target=wasm32-unknown-unknown \
    -Xclang -target-feature -Xclang +atomics \
    -Xclang -target-feature -Xclang +bulk-memory \
    -fPIC \
    --sysroot="$SYSROOT" \
    -D__linux__ \
    -isystem "$LW_INSTALL/busybox-kernel-headers" \
    -Wl,--export-all \
    -Wl,--import-table \
    -Wl,--import-memory \
    -Wl,--shared-memory \
    -Wl,--max-memory=4294967296 \
    -Wl,--no-merge-data-segments \
    -Wl,-no-gc-sections \
    -Wl,--import-undefined \
    -Wl,-shared \
    -o "$OUT" \
    "$SRC"

if [ -f "$OUT" ]; then
    echo "Successfully built: $OUT"
    ls -la "$OUT"
else
    echo "Build failed!"
    exit 1
fi
