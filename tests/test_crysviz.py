from __future__ import annotations

import http.client
import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import tomllib
import unittest
from contextlib import redirect_stderr
from unittest import mock
from urllib.parse import urlsplit

import crysviz
from crysviz._sources import SPOOL_THRESHOLD, prepare_sources
from crysviz.cli import _run_pywebview, build_parser, main
from crysviz.server import CrysVizServer


class PayloadTests(unittest.TestCase):
    def test_import_surface_and_snapshot(self):
        self.assertEqual(crysviz.__version__, "0.1.0")
        self.assertIs(crysviz.ViewerEvent, crysviz._viewer.ViewerEvent)
        self.assertNotIn("webview", sys.modules)
        original = bytearray(b"input")
        payload = crysviz.Payload("sample.cif", original, "cif")
        original[0] = ord("X")
        self.assertEqual(payload.data, b"input")
        with self.assertRaises((AttributeError, TypeError)):
            payload.name = "other"  # type: ignore[misc]

    def test_validation(self):
        for args in [("", "x"), ("a/b", "x"), ("a", b"")]:
            with self.subTest(args=args):
                with self.assertRaises((TypeError, ValueError)):
                    crysviz.Payload(*args)
        with self.assertRaises(TypeError):
            crysviz.Payload("a", object())
        with self.assertRaises(ValueError):
            crysviz.Payload("a", "x", "")

    def test_source_order_and_binary_spooling(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            first = root / "first.cif"
            trajectory = root / "second.traj"
            first.write_text("first", encoding="utf-8")
            trajectory.write_bytes(b"traj")
            payload = crysviz.Payload("memory.cif", b"memory")
            sources = prepare_sources([first, payload, trajectory])
            try:
                self.assertEqual([source.name for source in sources], ["first.cif", "memory.cif", "second.traj"])
                self.assertFalse(sources[0].binary)
                self.assertFalse(sources[1].binary)
                self.assertTrue(sources[2].binary)
                self.assertEqual(sources[0].format, "cif")
                self.assertEqual(sources[1].format, "cif")
                self.assertEqual(sources[2].format, "traj")
                self.assertEqual(sources[1].open().read(), b"memory")
            finally:
                for source in sources:
                    source.close()

    def test_large_payload_rolls_to_disk_and_preserves_bytes(self):
        data = bytes(range(256)) * ((SPOOL_THRESHOLD // 256) + 2)
        sources = prepare_sources([crysviz.Payload("large.bin", data)])
        try:
            self.assertTrue(getattr(sources[0].spool, "_rolled", False))
            self.assertEqual(sources[0].open().read(), data)
        finally:
            sources[0].close()

    def test_payload_binary_flag_depends_on_format_not_transport_type(self):
        text_source = prepare_sources([crysviz.Payload("x.cif", b"CIF bytes")])[0]
        binary_source = prepare_sources([crysviz.Payload("x.traj", b"traj bytes")])[0]
        try:
            self.assertFalse(text_source.binary)
            self.assertTrue(binary_source.binary)
        finally:
            text_source.close()
            binary_source.close()

    def test_payload_format_canonicalization(self):
        self.assertEqual(crysviz.Payload("x", b"x", "TRAJ").format, "traj")
        self.assertEqual(crysviz.Payload("x", b"x", ".Traj").format, "traj")
        self.assertEqual(crysviz.Payload("x", b"x", ".CIF").format, "cif")
        for format_name in ("traj", ".traj", "TRAJ", ".Traj"):
            with self.subTest(format_name=format_name):
                source = prepare_sources([crysviz.Payload("x", b"x", format_name)])[0]
                try:
                    self.assertEqual(source.format, "traj")
                    self.assertTrue(source.binary)
                finally:
                    source.close()
        for invalid in ("..traj", ".", "traj ", "tra/j", ""):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    crysviz.Payload("x", b"x", invalid)

    def test_all_paths_validate_before_returning_any_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "valid.cif"
            path.write_text("valid", encoding="utf-8")
            with self.assertRaises(ValueError):
                prepare_sources([path, pathlib.Path(directory) / "missing.cif"])


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.sources = []
        self.server = None

    def tearDown(self):
        if self.server is not None:
            self.server.close()

    def start(self, sources=None):
        self.sources = prepare_sources(
            [crysviz.Payload("memory.cif", b"a\x00b")] if sources is None else sources
        )
        self.server = CrysVizServer(self.sources)
        self.server.start()
        return self.server

    def request(self, method, target, body=None, host=None, headers=None):
        split = urlsplit(self.server.url)
        connection = http.client.HTTPConnection(split.hostname, split.port, timeout=5)
        request_headers = {"Host": host or f"127.0.0.1:{split.port}"}
        if body is not None:
            request_headers.update({"Content-Type": "application/json", "Content-Length": str(len(body))})
        if headers:
            request_headers.update(headers)
        connection.request(method, target, body=body, headers=request_headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def raw_request(self, method, target, body=b"", extra_headers=(), *, include_default_length=True):
        split = urlsplit(self.server.url)
        request = (
            f"{method} {target} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{split.port}\r\n"
            + "".join(f"{key}: {value}\r\n" for key, value in extra_headers)
            + (f"Content-Length: {len(body)}\r\n" if include_default_length else "")
            + "Connection: keep-alive\r\n\r\n"
        ).encode("ascii") + body
        with socket.create_connection((split.hostname, split.port), timeout=2) as connection:
            connection.sendall(request)
            response = bytearray()
            while True:
                try:
                    block = connection.recv(65536)
                except socket.timeout:
                    self.fail("server did not close a rejected HTTP connection")
                if not block:
                    return bytes(response)
                response.extend(block)

    def raw_post_declared_length(self, target, declared_length, body, extra_headers=()):
        split = urlsplit(self.server.url)
        request = (
            f"POST {target} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{split.port}\r\n"
            "Content-Type: image/png\r\n"
            f"Content-Length: {declared_length}\r\n"
            + "".join(f"{key}: {value}\r\n" for key, value in extra_headers)
            + "Connection: close\r\n\r\n"
        ).encode("ascii") + body
        with socket.create_connection((split.hostname, split.port), timeout=2) as connection:
            connection.sendall(request)
            connection.shutdown(socket.SHUT_WR)
            response = bytearray()
            while block := connection.recv(65536):
                response.extend(block)
            return bytes(response)

    def raw_headers_then_disconnect(self, target):
        split = urlsplit(self.server.url)
        request = (
            f"GET {target} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{split.port}\r\n"
            "Connection: keep-alive\r\n\r\n"
        ).encode("ascii")
        connection = socket.create_connection((split.hostname, split.port), timeout=2)
        connection.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response:
            block = connection.recv(4096)
            if not block:
                break
            response.extend(block)
        connection.shutdown(socket.SHUT_RDWR)
        connection.close()
        return bytes(response)

    def test_path_source_retains_open_descriptor_after_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "source.cif"
            replacement = pathlib.Path(directory) / "replacement.cif"
            path.write_bytes(b"original")
            sources = prepare_sources([path])
            try:
                replacement.write_bytes(b"replacement")
                try:
                    os.replace(replacement, path)
                except PermissionError:
                    self.skipTest("open-file replacement is unavailable on this platform")
                self.server = CrysVizServer(sources)
                self.server.start()
                token = urlsplit(self.server.url).query.split("=", 1)[1]
                status, _, manifest_body = self.request("GET", f"/_crysviz/manifest/{token}")
                self.assertEqual(status, 200)
                route = urlsplit(json.loads(manifest_body)["inputs"][0]["url"]).path
                status, _, body = self.request("GET", route)
                self.assertEqual((status, body), (200, b"original"))
            finally:
                for source in sources:
                    source.close()

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO tests require POSIX")
    def test_fifo_rejected_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = pathlib.Path(directory) / "input.cif"
            os.mkfifo(fifo)
            with self.assertRaises(ValueError):
                prepare_sources([fifo])

    def test_loopback_manifest_input_headers_and_head(self):
        server = self.start()
        launch = urlsplit(server.url)
        token = launch.query.split("=", 1)[1]
        status, headers, body = self.request("GET", f"/_crysviz/manifest/{token}")
        self.assertEqual(status, 200)
        for header in ("Cache-Control", "Referrer-Policy", "X-Content-Type-Options", "Cross-Origin-Resource-Policy"):
            self.assertIn(header, headers)
        manifest = json.loads(body)
        self.assertEqual(set(manifest), {"version", "inputs"})
        self.assertNotIn("memory.dat", f"/_crysviz/manifest/{token}")
        input_path = urlsplit(manifest["inputs"][0]["url"]).path
        self.assertNotIn("memory.dat", input_path)
        status, headers, body = self.request("GET", input_path)
        self.assertEqual((status, body), (200, b"a\x00b"))
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        status, headers, body = self.request("HEAD", input_path)
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(int(headers["Content-Length"]), 3)

    def test_managed_bridge_revokes_bootstrap_but_accepts_later_private_input(self):
        sources = prepare_sources([crysviz.Payload("initial.cif", b"initial")])
        self.server = CrysVizServer(sources, bridge_capability="bridge-capability-for-test")
        self.server.start()
        token = urlsplit(self.server.url).query.split("=", 1)[1]
        manifest = json.loads(self.request("GET", f"/_crysviz/manifest/{token}")[2])
        self.assertNotIn("managed", manifest)
        self.assertEqual(self.request("POST", f"/_crysviz/manifest/{token}/complete", body=b'{"ok":true}')[0], 200)
        self.assertEqual(self.request("GET", f"/_crysviz/manifest/{token}")[0], 404)
        later = prepare_sources([crysviz.Payload("later.cif", b"later")])[0]
        route = urlsplit(self.server.publish(later)).path
        self.assertEqual(self.request("HEAD", route)[0], 200)
        self.assertEqual(self.request("GET", route)[2], b"later")
        self.assertEqual(self.request("GET", route)[0], 404)

    def test_static_mime_security_and_rejections(self):
        server = self.start([])
        launch = urlsplit(server.url)
        status, headers, body = self.request("GET", "/index.html?" + launch.query)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertIn(b"<!doctype html>", body)
        status, headers, _ = self.request("GET", "/compiled/periodic_wasm_bg.wasm")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/wasm")
        status, headers, _ = self.request("GET", "/host/early.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/javascript")
        for target in ("/../README.md", "/%2e%2e/README.md", "/compiled/", "/index.html?extra=1"):
            status, _, _ = self.request("GET", target)
            self.assertEqual(status, 404, target)
        status, _, _ = self.request("PUT", "/index.html")
        self.assertEqual(status, 405)

    def test_capability_percent_encoded_aliases_are_rejected(self):
        server = self.start([crysviz.Payload("x.cif", b"CIF bytes")])
        launch = urlsplit(server.url)
        token = launch.query.split("=", 1)[1]
        manifest_route = f"/_crysviz/manifest/{token}"
        status, _, manifest_body = self.request("GET", manifest_route)
        self.assertEqual(status, 200)
        manifest = json.loads(manifest_body)
        input_route = urlsplit(manifest["inputs"][0]["url"]).path
        alias_manifest_token = "%" + format(ord(token[0]), "02X") + token[1:]
        input_token = input_route.rsplit("/", 1)[1]
        alias_input_token = "%" + format(ord(input_token[0]), "02X") + input_token[1:]
        alias_manifest = f"/_crysviz/manifest/{alias_manifest_token}"
        alias_input = input_route.replace(input_token, alias_input_token, 1)
        self.assertEqual(self.request("GET", alias_manifest)[0], 404)
        self.assertEqual(self.request("GET", alias_input)[0], 404)
        completion = f"/_crysviz/manifest/{token}/complete"
        alias_completion = f"/_crysviz/manifest/{alias_manifest_token}/complete"
        self.assertEqual(self.request("POST", alias_completion, body=b'{"ok":true}')[0], 404)
        self.assertEqual(self.request("POST", completion, body=b'{"ok":true}')[0], 200)

    def test_static_percent_decoding_remains_supported(self):
        self.start([])
        self.assertEqual(self.request("GET", "/index%2ehtml")[0], 200)

    def test_unsupported_verbs_are_json_and_close_connections(self):
        self.start([])
        for method in ("TRACE", "CONNECT", "BREW"):
            response = self.raw_request(method, "/index.html", body=b"GET /index.html")
            self.assertIn(b"Content-Type: application/json", response)
            self.assertIn(b"Connection: close", response)
            self.assertIn(b'"error"', response)
            self.assertNotIn(b"<!DOCTYPE", response)
            self.assertNotIn(b"BaseHTTP", response)

    def test_completion_rejects_duplicate_length_and_transfer_encoding(self):
        server = self.start([])
        token = urlsplit(server.url).query.split("=", 1)[1]
        route = f"/_crysviz/manifest/{token}/complete"
        duplicate_length = self.raw_request(
            "POST", route, body=b'{"ok":true}',
            extra_headers=(("Content-Type", "application/json"), ("Content-Length", "11")),
        )
        self.assertIn(b"400", duplicate_length.split(b"\r\n", 1)[0])
        transfer_encoded = self.raw_request(
            "POST", route, body=b'{"ok":true}',
            extra_headers=(("Content-Type", "application/json"), ("Transfer-Encoding", "chunked")),
        )
        self.assertIn(b"400", transfer_encoded.split(b"\r\n", 1)[0])
        self.assertEqual(self.request("POST", route, body=b'{"ok":true}')[0], 200)

    def test_client_disconnect_during_stream_does_not_call_error_handler(self):
        source = crysviz.Payload("large.cif", b"x" * (2 * 1024 * 1024))
        self.start([source])
        errors = []
        done = threading.Event()

        def handle_error(request, client_address):
            errors.append((request, client_address))
            done.set()

        self.server._httpd.handle_error = handle_error
        token = urlsplit(self.server.url).query.split("=", 1)[1]
        manifest_status, _, manifest_body = self.request("GET", f"/_crysviz/manifest/{token}")
        self.assertEqual(manifest_status, 200)
        route = urlsplit(json.loads(manifest_body)["inputs"][0]["url"]).path
        self.raw_headers_then_disconnect(route)
        self.assertEqual(self.request("GET", f"/_crysviz/manifest/{token}")[0], 200)
        self.assertFalse(done.is_set())
        self.assertEqual(errors, [])

    def test_close_before_start_closes_sources_and_start_after_close_fails(self):
        sources = prepare_sources([crysviz.Payload("x.cif", b"x")])
        stream = sources[0].stream
        server = CrysVizServer(sources)
        server.close()
        self.assertTrue(stream.closed)
        with self.assertRaises(RuntimeError):
            server.start()

    def test_start_failure_closes_constructed_httpd_and_sources(self):
        sources = prepare_sources([crysviz.Payload("x.cif", b"x")])
        stream = sources[0].stream
        fake_server = mock.Mock()

        def construct(address, state):
            fake_server.state = state
            fake_server.server_address = ("127.0.0.1", 12345)
            return fake_server

        server = CrysVizServer(sources)
        with mock.patch("crysviz._server._Server", side_effect=construct):
            with mock.patch("threading.Thread.start", side_effect=RuntimeError("thread start failed")):
                with self.assertRaises(RuntimeError):
                    server.start()
        self.assertTrue(stream.closed)
        fake_server.server_close.assert_called_once()
        with self.assertRaises(RuntimeError):
            server.start()

    def test_manifest_omits_binary_for_bytes_text_source(self):
        server = self.start([crysviz.Payload("x.cif", b"CIF bytes")])
        token = urlsplit(server.url).query.split("=", 1)[1]
        status, headers, body = self.request("GET", f"/_crysviz/manifest/{token}")
        self.assertEqual(status, 200)
        item = json.loads(body)["inputs"][0]
        self.assertNotIn("binary", item)
        input_route = urlsplit(item["url"]).path
        status, headers, body = self.request("GET", input_route)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(body, b"CIF bytes")

    def test_exact_host_and_capability_expiration(self):
        server = self.start()
        launch = urlsplit(server.url)
        token = launch.query.split("=", 1)[1]
        manifest_route = f"/_crysviz/manifest/{token}"
        status, _, _ = self.request("GET", manifest_route, host="localhost:" + str(launch.port))
        self.assertEqual(status, 404)
        status, _, manifest_body = self.request("GET", manifest_route)
        self.assertEqual(status, 200)
        manifest = json.loads(manifest_body)
        completion = f"/_crysviz/manifest/{token}/complete"
        status, _, _ = self.request("POST", completion, body=b'{"ok":true}')
        self.assertEqual(status, 200)
        status, _, _ = self.request("GET", manifest_route)
        self.assertEqual(status, 404)
        status, _, _ = self.request("GET", urlsplit(manifest["inputs"][0]["url"]).path)
        self.assertEqual(status, 404)
        status, _, _ = self.request("POST", completion, body=b'{"ok":true}')
        self.assertEqual(status, 404)

    def test_malformed_completion_does_not_expire_then_failure_does(self):
        server = self.start()
        launch = urlsplit(server.url)
        token = launch.query.split("=", 1)[1]
        completion = f"/_crysviz/manifest/{token}/complete"
        for body in (b"not-json", b'{"ok":true,"extra":1}', b'{"ok":false}'):
            status, _, _ = self.request("POST", completion, body=body)
            self.assertEqual(status, 400)
        status, _, _ = self.request(
            "POST", completion,
            body=b'{"ok":false,"error":{"code":"LOAD_FAILED","message":"bad"}}',
        )
        self.assertEqual(status, 200)

    def test_managed_output_is_exact_one_use_png_upload(self):
        server = self.start([])
        output_url = server.reserve_output()
        route = urlsplit(output_url).path
        self.assertEqual(self.request("POST", route, body=b"not-png", headers={"Content-Type": "image/jpeg"})[0], 400)
        self.assertEqual(self.request("POST", route, body=b"\x89PNG\r\n\x1a\nimage", headers={"Content-Type": "image/png"})[0], 404)
        output_url = server.reserve_output()
        route = urlsplit(output_url).path
        self.assertEqual(self.request("POST", route, body=b"\x89PNG\r\n\x1a\nimage", headers={"Content-Type": "image/png"})[0], 200)
        stream = server.take_output(output_url)
        self.assertIsNotNone(stream)
        assert stream is not None
        self.assertEqual(stream.read(), b"\x89PNG\r\n\x1a\nimage")
        stream.close()
        self.assertEqual(self.request("POST", route, body=b"again", headers={"Content-Type": "image/png"})[0], 404)
        self.assertEqual(self.request("GET", route)[0], 404)
        self.assertEqual(self.request("POST", route, body=b"bad-host", host="localhost")[0], 404)

    def test_managed_output_rejects_encoded_alias_and_oversize(self):
        server = self.start([])
        wrong_host_url = server.reserve_output()
        wrong_host_route = urlsplit(wrong_host_url).path
        self.assertEqual(self.request("POST", wrong_host_route, body=b"bad-host", host="localhost")[0], 404)
        self.assertEqual(self.request("POST", wrong_host_route, body=b"\x89PNG\r\n\x1a\nimage", headers={"Content-Type": "image/png"})[0], 200)
        completed = server.take_output(wrong_host_url)
        self.assertIsNotNone(completed)
        completed.close()

        wrong_method_url = server.reserve_output()
        wrong_method_route = urlsplit(wrong_method_url).path
        self.assertEqual(self.request("GET", wrong_method_route)[0], 404)
        self.assertEqual(self.request("POST", wrong_method_route, body=b"\x89PNG\r\n\x1a\nimage", headers={"Content-Type": "image/png"})[0], 200)
        completed = server.take_output(wrong_method_url)
        self.assertIsNotNone(completed)
        completed.close()

        for headers, body in (
            ({"Content-Type": "image/png"}, None),
            ({"Content-Type": "image/png", "Content-Length": "1"}, b"x"),
        ):
            bad_url = server.reserve_output()
            bad_route = urlsplit(bad_url).path
            if body is None:
                status = self.request("POST", bad_route)[0]
            else:
                raw = self.raw_request("POST", bad_route, body=body, extra_headers=tuple(headers.items()))
                status = 400 if b"400" in raw.split(b"\r\n", 1)[0] else 0
            self.assertEqual(status, 400)
            self.assertEqual(self.request("POST", bad_route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)

        invalid_length_url = server.reserve_output()
        invalid_length_route = urlsplit(invalid_length_url).path
        invalid = self.raw_request(
            "POST", invalid_length_route, body=b"x", extra_headers=(("Content-Type", "image/png"), ("Content-Length", "nope")),
            include_default_length=False,
        )
        self.assertIn(b"400", invalid.split(b"\r\n", 1)[0])
        self.assertEqual(self.request("POST", invalid_length_route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)

        transfer_url = server.reserve_output()
        transfer_route = urlsplit(transfer_url).path
        transfer = self.raw_request(
            "POST", transfer_route, body=b"", extra_headers=(("Content-Type", "image/png"), ("Transfer-Encoding", "chunked")),
            include_default_length=False,
        )
        self.assertIn(b"400", transfer.split(b"\r\n", 1)[0])
        self.assertEqual(self.request("POST", transfer_route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)

        zero_url = server.reserve_output()
        zero_route = urlsplit(zero_url).path
        self.assertEqual(self.request("POST", zero_route, body=b"", headers={"Content-Type": "image/png"})[0], 400)
        self.assertEqual(self.request("POST", zero_route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)

        incomplete_url = server.reserve_output()
        incomplete_route = urlsplit(incomplete_url).path
        incomplete = self.raw_post_declared_length(incomplete_route, 8, b"short")
        self.assertIn(b"400", incomplete.split(b"\r\n", 1)[0])
        self.assertEqual(self.request("POST", incomplete_route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)

        output_url = server.reserve_output()
        route = urlsplit(output_url).path
        token = route.rsplit("/", 1)[1]
        alias = route.replace(token, "%" + format(ord(token[0]), "02X") + token[1:], 1)
        self.assertEqual(self.request("POST", alias, body=b"x", headers={"Content-Type": "image/png"})[0], 404)
        response = self.raw_request(
            "POST", route, body=b"", extra_headers=(
                ("Content-Type", "image/png"), ("Content-Length", str(2 * 1024 * 1024 * 1024 + 1)),
            ), include_default_length=False,
        )
        self.assertIn(b"413", response.split(b"\r\n", 1)[0])
        self.assertEqual(self.request("POST", route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)

        discard_url = server.reserve_output()
        discard_route = urlsplit(discard_url).path
        server.discard_output("http://example.invalid" + discard_route)
        self.assertEqual(self.request("POST", discard_route, body=b"\x89PNG\r\n\x1a\nimage", headers={"Content-Type": "image/png"})[0], 200)
        completed = server.take_output(discard_url)
        self.assertIsNotNone(completed)
        completed.close()
        discard_pending_url = server.reserve_output()
        discard_pending_route = urlsplit(discard_pending_url).path
        server.discard_output(discard_pending_url)
        self.assertEqual(self.request("POST", discard_pending_route, body=b"x", headers={"Content-Type": "image/png"})[0], 404)


class PackagingMetadataTests(unittest.TestCase):
    def test_pywebview_backend_extras_are_forwarded_and_pinned(self):
        with (pathlib.Path(__file__).parents[1] / "pyproject.toml").open("rb") as stream:
            metadata = tomllib.load(stream)
        project = metadata["project"]
        self.assertEqual(metadata["build-system"]["requires"], ["setuptools>=77.0.3"])
        self.assertEqual(project["dependencies"], ["pywebview>=6.2,<7"])
        self.assertEqual(project["optional-dependencies"], {
            "qt": ["pywebview[qt]>=6.2,<7"],
            "gtk": ["pywebview[gtk]>=6.2,<7"],
        })

    def test_generated_frontend_directories_are_excluded(self):
        root = pathlib.Path(__file__).parents[1]
        manifest = (root / "MANIFEST.in").read_text(encoding="utf-8")
        for path in (
            "docs/compiled/periodic_wasm_src/target",
            "docs/compiled/periodic_wasm_src/pkg",
            "docs/report",
        ):
            self.assertIn(f"prune {path}", manifest)
        with (root / "pyproject.toml").open("rb") as stream:
            package_data = tomllib.load(stream)["tool"]["setuptools"]["exclude-package-data"]["crysviz.web"]
        for pattern in ("**/target/**/*", "**/pkg/**/*", "report/**/*"):
            self.assertIn(pattern, package_data)

    def test_examples_are_in_source_distribution_only(self):
        root = pathlib.Path(__file__).parents[1]
        manifest = (root / "MANIFEST.in").read_text(encoding="utf-8")
        self.assertIn("recursive-include examples *.py README.md", manifest)
        self.assertTrue((root / "examples" / "rotate_camera.py").is_file())
        self.assertTrue((root / "examples" / "raytrace_snapshot.py").is_file())
        self.assertNotIn("examples", tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8")).get("tool", {}).get("setuptools", {}).get("packages", []))


class CLITests(unittest.TestCase):
    def test_parser_and_conflicts(self):
        args = build_parser().parse_args(["--browser", "--no-open", "--port", "123", "a.cif"])
        self.assertTrue(args.browser)
        self.assertEqual(args.port, 123)
        with self.assertRaises(SystemExit):
            main(["--no-open"])
        with self.assertRaises(SystemExit):
            main(["--browser", "--gui", "qt"])

    def test_invalid_source_is_before_server_start(self):
        with mock.patch("crysviz.cli.CrysVizServer.start") as start:
            with self.assertRaises(SystemExit):
                main(["--browser", "--no-open", "/not/a/real/file"])
            start.assert_not_called()

    def test_pywebview_failure_is_lazy_and_actionable(self):
        stderr = io.StringIO()
        with mock.patch.dict(sys.modules, {"webview": None}):
            with redirect_stderr(stderr):
                self.assertEqual(main(["--gui", "qt"]), 1)
        self.assertIn("use --browser", stderr.getvalue())

    def test_native_window_enables_web_storage(self):
        webview = mock.Mock()
        server = mock.Mock(url="http://127.0.0.1:1234/index.html")
        with mock.patch.dict(sys.modules, {"webview": webview}):
            self.assertEqual(_run_pywebview(server, "qt", True), 0)
        webview.create_window.assert_called_once_with(
            "CrysViz", server.url, width=1280, height=800, min_size=(640, 480),
        )
        webview.start.assert_called_once_with(debug=True, private_mode=False, gui="qt")

    def test_fixed_port_failure_is_concise(self):
        occupied = socket.socket()
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        try:
            port = occupied.getsockname()[1]
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                result = main(["--browser", "--no-open", "--port", str(port)])
            self.assertEqual(result, 1)
            self.assertIn(f"port {port}", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())
        finally:
            occupied.close()


if __name__ == "__main__":
    unittest.main()
