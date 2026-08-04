"""The ``crysviz`` command-line launcher."""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from typing import Sequence

from . import __version__
from ._server import CrysVizServer
from ._sources import prepare_sources
from ._windowing import create_native_window


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="crysviz", description="View crystal structures in CrysViz")
    parser.add_argument("--version", action="version", version=f"crysviz {__version__}")
    parser.add_argument("--browser", action="store_true", help="open in the system browser")
    parser.add_argument("--no-open", action="store_true", help="serve without opening a browser")
    parser.add_argument("--port", type=_port, default=0, metavar="PORT", help="loopback port (default: 0)")
    parser.add_argument("--gui", choices=("gtk", "qt", "cef"), help="pywebview GUI backend")
    parser.add_argument("--debug", action="store_true", help="enable launcher diagnostics")
    parser.add_argument("files", nargs="*", metavar="FILE")
    return parser


def _port(value: str) -> int:
    try:
        port = int(value, 10)
    except ValueError:
        raise argparse.ArgumentTypeError("PORT must be an integer from 0 through 65535") from None
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("PORT must be an integer from 0 through 65535")
    return port


def _parser_error(parser: argparse.ArgumentParser, message: str) -> int:
    parser.error(message)
    return 2


def _run_browser(server: CrysVizServer, no_open: bool) -> int:
    print(server.url, flush=True)
    if not no_open:
        import webbrowser

        webbrowser.open(server.url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        return 0


def _run_pywebview(server: CrysVizServer, gui: str | None, debug: bool) -> int:
    try:
        import webview
    except Exception as error:
        raise RuntimeError(
            "pywebview could not be imported. Install a documented backend extra "
            "(`pip install 'crysviz[gtk]'` or `crysviz[qt]`) or use --browser."
        ) from error
    try:
        create_native_window(webview, server.url)
        # The frontend persists UI state in localStorage. Some pywebview
        # renderers do not expose Web Storage at all in the default private
        # data store, so use the persistent store for native windows.
        kwargs = {"debug": debug, "private_mode": False}
        if gui is not None:
            kwargs["gui"] = gui
        webview.start(**kwargs)
    except Exception as error:
        raise RuntimeError(
            "pywebview could not start its GUI backend. On Linux install the documented "
            "GTK or Qt system/backend extra, or use --browser."
        ) from error
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.no_open and not args.browser:
        return _parser_error(parser, "--no-open is valid only with --browser")
    if args.gui is not None and args.browser:
        return _parser_error(parser, "--gui is invalid with --browser")
    try:
        sources = prepare_sources(args.files)
    except (TypeError, ValueError) as error:
        parser.error(str(error))
    server = CrysVizServer(sources, port=args.port, debug=args.debug)
    try:
        server.start()
        if args.browser:
            return _run_browser(server, args.no_open)
        return _run_pywebview(server, args.gui, args.debug)
    except KeyboardInterrupt:
        return 0
    except OSError as error:
        print(f"crysviz: could not start loopback server on port {args.port}: {error}", file=sys.stderr)
        if args.debug:
            traceback.print_exc()
        return 1
    except RuntimeError as error:
        print(f"crysviz: {error}", file=sys.stderr)
        return 1
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
