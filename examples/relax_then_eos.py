"""Relax fcc copper, then scan its volume and fit an equation of state.

Calculations run in the window with the Atomistic window's potential (NEP89 by
default). The EOS fit loads SciPy (Pyodide) from the network, so this needs an
Internet connection. run_* methods wait until the job ends; pass wait=False to
get the job back at once. symmetry=True keeps the space group (the Wyckoff
editor's lock), and the EOS result says whether its fit can be trusted.
"""

import sys

from crysviz import Payload, Viewer

CU = """Cu fcc
1.0
3.7 0 0
0 3.7 0
0 0 3.7
Cu
4
Direct
0 0 0
0 0.5 0.5
0.5 0 0.5
0.5 0.5 0
"""


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("Cu.vasp", CU)]) as v:
        relax = v.run_relax(fmax=0.01, relax_cell=True, symmetry=True)["result"]
        print(f"Relaxed in {relax['steps']} steps (converged: {relax['converged']}), "
              f"E = {relax['energy']:.4f} eV, space group {relax['symmetry']['endSymbol']} "
              f"(kept: {relax['symmetry']['kept']})")
        eos = v.run_eos(volume_range_pct=5, points=7)["result"]
        if not eos["fitReliable"]:
            print("The EOS fit is not reliable:", "; ".join(eos["warnings"]))
            return
        fit = eos["fit"]["energyVolume"]
        print(f"V0 = {fit['V0']:.2f} A^3 per cell, B0 = {fit['B0GPa']:.0f} GPa, B0' = {fit['B0Prime']:.2f}")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
