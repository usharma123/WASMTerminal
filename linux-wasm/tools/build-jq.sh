#!/bin/bash
# Build jq for Linux/Wasm
#
# This script downloads and compiles jq (with oniguruma regex library)
# into a Wasm binary that can run inside the Linux/Wasm environment.

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

: "${LW_BUILD:=$LW_ROOT/workspace/build}"
LW_BUILD="$(_realpath "$LW_BUILD")"

CLANG="$LW_INSTALL/llvm/bin/clang"
AR="$LW_INSTALL/llvm/bin/llvm-ar"
SYSROOT="$LW_INSTALL/musl"

# Versions
ONIG_VERSION="6.9.9"
JQ_VERSION="1.7.1"

ONIG_DIR="$LW_SRC/onig-${ONIG_VERSION}"
JQ_DIR="$LW_SRC/jq-${JQ_VERSION}"

OUT="$LW_ROOT/patches/initramfs/jq"

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

# Ensure wget is available
if ! command -v wget &> /dev/null; then
    echo "Installing wget..."
    apt-get update -qq && apt-get install -y -qq wget
fi

# Download oniguruma if not present
if [ ! -d "$ONIG_DIR" ]; then
    echo "Downloading oniguruma ${ONIG_VERSION}..."
    mkdir -p "$LW_SRC"
    cd "$LW_SRC"
    wget -q "https://github.com/kkos/oniguruma/releases/download/v${ONIG_VERSION}/onig-${ONIG_VERSION}.tar.gz"
    tar xzf "onig-${ONIG_VERSION}.tar.gz"
    rm "onig-${ONIG_VERSION}.tar.gz"
fi

# Download jq if not present
if [ ! -d "$JQ_DIR" ]; then
    echo "Downloading jq ${JQ_VERSION}..."
    mkdir -p "$LW_SRC"
    cd "$LW_SRC"
    wget -q "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-${JQ_VERSION}.tar.gz"
    tar xzf "jq-${JQ_VERSION}.tar.gz"
    rm "jq-${JQ_VERSION}.tar.gz"
fi

# Common compiler flags
CFLAGS="--target=wasm32-unknown-unknown"
CFLAGS+=" -Xclang -target-feature -Xclang +atomics"
CFLAGS+=" -Xclang -target-feature -Xclang +bulk-memory"
CFLAGS+=" -fPIC"
CFLAGS+=" --sysroot=$SYSROOT"
CFLAGS+=" -D__linux__"
CFLAGS+=" -isystem $LW_INSTALL/busybox-kernel-headers"
CFLAGS+=" -Os"

LDFLAGS="-Wl,--export-all"
LDFLAGS+=" -Wl,--import-table"
LDFLAGS+=" -Wl,--import-memory"
LDFLAGS+=" -Wl,--shared-memory"
LDFLAGS+=" -Wl,--max-memory=4294967296"
LDFLAGS+=" -Wl,--no-merge-data-segments"
LDFLAGS+=" -Wl,-no-gc-sections"
LDFLAGS+=" -Wl,--import-undefined"
LDFLAGS+=" -Wl,-shared"

# Build oniguruma as static library
echo "Building oniguruma..."
mkdir -p "$LW_BUILD/oniguruma"
cd "$LW_BUILD/oniguruma"

# Compile oniguruma source files
ONIG_SRCS="regcomp.c regexec.c regparse.c regsyntax.c regtrav.c regversion.c st.c regerror.c regenc.c unicode.c ascii.c utf8.c unicode_unfold_key.c unicode_fold1_key.c unicode_fold2_key.c unicode_fold3_key.c"

for src in $ONIG_SRCS; do
    if [ -f "$ONIG_DIR/src/$src" ]; then
        echo "  Compiling $src..."
        "$CLANG" $CFLAGS -I"$ONIG_DIR/src" -c "$ONIG_DIR/src/$src" -o "${src%.c}.o"
    fi
done

# Also compile encoding files
for enc in "$ONIG_DIR/src/"enc/*.c; do
    if [ -f "$enc" ]; then
        name=$(basename "$enc" .c)
        echo "  Compiling enc/$name.c..."
        "$CLANG" $CFLAGS -I"$ONIG_DIR/src" -c "$enc" -o "enc_${name}.o"
    fi
done

# Create static library
echo "Creating libonig.a..."
"$AR" rcs libonig.a *.o

# Build jq
echo "Building jq..."
mkdir -p "$LW_BUILD/jq"
cd "$LW_BUILD/jq"

# jq source files (main ones needed)
JQ_SRCS="bytecode.c compile.c execute.c builtin.c jv.c jv_parse.c jv_print.c jv_aux.c jv_dtoa.c jv_unicode.c jv_file.c lexer.c parser.c locfile.c linker.c"

for src in $JQ_SRCS; do
    if [ -f "$JQ_DIR/src/$src" ]; then
        echo "  Compiling $src..."
        "$CLANG" $CFLAGS \
            -I"$JQ_DIR/src" \
            -I"$ONIG_DIR/src" \
            -DHAVE_ONIGURUMA \
            -DHAVE_DECL_ISNAN=1 \
            -DHAVE_DECL_ISINF=1 \
            -c "$JQ_DIR/src/$src" -o "${src%.c}.o" 2>/dev/null || echo "    Warning: $src failed"
    fi
done

# Compile main
if [ -f "$JQ_DIR/src/main.c" ]; then
    echo "  Compiling main.c..."
    "$CLANG" $CFLAGS \
        -I"$JQ_DIR/src" \
        -I"$ONIG_DIR/src" \
        -DHAVE_ONIGURUMA \
        -DHAVE_DECL_ISNAN=1 \
        -DHAVE_DECL_ISINF=1 \
        -c "$JQ_DIR/src/main.c" -o main.o 2>/dev/null || echo "    Warning: main.c failed"
fi

# Link everything
echo "Linking jq..."
"$CLANG" --target=wasm32-unknown-unknown \
    --sysroot="$SYSROOT" \
    $LDFLAGS \
    -o "$OUT" \
    *.o \
    "$LW_BUILD/oniguruma/libonig.a" 2>&1 || {
        echo "Linking failed. Trying without oniguruma..."
        # Try building a simpler version without regex
        "$CLANG" --target=wasm32-unknown-unknown \
            --sysroot="$SYSROOT" \
            $LDFLAGS \
            -o "$OUT" \
            bytecode.o compile.o execute.o builtin.o jv.o jv_parse.o jv_print.o jv_aux.o jv_dtoa.o jv_unicode.o main.o 2>&1 || {
                echo "Build failed!"
                exit 1
            }
    }

if [ -f "$OUT" ]; then
    echo "Successfully built: $OUT"
    ls -la "$OUT"
else
    echo "Build failed!"
    exit 1
fi
