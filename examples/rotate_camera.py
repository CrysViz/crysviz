"""Open CrysViz and smoothly orbit a small silicon cell."""

import time

from crysviz import Payload, Viewer


POSCAR = """Si cell
1.0
5.43 0 0
0 5.43 0
0 0 5.43
Si
1
Direct
0 0 0
"""


def main() -> None:
    with Viewer([Payload("orbit.POSCAR", POSCAR)], command_timeout=10) as viewer:
        for _ in range(72):
            viewer.rotate_camera(5, axis="y")
            time.sleep(0.04)
        print("CrysViz is open; close the window when finished.")
        viewer.wait()


if __name__ == "__main__":
    main()
