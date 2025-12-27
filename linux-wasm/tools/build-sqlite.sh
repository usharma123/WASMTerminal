#!/bin/bash
# Build SQLite for Linux/Wasm
#
# This script downloads and compiles SQLite into a Wasm binary that can run
# inside the Linux/Wasm environment.

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

: "${LW_SRC:=$LW_ROOT/workspace/src}"
LW_SRC="$(_realpath "$LW_SRC")"

CLANG="$LW_INSTALL/llvm/bin/clang"
SYSROOT="$LW_INSTALL/musl"

SQLITE_VERSION="3440200"
SQLITE_URL="https://www.sqlite.org/2023/sqlite-amalgamation-${SQLITE_VERSION}.zip"
SQLITE_DIR="$LW_SRC/sqlite-amalgamation-${SQLITE_VERSION}"

OUT="$LW_ROOT/patches/initramfs/sqlite3"

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

# Download SQLite if not present
if [ ! -d "$SQLITE_DIR" ]; then
    echo "Downloading SQLite..."
    mkdir -p "$LW_SRC"
    cd "$LW_SRC"
    # Try curl first, fall back to wget
    if command -v curl &> /dev/null; then
        curl -L -o sqlite.zip "$SQLITE_URL"
    elif command -v wget &> /dev/null; then
        wget -O sqlite.zip "$SQLITE_URL"
    else
        echo "Error: Neither curl nor wget found. Installing wget..."
        apt-get update && apt-get install -y wget
        wget -O sqlite.zip "$SQLITE_URL"
    fi
    unzip -q sqlite.zip
    rm sqlite.zip
fi

echo "Building SQLite..."
echo "  Source: $SQLITE_DIR"
echo "  Output: $OUT"

# Build SQLite with optimizations for size and Wasm compatibility
# Using same linker flags as BusyBox for proper dylink format
"$CLANG" \
    --target=wasm32-unknown-unknown \
    -Xclang -target-feature -Xclang +atomics \
    -Xclang -target-feature -Xclang +bulk-memory \
    -fPIC \
    --sysroot="$SYSROOT" \
    -D__linux__ \
    -isystem "$LW_INSTALL/busybox-kernel-headers" \
    -Os \
    -DSQLITE_THREADSAFE=0 \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_OMIT_DEPRECATED \
    -DSQLITE_OMIT_PROGRESS_CALLBACK \
    -DSQLITE_OMIT_SHARED_CACHE \
    -DSQLITE_OMIT_AUTOINIT \
    -DSQLITE_DQS=0 \
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
    "$SQLITE_DIR/sqlite3.c" \
    "$SQLITE_DIR/shell.c"

if [ -f "$OUT" ]; then
    echo "Successfully built: $OUT"
    ls -la "$OUT"
else
    echo "Build failed!"
    exit 1
fi
