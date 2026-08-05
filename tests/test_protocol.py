from __future__ import annotations

import json
import threading
import unittest
from io import BytesIO
from multiprocessing import Pipe
from unittest import mock

from crysviz._protocol import MAX_CHUNK_BYTES, SPOOL_THRESHOLD, ProtocolError, recv_frame, send_frame


class ProtocolTests(unittest.TestCase):
    def _round_trip(self, payload, attachments=None):
        left, right = Pipe(duplex=True)
        sender = threading.Thread(target=send_frame, args=(left, "command", payload, attachments))
        sender.start()
        try:
            return recv_frame(right)
        finally:
            sender.join(timeout=5)
            left.close()
            right.close()

    def test_json_frame_and_chunked_attachment(self):
        data = bytes(range(251)) * ((MAX_CHUNK_BYTES // 251) + 2)
        message_type, payload, attachments = self._round_trip({"id": "1"}, {"data": data})
        try:
            self.assertEqual(message_type, "command")
            self.assertEqual(payload, {"id": "1"})
            self.assertEqual(attachments["data"].read(), data)
        finally:
            attachments["data"].close()

    def test_large_attachments_spool_to_disk(self):
        data = b"x" * (SPOOL_THRESHOLD + 1)
        _, _, attachments = self._round_trip({}, {"data": data})
        try:
            self.assertTrue(getattr(attachments["data"].stream, "_rolled", False))
        finally:
            attachments["data"].close()

    def test_rejects_non_json_wrong_version_and_oversized_control(self):
        left, right = Pipe(duplex=True)
        try:
            for raw in (b"not json", json.dumps({"version": 2, "type": "x", "payload": None, "attachments": []}).encode()):
                left.send_bytes(raw)
                with self.assertRaises(ProtocolError):
                    recv_frame(right)
            sender = threading.Thread(target=left.send_bytes, args=(b" " * (1024 * 1024 + 1),))
            sender.start()
            try:
                with self.assertRaises(ProtocolError):
                    recv_frame(right)
            finally:
                sender.join(timeout=5)
        finally:
            left.close()
            right.close()

    def test_rejects_attachment_chunk_larger_than_advertised(self):
        left, right = Pipe(duplex=True)
        try:
            left.send_bytes(json.dumps({"version": 1, "type": "x", "payload": None,
                                        "attachments": [{"name": "data", "size": 1}]}).encode())
            left.send_bytes(b"ab")
            with self.assertRaises(ProtocolError):
                recv_frame(right)
        finally:
            left.close()
            right.close()

    def test_rejects_stream_position_past_end(self):
        stream = BytesIO(b"x")
        stream.seek(2)
        left, right = Pipe(duplex=True)
        try:
            with self.assertRaises(ProtocolError):
                send_frame(left, "command", {}, {"data": stream})
        finally:
            left.close()
            right.close()

    def test_mid_attachment_eof_closes_current_spool(self):
        control = json.dumps({
            "version": 1, "type": "x", "payload": None,
            "attachments": [{"name": "data", "size": 2}],
        }).encode()
        class Connection:
            def __init__(self):
                self.first = True
            def recv_bytes(self, maximum):
                if self.first:
                    self.first = False
                    return control
                raise EOFError
        spool = BytesIO()
        with mock.patch("crysviz._protocol.tempfile.SpooledTemporaryFile", return_value=spool):
            with self.assertRaises(EOFError):
                recv_frame(Connection())
        self.assertTrue(spool.closed)
