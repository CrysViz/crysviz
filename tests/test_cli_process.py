from __future__ import annotations

import signal
import subprocess
import sys
import unittest
import urllib.request


class BrowserCLIProcessTests(unittest.TestCase):
    def test_browser_no_open_lifetime_and_interrupt(self):
        process = subprocess.Popen(
            [sys.executable, "-m", "crysviz.cli", "--browser", "--no-open"],
            cwd="/tmp",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            url = process.stdout.readline().strip()  # type: ignore[union-attr]
            self.assertRegex(url, r"^http://127\.0\.0\.1:[0-9]+/index\.html\?\_crysviz_manifest=")
            with urllib.request.urlopen(url, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b"CrysViz", response.read(1024))
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
