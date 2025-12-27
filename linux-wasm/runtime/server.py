#!/usr/bin/env python3

# This is just a simple web server intended for development purposes on the local machine.
#
# Usage:
# Place vmlinux.wasm and initramfs.cpio.gz into this directory.
# Run this script from this directory: python3 server.py
# Navigate to: http://127.0.0.1:8000/
#
# As of 2025, Chromium and Edge (same thing really) have the best debugging capabilities for Wasm. Firefox is
# unfortunately lagging behind a bit. Keep in mind that these tools were not really built to debug an entire operating
# system and can be quite demanding on system resources. Things will hopefully improve as they get used by more people.

from http.server import HTTPServer, SimpleHTTPRequestHandler, test
import sys

class Server(SimpleHTTPRequestHandler):
  def end_headers(self):
    self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
    self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
    self.send_header('Cache-Control:', 'no-store')
    SimpleHTTPRequestHandler.end_headers(self)

if __name__ == '__main__':
    test(Server, HTTPServer, port=int(sys.argv[1]) if len(sys.argv) > 1 else 8000)
