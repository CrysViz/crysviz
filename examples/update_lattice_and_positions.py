"""Deform a two-atom silicon cell and move its atoms.

set_lattice keeps the fractional positions; move_atoms takes the atoms by
index and either new positions (to=) or a shift (by=). Run with --keep-open to
look around afterwards.
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
2
Direct
0 0 0
0.25 0.25 0.25
"""


def orbit(v: Viewer, steps: int) -> None:
    for _ in range(steps):
        v.set_view(rotate={"axis": "y", "degrees": 5})
        time.sleep(0.04)


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("lattice-and-positions.POSCAR", POSCAR)]) as v:
        orbit(v, 26)
        v.set_lattice(lattice=[[6.1, 0.0, 0.0], [0.45, 5.2, 0.0], [0.1, 0.35, 5.7]])
        moved = v.move_atoms(atoms=[1], to=[[0.32, 0.28, 0.36]])
        print(f"Moved atom 1; the structure now has {moved['atomCount']} atoms.")
        v.set_view(recenter=True)
        orbit(v, 46)
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
