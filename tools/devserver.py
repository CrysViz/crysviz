#!/usr/bin/env python3
"""Static file server for docs/ that never lets the browser cache.

`python3 -m http.server` sends no Cache-Control, so Firefox caches
heuristically: after editing a module you can get the PREVIOUS version back,
which shows up as nonsense like

    SyntaxError: The requested module '.../SymmetryEditModule.js'
    doesn't provide an export named: 'DEFAULT_SYMPREC'

for an export that is plainly there. Serving no-store removes the whole class
of problem. Used by `make serve` and tools/browsertest/run.sh.

    python3 tools/devserver.py [port] [--directory DIR] [--bind HOST]
"""

import argparse
import functools
import http.server
import socketserver


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):  # quiet: one line per module is noise
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('port', nargs='?', type=int, default=8000)
    parser.add_argument('--directory', default='docs')
    # Loopback by default: 0.0.0.0 would publish the working tree to the whole
    # LAN. Pass --bind 0.0.0.0 deliberately if that is what you want.
    parser.add_argument('--bind', default='127.0.0.1')
    args = parser.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(NoCacheHandler, directory=args.directory)
    with socketserver.TCPServer((args.bind, args.port), handler) as httpd:
        httpd.serve_forever()


if __name__ == '__main__':
    main()
