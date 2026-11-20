"""Show the WO6 octahedra of a ReO3-type WO3 supercell in blue and save a picture.

Run it as a script (the window closes at the end) or with --keep-open to look
around first. In a REPL or notebook, run the lines in main() one by one.
"""

import sys
from pathlib import Path

from crysviz import Payload, Viewer

# The perovskite framework without its A cation: corner-sharing octahedra only.
WO3 = """WO3 (ReO3 type)
1.0
3.75 0 0
0 3.75 0
0 0 3.75
W O
1 3
Direct
0 0 0
0.5 0 0
0 0.5 0
0 0 0.5
"""


def switch(viewer: Viewer, what: str, on: bool) -> None:
    """Turn a display toggle on or off by name, as the feature search (Ctrl+F) finds it."""
    ref = viewer.search_controls(query=f"{what} {'on' if on else 'off'}", limit=1)["controls"][0]["ref"]
    viewer.set_control(ref=ref, value=on)


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("WO3.vasp", WO3)]) as v:
        v.set_supercell(n=[2, 2, 2])
        switch(v, "bonds", False)
        switch(v, "polyhedra", True)
        octahedra = v.find(what="polyhedra", where={"cn": 6})
        print(f"{octahedra['count']} octahedra")
        v.apply(selection=octahedra["selection"], action="color", color="#3366ff")
        v.set_view(direction=[1, 0.35, 0.2], up="c")
        image = v.save_image(Path.cwd() / "octahedra.png", width=900, height=700)
        print(f"Saved {image}")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
