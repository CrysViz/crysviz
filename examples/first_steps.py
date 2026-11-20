"""A first tour: supercell, octahedra in blue, a view along c, a picture, a relaxation.

The same steps work one at a time in a Python REPL, IPython or Jupyter, where
show() returns at once and the window stays open:

    >>> from crysviz import show
    >>> v = show(["SrTiO3.cif"])
    >>> v.set_supercell(n=[2, 2, 2])
    ...
"""

import sys
from pathlib import Path

from crysviz import Payload, Viewer

SRTIO3 = """data_SrTiO3
_cell_length_a 3.905
_cell_length_b 3.905
_cell_length_c 3.905
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Sr1 Sr 0.0 0.0 0.0
Ti1 Ti 0.5 0.5 0.5
O1 O 0.5 0.5 0.0
O2 O 0.5 0.0 0.5
O3 O 0.0 0.5 0.5
"""


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("SrTiO3.cif", SRTIO3)]) as v:
        v.set_supercell(n=[2, 2, 2])
        octahedra = v.find(what="polyhedra", where={"cn": 6})
        v.apply(selection=octahedra["selection"], action="color", color="#3366ff")
        print(f"{octahedra['count']} TiO6 octahedra, {octahedra['atomCount']} atoms coloured")
        v.set_view(direction="c")
        print(f"Saved {v.save_image(Path.cwd() / 'srtio3_view.png')}")
        relax = v.run_relax(fmax=0.02)["result"]  # waits until the relaxation ends
        print(f"Relaxed in {relax['steps']} steps, converged: {relax['converged']}")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
