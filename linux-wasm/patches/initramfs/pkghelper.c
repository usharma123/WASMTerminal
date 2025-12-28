// SPDX-License-Identifier: GPL-2.0-only
/*
 * pkghelper - Package helper for Linux/Wasm
 *
 * Provides access to browser-side package download and caching.
 * Uses host-provided wasm_pkg_* functions for IndexedDB access.
 *
 * Usage:
 *   pkghelper check <pkg>              - Check if package is cached (exit 0 if cached)
 *   pkghelper install <pkg>            - Install package (browser download with progress)
 *   pkghelper restore <pkg> <dest>     - Restore cached package to destination
 *   pkghelper list                     - List cached packages
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Import host functions from WASI namespace */
__attribute__((import_module("wasi_snapshot_preview1"), import_name("wasm_pkg_check")))
extern int wasm_pkg_check(const char *pkg_name);

__attribute__((import_module("wasi_snapshot_preview1"), import_name("wasm_pkg_install")))
extern int wasm_pkg_install(const char *pkg_name);

__attribute__((import_module("wasi_snapshot_preview1"), import_name("wasm_pkg_restore")))
extern int wasm_pkg_restore(const char *pkg_name, const char *dest_path);

__attribute__((import_module("wasi_snapshot_preview1"), import_name("wasm_pkg_list_cached")))
extern int wasm_pkg_list_cached(char *buffer, int buffer_size);

static void usage(const char *prog)
{
    fprintf(stderr, "Usage: %s <command> [args...]\n", prog);
    fprintf(stderr, "\nCommands:\n");
    fprintf(stderr, "  check <pkg>           Check if package is cached (exit 0 if cached)\n");
    fprintf(stderr, "  install <pkg>         Install package (downloads from CDN)\n");
    fprintf(stderr, "  restore <pkg> <dest>  Restore cached package to destination\n");
    fprintf(stderr, "  list                  List cached packages\n");
    exit(1);
}

static int cmd_check(const char *pkg)
{
    int result = wasm_pkg_check(pkg);
    if (result == 1) {
        printf("%s is cached\n", pkg);
        return 0;
    } else {
        printf("%s is not cached\n", pkg);
        return 1;
    }
}

static int cmd_install(const char *pkg)
{
    printf("Installing %s...\n", pkg);
    int result = wasm_pkg_install(pkg);
    if (result == 0) {
        printf("Successfully installed %s\n", pkg);
        return 0;
    } else if (result == 1) {
        printf("%s already installed (cached)\n", pkg);
        return 0;
    } else {
        fprintf(stderr, "Failed to install %s (error %d)\n", pkg, result);
        return 1;
    }
}

static int cmd_restore(const char *pkg, const char *dest)
{
    int result = wasm_pkg_restore(pkg, dest);
    if (result == 0) {
        printf("Restored %s to %s\n", pkg, dest);
        return 0;
    } else {
        fprintf(stderr, "Failed to restore %s (error %d)\n", pkg, result);
        return 1;
    }
}

static int cmd_list(void)
{
    char buffer[4096];
    int result = wasm_pkg_list_cached(buffer, sizeof(buffer));
    if (result >= 0) {
        if (buffer[0] == '\0') {
            printf("No cached packages\n");
        } else {
            printf("Cached packages:\n");
            /* Buffer contains newline-separated package names */
            char *line = strtok(buffer, "\n");
            while (line != NULL) {
                if (strlen(line) > 0) {
                    printf("  %s\n", line);
                }
                line = strtok(NULL, "\n");
            }
        }
        return 0;
    } else {
        fprintf(stderr, "Failed to list packages (error %d)\n", result);
        return 1;
    }
}

int main(int argc, char *argv[])
{
    if (argc < 2) {
        usage(argv[0]);
    }

    const char *cmd = argv[1];

    if (strcmp(cmd, "check") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: %s check <package>\n", argv[0]);
            return 1;
        }
        return cmd_check(argv[2]);
    } else if (strcmp(cmd, "install") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: %s install <package>\n", argv[0]);
            return 1;
        }
        return cmd_install(argv[2]);
    } else if (strcmp(cmd, "restore") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: %s restore <package> <destination>\n", argv[0]);
            return 1;
        }
        return cmd_restore(argv[2], argv[3]);
    } else if (strcmp(cmd, "list") == 0) {
        return cmd_list();
    } else {
        usage(argv[0]);
    }

    return 0;
}
