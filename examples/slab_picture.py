"""Cut a four-layer Cu(111) slab with 15 Å of vacuum and save a side view."""

import sys
from pathlib import Path

from crysviz import Payload, Viewer

CU = """Cu fcc
1.0
3.615 0 0
0 3.615 0
0 0 3.615
Cu
4
Direct
0 0 0
0.5 0.5 0
0.5 0 0.5
0 0.5 0.5
"""


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("Cu.vasp", CU)]) as v:
        slab = v.build_slab(hkl=[1, 1, 1], layers=4, vacuum=15)
        print(f"Slab {slab['name']}: {slab['atomCount']} atoms")
        # The slab's surface normal is along c, so looking along a shows the layers edge-on.
        v.set_view(direction="a", up="c", zoom=0.6)
        image = v.save_image(Path.cwd() / "cu111_slab.png", width=700, height=900)
        print(f"Saved {image}")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
