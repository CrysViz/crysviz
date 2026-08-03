"""Deform a two-atom silicon cell and update its fractional positions."""

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


def main() -> None:
    with Viewer([Payload("lattice-and-positions.POSCAR", POSCAR)], command_timeout=10) as viewer:
        structure = viewer.list_structures()[0]
        viewer.select(structure.id, frame=0)
        viewer.update_lattice([[6.1, 0.0, 0.0], [0.45, 5.2, 0.0], [0.1, 0.35, 5.7]])
        viewer.update_fractional_positions([[0.0, 0.0, 0.0], [0.32, 0.28, 0.36]], commit=True)
        viewer.recenter_camera()
        time.sleep(2)
    print("Lattice and fractional-position updates complete; the CrysViz window has closed.")


if __name__ == "__main__":
    main()
