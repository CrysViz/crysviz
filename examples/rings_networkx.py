"""Find the six-membered rings of a graphene sheet with networkx and colour one red.

CrysViz does not search for rings itself; the pattern is: export the structure,
rebuild CrysViz's own bond graph from get_bonding's cutoffs in a script, then
send the answer back as atom indices. Needs networkx (pip install networkx).
"""

import itertools
import sys
import tempfile
from pathlib import Path

from crysviz import Payload, Viewer

GRAPHENE = """graphene
1.0
2.46 0 0
-1.23 2.130422 0
0 0 10
C
2
Direct
0.333333 0.666667 0.5
0.666667 0.333333 0.5
"""


def read_poscar(path: Path) -> tuple[list[list[float]], list[str], list[list[float]]]:
    """Lattice rows, elements and fractional positions of a POSCAR (Direct coordinates)."""
    lines = path.read_text().split("\n")
    scale = float(lines[1])
    lattice = [[scale * float(x) for x in lines[i].split()] for i in (2, 3, 4)]
    symbols, counts = lines[5].split(), [int(n) for n in lines[6].split()]
    elements = [s for s, n in zip(symbols, counts) for _ in range(n)]
    start = next(i for i, line in enumerate(lines) if line.strip().lower().startswith("d")) + 1
    positions = [[float(x) for x in lines[start + k].split()[:3]] for k in range(len(elements))]
    return lattice, elements, positions


def bonded_graph(lattice, elements, positions, pairs):
    """CrysViz's bonds: atoms i, j (any periodic image) within the pair's [min, max] cutoffs.
    Each edge keeps the image offset, so rings can be told from paths that wrap the cell."""
    import networkx as nx

    cutoff = {tuple(sorted(p["elements"])): (p["min"], p["max"]) for p in pairs if p["shown"]}
    graph = nx.Graph()
    graph.add_nodes_from(range(len(elements)))
    for i, j in itertools.combinations(range(len(elements)), 2):
        low, high = cutoff.get(tuple(sorted((elements[i], elements[j]))), (0.0, 0.0))
        for shift in itertools.product((-1, 0, 1), repeat=3):
            d = [positions[j][k] + shift[k] - positions[i][k] for k in range(3)]
            cart = [sum(d[k] * lattice[k][c] for k in range(3)) for c in range(3)]
            if low <= sum(x * x for x in cart) ** 0.5 <= high:
                graph.add_edge(i, j, shift={(i, j): shift, (j, i): tuple(-s for s in shift)})
    return graph


def rings(graph, size: int):
    """Closed rings of `size` atoms (net image offset zero around the loop)."""
    import networkx as nx

    for cycle in nx.simple_cycles(graph, length_bound=size):
        if len(cycle) != size:
            continue
        loop = list(zip(cycle, cycle[1:] + cycle[:1]))
        net = [sum(graph.edges[a, b]["shift"][(a, b)][k] for a, b in loop) for k in range(3)]
        if net == [0, 0, 0]:
            yield cycle


def main(keep_open: bool = False) -> None:
    with Viewer([Payload("graphene.vasp", GRAPHENE)]) as v, tempfile.TemporaryDirectory() as folder:
        v.set_supercell(n=[3, 3, 1])
        exported = v.export_structure(Path(folder) / "sheet.vasp", format="poscar")
        lattice, elements, positions = read_poscar(Path(folder) / "sheet.vasp")
        graph = bonded_graph(lattice, elements, positions, v.get_bonding()["pairs"])
        found = list(rings(graph, 6))
        print(f"{len(found)} six-membered rings")
        # Prefer a ring that lies inside the cell (no bond crosses its edge): it reads best.
        inside = [ring for ring in found if all(
            graph.edges[a, b]["shift"][(a, b)] == (0, 0, 0) for a, b in zip(ring, ring[1:] + ring[:1]))]
        ring = (inside or found)[0]
        # A POSCAR groups atoms by element: map file atoms back to CrysViz's indices.
        order = exported.get("order") or list(range(len(elements)))
        v.apply(atoms=[order[k] for k in ring], action="color", color="#e03030")
        v.set_view(direction="c")  # look down on the sheet
        image = v.save_image(Path.cwd() / "ring.png", width=800, height=700)
        print(f"Coloured one ring red; saved {image}")
        if keep_open:
            v.wait()


if __name__ == "__main__":
    main(keep_open="--keep-open" in sys.argv)
