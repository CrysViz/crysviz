"""Open CrysViz and smoothly orbit a small silicon cell.

Run it as a script (the window closes when the orbit ends) or with --keep-open
to look around afterwards.
"""

import sys
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


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("orbit.POSCAR", POSCAR)]) as v:
        for _ in range(72):
            v.set_view(rotate={"axis": "y", "degrees": 5})   # orbit 5 degrees about the world y axis
            time.sleep(0.04)
        print("Orbit complete.")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
