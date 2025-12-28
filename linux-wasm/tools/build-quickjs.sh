#!/bin/bash
# Build QuickJS JavaScript runtime for Linux/Wasm
#
# This script downloads and compiles QuickJS into a Wasm binary
# that can run inside the Linux/Wasm environment.

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

QUICKJS_VERSION="2024-01-13"
QUICKJS_URL="https://bellard.org/quickjs/quickjs-${QUICKJS_VERSION}.tar.xz"
QUICKJS_DIR="$LW_SRC/quickjs-${QUICKJS_VERSION}"
OUT="$LW_ROOT/patches/initramfs/qjs"

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

# Download QuickJS if not present
if [ ! -d "$QUICKJS_DIR" ]; then
    echo "Downloading QuickJS ${QUICKJS_VERSION}..."
    mkdir -p "$LW_SRC"
    # Use wget if curl not available
    if command -v curl >/dev/null 2>&1; then
        curl -L "$QUICKJS_URL" -o "$LW_SRC/quickjs.tar.xz"
    else
        wget -O "$LW_SRC/quickjs.tar.xz" "$QUICKJS_URL"
    fi
    tar xJf "$LW_SRC/quickjs.tar.xz" -C "$LW_SRC"
    rm -f "$LW_SRC/quickjs.tar.xz"
fi

echo "Building QuickJS for Linux/Wasm..."
echo "  Source: $QUICKJS_DIR"
echo "  Output: $OUT"

cd "$QUICKJS_DIR"

# Build QuickJS in single step (like SQLite) to avoid GOT.mem issues
"$CLANG" \
    --target=wasm32-unknown-unknown \
    -Xclang -target-feature -Xclang +atomics \
    -Xclang -target-feature -Xclang +bulk-memory \
    -fPIC \
    --sysroot="$SYSROOT" \
    -D__linux__ \
    -D_GNU_SOURCE \
    -DCONFIG_VERSION=\"${QUICKJS_VERSION}\" \
    -DCONFIG_BIGNUM \
    -DFE_DOWNWARD=0x400 \
    -DFE_UPWARD=0x800 \
    -DFE_TONEAREST=0 \
    -isystem "$LW_INSTALL/busybox-kernel-headers" \
    -O2 \
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
    quickjs.c \
    libregexp.c \
    libunicode.c \
    cutils.c \
    quickjs-libc.c \
    qjs.c \
    -lm

if [ -f "$OUT" ]; then
    echo ""
    echo "Successfully built QuickJS: $OUT"
    ls -la "$OUT"
    echo ""
    echo "To include in initramfs, run: ./linux-wasm.sh build-initramfs"
else
    echo "Build failed!"
    exit 1
fi
