"""Switch to the ray tracer, turn the view a little and save a PNG.

Writes crysviz-raytrace.png in the current directory. A ray-traced image takes
a few seconds; the call waits for it.
"""

import sys
from pathlib import Path

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
    with Viewer([Payload("snapshot.POSCAR", POSCAR)]) as v:
        v.set_renderer(renderer="raytrace")
        v.set_view(rotate={"axis": "y", "degrees": 18})
        image = v.save_image(Path.cwd() / "crysviz-raytrace.png", width=640, height=480)
        print(f"Saved {image}")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
