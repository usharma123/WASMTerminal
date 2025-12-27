FROM linux-wasm-base:dev

WORKDIR /linux-wasm

COPY patches patches
COPY linux-wasm.sh linux-wasm.sh

ENTRYPOINT ["/linux-wasm/linux-wasm.sh", "all"]
