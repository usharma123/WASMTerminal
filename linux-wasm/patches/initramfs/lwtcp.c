// SPDX-License-Identifier: GPL-2.0-only
/*
 * lwtcp - Lightweight TCP client for Linux/Wasm
 *
 * Usage: lwtcp <host> <port>
 *
 * Opens a TCP connection through /dev/lwnet and pipes stdin/stdout.
 * Example: echo -e "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n" | lwtcp example.com 80
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <errno.h>

/* ioctl commands - must match kernel driver */
#define LWNET_IOC_MAGIC 'N'
#define LWNET_OPEN    _IOWR(LWNET_IOC_MAGIC, 1, struct lwnet_open_args)
#define LWNET_CLOSE   _IOW(LWNET_IOC_MAGIC, 2, int)
#define LWNET_POLL    _IOR(LWNET_IOC_MAGIC, 4, int)

struct lwnet_open_args {
    char host[256];
    int port;
    int conn_id;
};

/* Poll status values */
#define POLL_NO_DATA    0
#define POLL_HAS_DATA   1
#define POLL_CLOSED     2
#define POLL_ERROR      3

static void usage(const char *prog)
{
    fprintf(stderr, "Usage: %s <host> <port>\n", prog);
    fprintf(stderr, "\nOpens a TCP connection and pipes stdin to socket, socket to stdout.\n");
    fprintf(stderr, "\nExample:\n");
    fprintf(stderr, "  echo -e \"GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n\" | %s example.com 80\n", prog);
    exit(1);
}

int main(int argc, char *argv[])
{
    int fd, ret;
    struct lwnet_open_args args;
    char buf[4096];
    ssize_t n;
    int poll_status;
    int stdin_done = 0;
    int socket_done = 0;

    if (argc != 3) {
        usage(argv[0]);
    }

    /* Parse arguments */
    strncpy(args.host, argv[1], sizeof(args.host) - 1);
    args.host[sizeof(args.host) - 1] = '\0';
    args.port = atoi(argv[2]);

    if (args.port <= 0 || args.port > 65535) {
        fprintf(stderr, "Invalid port: %s\n", argv[2]);
        return 1;
    }

    /* Open the device */
    fd = open("/dev/lwnet", O_RDWR);
    if (fd < 0) {
        perror("open /dev/lwnet");
        fprintf(stderr, "Make sure the NET_WASM driver is loaded.\n");
        return 1;
    }

    /* Open connection */
    ret = ioctl(fd, LWNET_OPEN, &args);
    if (ret < 0) {
        perror("ioctl LWNET_OPEN");
        close(fd);
        return 1;
    }

    fprintf(stderr, "[lwtcp] Connected to %s:%d (conn_id=%d)\n",
            args.host, args.port, args.conn_id);

    /* Set stdin to non-blocking */
    int stdin_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, stdin_flags | O_NONBLOCK);

    /* Main loop: read from stdin and write to socket, read from socket and write to stdout */
    while (!socket_done) {
        /* Check if we have data from the socket */
        ret = ioctl(fd, LWNET_POLL, &poll_status);
        if (ret < 0) {
            perror("ioctl LWNET_POLL");
            break;
        }

        if (poll_status == POLL_HAS_DATA) {
            /* Read from socket */
            n = read(fd, buf, sizeof(buf));
            if (n > 0) {
                /* Write to stdout */
                if (write(STDOUT_FILENO, buf, n) < 0) {
                    perror("write stdout");
                    break;
                }
            } else if (n < 0 && errno != EAGAIN) {
                perror("read socket");
                break;
            }
        } else if (poll_status == POLL_CLOSED) {
            socket_done = 1;
            break;
        } else if (poll_status == POLL_ERROR) {
            fprintf(stderr, "[lwtcp] Socket error\n");
            break;
        }

        /* Read from stdin and write to socket */
        if (!stdin_done) {
            n = read(STDIN_FILENO, buf, sizeof(buf));
            if (n > 0) {
                /* Write to socket */
                ssize_t written = write(fd, buf, n);
                if (written < 0) {
                    perror("write socket");
                    break;
                }
            } else if (n == 0) {
                /* EOF on stdin */
                stdin_done = 1;
            } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
                perror("read stdin");
                break;
            }
        }

        /* Small delay to prevent busy loop */
        usleep(1000);
    }

    /* Close connection */
    ret = ioctl(fd, LWNET_CLOSE, &args.conn_id);
    if (ret < 0) {
        perror("ioctl LWNET_CLOSE");
    }

    close(fd);

    fprintf(stderr, "[lwtcp] Connection closed\n");
    return 0;
}
