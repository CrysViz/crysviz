from __future__ import annotations

import signal
import subprocess
import sys
import unittest
import urllib.request


class HostHeaderTests(unittest.TestCase):
    def test_page_is_cross_origin_isolated(self):
        """The desktop host serves COOP+COEP so the page is crossOriginIsolated
        (SharedArrayBuffer, measureUserAgentSpecificMemory). COEP is
        credentialless so the CDN resources without CORP still load."""
        process = subprocess.Popen(
            [sys.executable, "-m", "crysviz.cli", "--browser", "--no-open"],
            cwd="/tmp",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            url = process.stdout.readline().strip()  # type: ignore[union-attr]
            self.assertRegex(url, r"^http://127\.0\.0\.1:[0-9]+/index\.html")
            with urllib.request.urlopen(url, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
                self.assertEqual(response.headers.get("Cross-Origin-Embedder-Policy"), "credentialless")
            process.send_signal(signal.SIGINT)
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            if process.stderr:
                process.stderr.close()
            if process.stdout:
                process.stdout.close()


if __name__ == "__main__":
    unittest.main()
