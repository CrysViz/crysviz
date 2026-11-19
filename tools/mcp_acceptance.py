#!/usr/bin/env python3
"""End-to-end acceptance run of the crysviz MCP server.

Drives the real ``crysviz-mcp`` over stdio with the official MCP client, the
way Claude does, through ten user workflows and a shared-window test, checks
each result, and prints a PASS/FAIL table. A real CrysViz window opens.

    .venv/bin/python tools/mcp_acceptance.py                 # all
    .venv/bin/python tools/mcp_acceptance.py --only 2,5,collab
    .venv/bin/python tools/mcp_acceptance.py --server /path/to/crysviz-mcp --out /tmp/acc

Needs ``crysviz[mcp]`` plus a GUI backend (Qt or GTK) and a display. Only the
standard library otherwise; inputs are generated here, except
tools/mcp_acceptance_data/band_cscl.yaml (a phonopy band file for CsCl from a
nearest-neighbour spring model, Gamma-X, 5 q-points). Workflow 7's EOS fit
loads SciPy (Pyodide) from the network.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import re
import struct
import sys
import tempfile
import time
import traceback
import zlib
from pathlib import Path

from mcp import Client
from mcp.client.stdio import StdioServerParameters

DATA = Path(__file__).with_name("mcp_acceptance_data")

# ---- inputs -------------------------------------------------------------------

STO = ("SrTiO3\n1.0\n3.905 0 0\n0 3.905 0\n0 0 3.905\nSr Ti O\n1 1 3\nDirect\n"
       "0 0 0\n0.5 0.5 0.5\n0.5 0.5 0\n0.5 0 0.5\n0 0.5 0.5\n")
STO_DISTORTED = STO.replace("0.5 0.5 0.5\n", "0.5 0.5 0.505\n", 1)  # Ti off-centre by 0.02 A
CU = "Cu\n1.0\n3.615 0 0\n0 3.615 0\n0 0 3.615\nCu\n4\nDirect\n0 0 0\n0 0.5 0.5\n0.5 0 0.5\n0.5 0.5 0\n"
LI2O = ("Li2O\n1.0\n4.61 0 0\n0 4.61 0\n0 0 4.61\nO Li\n4 8\nDirect\n0 0 0\n0 .5 .5\n.5 0 .5\n.5 .5 0\n"
        ".25 .25 .25\n.75 .75 .75\n.25 .25 .75\n.75 .75 .25\n.25 .75 .25\n.75 .25 .75\n.75 .25 .25\n.25 .75 .75\n")
FCC = [(0, 0, 0), (0, .5, .5), (.5, 0, .5), (.5, .5, 0)]
FENI_CIF = "data_FeNi\n_cell_length_a 3.56\n_cell_length_b 3.56\n_cell_length_c 3.56\n" \
    "_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_symmetry_space_group_name_H-M 'P 1'\n" \
    "loop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n" \
    "_atom_site_fract_z\n_atom_site_occupancy\n" + "".join(
        f"{el}{i + 1} {el} {x} {y} {z} 0.5\n" for i, (x, y, z) in enumerate(FCC) for el in ("Fe", "Ni"))


def chgcar(n: int = 24) -> str:
    """A small synthetic CHGCAR of cubic SrTiO3: Gaussian densities, stored as rho*V, x fastest."""
    a = 3.905
    atoms = [("Sr", (0, 0, 0), 2.0), ("Ti", (.5, .5, .5), 3.0), ("O", (.5, .5, 0), 1.5),
             ("O", (.5, 0, .5), 1.5), ("O", (0, .5, .5), 1.5)]
    values = []
    for k in range(n):
        for j in range(n):
            for i in range(n):
                rho = 0.0
                for _, (x, y, z), amp in atoms:
                    d = [(i / n - x), (j / n - y), (k / n - z)]
                    r2 = sum((c - round(c)) ** 2 for c in d) * a * a
                    rho += amp * math.exp(-r2 / (2 * 0.35 ** 2))
                values.append(rho * a ** 3)
    lines = ["SrTiO3 synthetic", "1.0", f"{a} 0 0", f"0 {a} 0", f"0 0 {a}", "Sr Ti O", "1 1 3", "Direct"]
    lines += [f"{x} {y} {z}" for _, (x, y, z), _ in atoms] + ["", f"{n} {n} {n}"]
    lines += [" ".join(f"{v:.11E}" for v in values[i:i + 5]) for i in range(0, len(values), 5)]
    return "\n".join(lines) + "\n"


def prototype_cif(name: str, a: float, sites: list[tuple[str, tuple[float, float, float]]]) -> str:
    rows = "".join(f"{el}{i + 1} {el} {x} {y} {z}\n" for i, (el, (x, y, z)) in enumerate(sites))
    return (f"data_{name}\n_cell_length_a {a}\n_cell_length_b {a}\n_cell_length_c {a}\n"
            "_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n"
            "_symmetry_space_group_name_H-M 'P 1'\nloop_\n_atom_site_label\n_atom_site_type_symbol\n"
            "_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n" + rows)


def screening_set() -> list[tuple[str, str, int]]:
    """20 cubic prototypes: (file name, CIF text, expected space-group number)."""
    out = []
    for a, b, lat in [("Na", "Cl", 5.64), ("Mg", "O", 4.21), ("K", "Cl", 6.29), ("Li", "F", 4.03), ("Ca", "O", 4.81)]:
        sites = [(a, p) for p in FCC] + [(b, (x + .5 if x == 0 else x - .5, y, z)) for x, y, z in FCC]
        out.append((f"{a}{b}_rocksalt.cif", prototype_cif(f"{a}{b}", lat, sites), 225))
    for a, b, lat in [("Cs", "Cl", 4.12), ("Cs", "Br", 4.29), ("Tl", "Cl", 3.84), ("Cs", "I", 4.57), ("Tl", "Br", 3.97)]:
        out.append((f"{a}{b}_cscl.cif", prototype_cif(f"{a}{b}", lat, [(a, (0, 0, 0)), (b, (.5, .5, .5))]), 221))
    for el, lat in [("Cu", 3.615), ("Al", 4.05), ("Ni", 3.52), ("Ag", 4.09), ("Au", 4.08)]:
        out.append((f"{el}_fcc.cif", prototype_cif(el, lat, [(el, p) for p in FCC]), 225))
    for el, lat in [("Fe", 2.87), ("W", 3.16), ("Mo", 3.15), ("Cr", 2.88), ("Na", 4.23)]:
        out.append((f"{el}_bcc.cif", prototype_cif(el, lat, [(el, (0, 0, 0)), (el, (.5, .5, .5))]), 229))
    return out


# ---- PNG ----------------------------------------------------------------------

def png_size(data: bytes) -> tuple[int, int]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return struct.unpack(">II", data[16:24])


def png_pixels(data: bytes, max_rows: int | None = None) -> tuple[int, int, int, list[bytearray]]:
    """(width, height, channels, rows) of an 8-bit RGB/RGBA PNG, the first max_rows rows only if given."""
    width, height = png_size(data)
    depth, ctype = data[24], data[25]
    assert depth == 8 and ctype in (2, 6), f"unsupported PNG (depth {depth}, type {ctype})"
    channels = 4 if ctype == 6 else 3
    idat, pos = b"", 8
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        if kind == b"IDAT":
            idat += data[pos + 8:pos + 8 + length]
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * channels
    rows, prev = [], bytearray(stride)
    for r in range(height if max_rows is None else min(height, max_rows)):
        f, line = raw[r * (stride + 1)], bytearray(raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)])
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up = prev[i]
            if f == 1:
                line[i] = (line[i] + left) & 255
            elif f == 2:
                line[i] = (line[i] + up) & 255
            elif f == 3:
                line[i] = (line[i] + (left + up) // 2) & 255
            elif f == 4:
                ul = prev[i - channels] if i >= channels else 0
                p = left + up - ul
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - ul)
                line[i] = (line[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else ul)) & 255
        rows.append(line)
        prev = line
    return width, height, channels, rows


def count_colour(data: bytes, test) -> tuple[int, int]:
    """(matching pixels, total pixels) of a PNG for test(r, g, b, a)."""
    width, height, ch, rows = png_pixels(data)
    hits = sum(1 for row in rows for i in range(0, len(row), ch)
               if test(row[i], row[i + 1], row[i + 2], row[i + 3] if ch == 4 else 255))
    return hits, width * height


def distinct_colours(data: bytes) -> int:
    _, _, ch, rows = png_pixels(data)
    return len({bytes(row[i:i + 3]) for row in rows for i in range(0, len(row), ch * 7)})


# ---- helpers ------------------------------------------------------------------

class Failed(Exception):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise Failed(message)


def frac_delta(p, q, lattice):
    d = [(a - b) - round(a - b) for a, b in zip(p, q)]
    return [sum(d[i] * lattice[i][k] for i in range(3)) for k in range(3)]


def parse_extxyz(text: str):
    frames, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        n = int(lines[i])
        header = lines[i + 1]
        lattice = [float(x) for x in re.search(r'Lattice="([^"]+)"', header).group(1).split()]
        atoms = [(parts[0], [float(x) for x in parts[1:4]]) for parts in (l.split() for l in lines[i + 2:i + 2 + n])]
        frames.append(([lattice[0:3], lattice[3:6], lattice[6:9]], atoms))
        i += n + 2
    return frames


class Session:
    def __init__(self, client: Client, out: Path):
        self.client, self.out = client, out

    async def raw(self, name, args=None):
        return await self.client.call_tool(name, args or {})

    async def call(self, name, args=None):
        r = await self.raw(name, args)
        text = next((c.text for c in r.content if c.type == "text"), "")
        if r.is_error:
            raise Failed(f"{name}({json.dumps(args)[:120]}) -> {text[:300]}")
        return json.loads(text) if text[:1] in "[{" else text

    async def error(self, name, args=None) -> str:
        r = await self.raw(name, args)
        check(r.is_error, f"{name} should have failed")
        return r.content[0].text

    async def image(self, name: str | None = None, **args) -> bytes:
        r = await self.raw("save_image", args)
        if r.is_error:
            raise Failed(f"save_image -> {r.content[0].text[:300]}")
        data = base64.b64decode(next(c for c in r.content if c.type == "image").data)
        if name:
            (self.out / name).write_bytes(data)
        return data

    async def job(self, name, args=None) -> dict:
        started = await self.call(name, args)
        while True:
            view = await self.call("wait_job", {"jobId": started["jobId"], "timeoutS": 25})
            if view["status"] != "running":
                check(view["status"] == "done", f"{name} job {view['status']}: {view.get('error')}")
                return view["result"]

    async def toggle(self, query: str, on: bool) -> None:
        ref = (await self.call("search_controls", {"query": f"{query} {'on' if on else 'off'}", "limit": 1}))[0]["ref"]
        state = await self.call("set_control", {"ref": ref, "value": on})
        check(state.get("on") is on, f"{query} did not switch {on}: {state}")

    async def state(self, atoms=False):
        return await self.call("get_state", {"atoms": True} if atoms else {})

    async def load_cell(self, text: str, name: str, atoms: int):
        """Load a structure as its base cell. The Cell & Supercell window remembers a supercell per
        structure (state/cellPrefs.js) and restores it when the same structure loads again, as an
        earlier workflow's may be; this goes back to the 1x1x1 cell then."""
        loaded = await self.call("load", {"text": text, "name": name})
        if (await self.state())["structure"]["atomCount"] != atoms:
            await self.call("build_supercell", {"n": [1, 1, 1]})
        check((await self.state())["structure"]["atomCount"] == atoms, f"{name} did not load as its base cell")
        return loaded


# ---- workflows ----------------------------------------------------------------

async def w1_vacancy_relax(s: Session):
    await s.load_cell(STO, "SrTiO3.vasp", 5)
    await s.call("build_supercell", {"n": [3, 3, 3]})
    oxygens = await s.call("find", {"what": "atoms", "where": {"element": "O"}, "limit": 1})
    removed = await s.call("remove_atoms", {"atoms": [oxygens["items"][0][0]]})
    check(removed["atomCount"] == 134, f"vacancy cell has {removed['atomCount']} atoms")
    before = (await s.state(atoms=True))["structure"]
    relax = await s.job("run_relax", {"maxSteps": 40, "fmax": 0.05})
    check(relax["steps"] > 0 and relax["trajectory"]["frames"] >= 2, f"relax: {relax}")
    await s.call("select", {"id": relax["trajectory"]["id"], "frame": relax["trajectory"]["frames"] - 1})
    after = (await s.state(atoms=True))["structure"]
    check(after["atomCount"] == 134, "relaxed structure lost atoms")
    path = (await s.call("export_structure", {"format": "cif", "filename": "w1_relaxed"}))["path"]
    check(Path(path).is_file(), "relaxed CIF not written")
    lattice = before["lattice"]["vectors"]
    moves = [math.hypot(*frac_delta(a["position"], b["position"], lattice))
             for a, b in zip(after["atoms"], before["atoms"])]
    biggest = max(moves)
    check(0.01 < biggest < 1.0, f"largest displacement {biggest:.3f} A")
    return f"{relax['steps']} steps, largest move {biggest:.3f} A"


async def w2_figure(s: Session):
    await s.load_cell(STO, "SrTiO3.vasp", 5)
    await s.toggle("polyhedra", True)
    await s.toggle("unit cell", False)
    # The SrO12 cuboctahedra enclose the TiO6 octahedra: hide the Sr, as a TiO6 figure would.
    strontium = await s.call("find", {"what": "atoms", "where": {"element": "Sr"}})
    await s.call("apply", {"selection": strontium["selection"], "action": "hide"})
    await s.call("set_view", {"direction": [1, 1, 0], "up": "c"})
    octa = await s.call("find", {"what": "polyhedra", "where": {"center": "Ti", "cn": 6}})
    check(octa["count"] >= 1, f"no TiO6 octahedra: {octa}")
    await s.call("apply", {"selection": octa["selection"], "action": "color", "value": "#1f4fff"})
    blue = await s.image("w2_preview.png", width=400, height=300)
    hits, total = count_colour(blue, lambda r, g, b, a: b > 150 and b > r + 60 and b > g + 40)
    check(hits > total * 0.01, f"octahedra not blue ({hits}/{total} blue pixels)")
    await s.call("set_render_pipeline", {"pipelineId": "raytrace"})
    try:
        saved = await s.call("save_image", {"width": 3000, "height": 2000, "transparent": True,
                                            "filename": "fig2", "returnImage": False})
    finally:
        # Display settings belong to the window, not the structure: put back what this changed.
        await s.call("set_render_pipeline", {"pipelineId": "forward"})
        await s.call("apply", {"selection": strontium["selection"], "action": "show"})
        await s.toggle("polyhedra", False)
        await s.toggle("unit cell", True)
    data = Path(saved["saved"]).read_bytes()
    check(png_size(data) == (3000, 2000), f"fig2 is {png_size(data)}")
    # The background inside the rendered area (top centre), not the letterbox corners.
    width, _, ch, rows = png_pixels(data, max_rows=6)
    alpha = rows[5][(width // 2) * ch + 3] if ch == 4 else 255
    check(alpha == 0, "fig2 background is opaque: the ray/path tracers ignore transparent (known gap)")
    return f"fig2 3000x2000 transparent, {octa['count']} TiO6"


async def w3_charge_density(s: Session):
    path = s.out / "CHGCAR"
    path.write_text(chgcar())
    await s.call("load", {"path": str(path)})
    info = await s.call("get_field_info")
    iso = await s.call("set_isosurface", {"value": 0.05})
    check(abs(iso["isoValue"] - 0.05) < 1e-9 and not iso["clamped"], f"iso: {iso}")
    atoms = (await s.state(atoms=True))["structure"]["atoms"]
    ti = next(i for i, a in enumerate(atoms) if a["element"] == "Ti")
    slice_ = await s.call("add_field_slice", {"hkl": [0, 0, 1], "throughAtom": ti})
    check(abs(slice_["d"] - 1.9525) < 1e-3, f"slice: {slice_}")
    image = await s.image("w3_chgcar.png", width=400, height=300)
    check(distinct_colours(image) > 20, "charge-density picture looks blank")
    grid = (info.get("selected") or {}).get("grid")
    check(grid == [24, 24, 24], f"field grid {grid}")
    return f"iso 0.05, (001) slice at {slice_['d']} A, grid {grid}"


async def w4_diffusion(s: Session):
    await s.load_cell(LI2O, "Li2O.vasp", 12)
    await s.call("build_supercell", {"n": [2, 2, 2]})
    md = await s.job("run_md", {"steps": 300, "temperatureK": 600, "saveStride": 4})
    exported = await s.call("export_trajectory", {"filename": "w4_li2o"})
    frames = parse_extxyz(Path(exported["path"]).read_text())
    check(len(frames) == exported["frames"] and len(frames) >= 50, f"{len(frames)} frames")
    lattice, first = frames[0]
    li = [i for i, (el, _) in enumerate(first) if el == "Li"]
    check(len(li) == 64, f"{len(li)} Li atoms")
    inv = invert3(lattice)
    unwrapped = {i: list(first[i][1]) for i in li}
    previous = {i: first[i][1] for i in li}
    for _, atoms in frames[1:]:
        for i in li:  # minimum-image step between saved frames, so wrapping never looks like a jump
            step = [b - a for a, b in zip(previous[i], atoms[i][1])]
            f = [sum(step[k] * inv[k][j] for k in range(3)) for j in range(3)]
            f = [x - round(x) for x in f]
            step = [sum(f[j] * lattice[j][k] for j in range(3)) for k in range(3)]
            unwrapped[i] = [u + d for u, d in zip(unwrapped[i], step)]
            previous[i] = atoms[i][1]
    msd = sum(sum((u - p) ** 2 for u, p in zip(unwrapped[i], first[i][1])) for i in li) / len(li)
    check(0 < msd < 5, f"Li MSD {msd}")
    return f"{md['frames'] if 'frames' in md else len(frames)} frames, Li MSD {msd:.3f} A^2"


def invert3(m):
    a, b, c = m
    det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    cof = [[(b[1] * c[2] - b[2] * c[1]), -(a[1] * c[2] - a[2] * c[1]), (a[1] * b[2] - a[2] * b[1])],
           [-(b[0] * c[2] - b[2] * c[0]), (a[0] * c[2] - a[2] * c[0]), -(a[0] * b[2] - a[2] * b[0])],
           [(b[0] * c[1] - b[1] * c[0]), -(a[0] * c[1] - a[1] * c[0]), (a[0] * b[1] - a[1] * b[0])]]
    return [[cof[i][j] / det for j in range(3)] for i in range(3)]


async def w5_symmetry(s: Session):
    await s.call("load", {"text": STO_DISTORTED, "name": "STO_distorted.vasp"})
    tight = await s.call("get_symmetry", {"tolerance": 0.01})
    loose = await s.call("get_symmetry", {"tolerance": 0.1})
    check(tight["number"] == 99 and loose["number"] == 221, f"{tight['number']} / {loose['number']}")
    sym = await s.call("symmetrize", {"tolerance": 0.1, "cell": "conventional"})
    check(sym["number"] == 221, f"symmetrized to {sym}")
    strict = await s.call("get_symmetry", {"tolerance": 0.001})
    check(strict["number"] == 221, f"symmetrized cell reads {strict['number']} at 0.001")
    path = Path((await s.call("export_structure", {"format": "cif", "filename": "w5_sym"}))["path"])
    check(path.is_file() and "_atom_site" in path.read_text(), "CIF not written")
    return f"{tight['symbol']} at 0.01, {loose['symbol']} at 0.1, symmetrized {sym['symbol']}"


async def w6_ordering(s: Session):
    await s.call("load", {"text": FENI_CIF, "name": "FeNi.cif"})
    order = await s.job("order_structure", {"samples": 5, "multiplier": 2, "energies": True})
    energies = [x["energyPerAtomEv"] for x in order["samples"]]
    check(len(energies) == 5 and energies == sorted(energies), f"energies {energies}")
    await s.call("select", {"id": order["trajectory"]["id"], "frame": order["samples"][0]["frame"]})
    state = (await s.state())["structure"]
    check(set(state["composition"]) == {"Fe", "Ni"}, f"lowest sample is {state['formula']}")
    await s.image("w6_lowest.png", width=400, height=300)
    return f"5 samples, {energies[0]:.4f} to {energies[-1]:.4f} eV/atom"


async def w7_eos(s: Session):
    await s.load_cell(CU, "Cu.vasp", 4)
    await s.job("run_relax", {"relaxCell": True, "maxSteps": 60, "fmax": 0.01})
    eos = await s.job("run_eos", {"points": 7, "volumeRangePct": 5})
    fit = eos["fit"]["energyVolume"]
    check(60 < fit["B0GPa"] < 300, f"B0 {fit['B0GPa']}")
    check(40 < fit["V0A3"] < 52, f"V0 {fit['V0A3']}")
    return f"V0 {fit['V0A3']:.2f} A^3/4 atoms, B0 {fit['B0GPa']:.0f} GPa"


async def w8_phonons(s: Session):
    await s.call("load", {"path": str(DATA / "band_cscl.yaml")})
    await s.call("get_phonon_state")
    mode = await s.call("set_phonon_mode", {"qpoint": "Gamma", "band": "lowest_optical", "play": False})
    check(mode["frequencyTHz"] > 1, f"mode {mode}")
    frames = await s.call("phonon_frames", {"count": 10, "amplitude": 0.4})
    check(frames["frames"] == 10, f"{frames}")
    images = []
    for k in range(10):
        await s.call("select", {"id": frames["id"], "frame": k})
        images.append(await s.image(f"w8_frame{k}.png" if k in (0, 5) else None, width=320, height=240))
    check(len(set(images)) >= 3, "phonon frames look identical")
    return f"Gamma optical {mode['frequencyTHz']:.3f} THz, 10 frames, {len(set(images))} distinct"


async def w9_slab(s: Session):
    await s.load_cell(CU, "Cu.vasp", 4)
    slab = await s.call("build_slab", {"hkl": [1, 1, 1], "layers": 4, "vacuum": 15})
    check(abs((slab["c"] - slab["thicknessA"]) - 15) < 0.1, f"slab {slab}")
    await s.call("set_view", {"direction": "x", "up": "z"})
    image = await s.image("w9_slab.png", width=400, height=300)
    check(distinct_colours(image) > 5, "slab picture looks blank")
    return f"{slab['atomCount']} atoms, {slab['thicknessA']:.3f} A thick, c {slab['c']:.3f} A"


async def w10_screening(s: Session):
    rows = []
    folder = s.out / "screening"
    folder.mkdir(exist_ok=True)
    for name, text, expected in screening_set():
        (folder / name).write_text(text)
        loaded = await s.call("load", {"path": str(folder / name)})
        structure = (await s.state())["structure"]
        lat = structure["lattice"]
        volume = lat["a"] * lat["b"] * lat["c"]  # all cubic here
        sym = await s.call("get_symmetry", {"tolerance": 0.01})
        check(sym["number"] == expected, f"{name}: {sym['number']} != {expected}")
        rows.append((volume / structure["atomCount"], structure["formula"], sym["symbol"], loaded["id"]))
    rows.sort()
    for _, formula, _, ident in rows[:3]:
        await s.call("select", {"id": ident})
        await s.image(f"w10_{formula}.png", width=320, height=240)
    return f"20 loaded, densest: {', '.join(r[1] for r in rows[:3])}"


async def collaboration(s: Session):
    await s.load_cell(STO, "SrTiO3.vasp", 5)
    # The "user" turns and zooms the view.
    await s.call("rotate_camera", {"angleDegrees": 35, "axis": "y"})
    cam = (await s.state())["camera"]
    await s.call("set_view", {"direction": cam["direction"], "up": cam["up"], "zoom": 1.7, "cartesian": True})
    before = (await s.state())["camera"]
    full = await s.image()  # no size: the window's own size and shape
    half = await s.image(width=png_size(full)[0] // 2)
    after = (await s.state())["camera"]
    check(before == after, f"save_image moved the camera: {before} -> {after}")
    (w, h), (w2, h2) = png_size(full), png_size(half)
    check(abs(w / h - w2 / h2) < 0.01, f"aspect {w}x{h} vs {w2}x{h2}")
    await s.call("apply", {"atoms": [0], "action": "color", "value": "#ff00ff"})
    pink, _ = count_colour(await s.image(width=320, height=240), lambda r, g, b, a: r > 200 and b > 200 and g < 90)
    check(pink > 20, "the coloured atom does not show")
    await s.call("build_supercell", {"n": [2, 2, 2]})
    grown = (await s.state())["camera"]
    turn = math.degrees(math.acos(max(-1, min(1, sum(a * b for a, b in zip(before["direction"], grown["direction"]))))))
    check(turn < 0.5, f"supercell turned the view by {turn:.2f} deg")
    return f"camera unchanged by save_image, {w}x{h} default, supercell kept direction"


async def edits(s: Session):
    """The user's test session: in-place element changes, a user edit between calls, selection algebra."""
    await s.load_cell(STO, "SrTiO3.vasp", 5)
    # CrysViz remembers per-atom colours per file; an earlier workflow coloured this one.
    await s.call("apply", {"action": "reset_color", "all": True})
    check((await s.state())["structure"]["colors"]["custom"] == [], "reset_color all left custom colours")
    # Neighbours of Ti (index 1) straight from find, no export round trip.
    ti = await s.call("find", {"what": "bonds", "where": {"atoms": [1], "elements": ["Ti", "O"]}})
    check(ti["count"] == 6 and all(item[0] == 1 and abs(item[3] - 1.9525) < 1e-3 for item in ti["items"]),
          f"Ti-O neighbours: {ti}")
    # Polyhedra computed on demand while they are not shown.
    await s.toggle("show polyhedra", False)
    poly = await s.call("find", {"what": "polyhedra", "where": {"center": "Ti"}})
    check(poly["count"] == 1 and "on demand" in poly.get("note", ""), f"on-demand polyhedra: {poly}")
    r0 = (await s.state())["structure"]["revision"]
    oxygens = await s.call("find", {"what": "atoms", "where": {"element": "O"}, "fields": "indices"})
    check(oxygens["atoms"] == [2, 3, 4] and "items" not in oxygens, f"indices output: {oxygens}")
    await s.call("apply", {"atoms": [2], "action": "color", "value": "#ff00ff", "expectedRevision": r0})
    check((await s.state())["structure"]["revision"] == r0, "a colour changed the revision")
    # O -> F in place: same indices and count, the custom colour kept, the other at F's default.
    changed = await s.call("set_element", {"atoms": [2, 3], "element": "F", "expectedRevision": r0})
    st = await s.call("get_state", {"atoms": True})
    elements = [a["element"] for a in st["structure"]["atoms"]]
    check(elements == ["Sr", "Ti", "F", "F", "O"], f"set_element order: {elements}")
    check(changed["revision"] == st["structure"]["revision"] != r0, "set_element did not report the new revision")
    colors = st["structure"]["colors"]
    check(colors["custom"] == [{"color": "#ff00ff", "count": 1, "atoms": [2]}] and "F" in colors["elements"],
          f"colours after set_element: {colors}")
    # The old selection is stale now; an old revision is refused.
    stale = await s.error("apply", {"selection": oxygens["selection"], "action": "highlight"})
    check("SELECTION_STALE" in stale, stale)
    r1 = st["structure"]["revision"]
    await s.call("build_supercell", {"n": [2, 1, 1]})  # what the user might do by hand
    refused = await s.error("remove_atoms", {"atoms": [0], "expectedRevision": r1})
    check("STRUCTURE_CHANGED" in refused and "10 atoms" in refused, refused)
    check((await s.state())["structure"]["atomCount"] == 10, "a refused remove_atoms removed atoms")
    # Selection algebra and position filters.
    fluorine = await s.call("find", {"what": "atoms", "where": {"element": "F"}, "fields": "indices"})
    rest = await s.call("find", {"what": "atoms", "where": {"notIn": fluorine["selection"]}, "fields": "indices"})
    check(fluorine["count"] == 4 and rest["count"] == 6 and not set(rest["atoms"]) & set(fluorine["atoms"]),
          f"notIn: {fluorine} {rest}")
    half = await s.call("find", {"what": "atoms", "where": {"in": fluorine["selection"], "frac": {"min": [0, 0, 0], "max": [0.49, 1, 1]}}})
    check(half["count"] == 2, f"in + frac box: {half}")
    near = await s.call("find", {"what": "atoms", "where": {"near": {"atom": 0, "within": 0.1}}})
    check(near["count"] == 1, f"near: {near}")
    grouped = await s.call("find", {"what": "atoms", "groupBy": "element"})
    check({el: g["count"] for el, g in grouped["groups"].items()} == {"Sr": 2, "Ti": 2, "F": 4, "O": 2}, f"groupBy: {grouped}")
    # reset_color: back to the element colour.
    await s.call("apply", {"selection": fluorine["selection"], "action": "reset_color"})
    check((await s.state())["structure"]["colors"]["custom"] == [], "reset_color left custom colours")
    # run_relax says which pressure it used, and what the name hints.
    await s.load_cell(STO, "SrTiO3_10GPa.vasp", 5)
    relaxed = await s.job("run_relax", {"maxSteps": 3})
    check(relaxed["targetPressureGPa"] == 0 and relaxed["relaxCell"] is True and "10 GPa" in relaxed.get("pressureHint", ""),
          f"run_relax echo: {dict(list(relaxed.items())[:3])}")
    return "set_element in place, revision guard after a supercell, in/notIn/frac/near, reset_color, relax echo"


WORKFLOWS = [
    ("1", "vacancy + relax", w1_vacancy_relax), ("2", "publication figure", w2_figure),
    ("3", "charge density", w3_charge_density), ("4", "diffusion (MD + MSD)", w4_diffusion),
    ("5", "symmetry", w5_symmetry), ("6", "ordering approximants", w6_ordering),
    ("7", "EOS", w7_eos), ("8", "phonon frames", w8_phonons), ("9", "slab", w9_slab),
    ("10", "screening 20 CIFs", w10_screening), ("collab", "shared window", collaboration),
    ("edits", "edits between calls", edits),
]


async def run(server: str, out: Path, only: set[str]) -> int:
    params = StdioServerParameters(command=server, args=["--gui", "qt", "--export-dir", str(out / "exports")],
                                   env=dict(os.environ))
    results = []
    started = time.time()
    async with Client(params, read_timeout_seconds=600) as client:
        s = Session(client, out)
        missing = await s.error("find", {})
        check("find needs: what (atoms | bonds | polyhedra | voids)" in missing, f"missing-argument message: {missing}")
        for key, title, fn in WORKFLOWS:
            if only and key not in only:
                continue
            t0 = time.time()
            try:
                note, ok = await fn(s), True
            except Exception as error:  # noqa: BLE001 - every failure goes in the table
                note, ok = f"{type(error).__name__}: {error}", False
                if not isinstance(error, Failed):
                    traceback.print_exc()
            results.append((key, title, ok, time.time() - t0, note))
            print(f"{'PASS' if ok else 'FAIL'}  {key:>6}  {title:<24} {time.time() - t0:6.1f}s  {note}", flush=True)
    print(f"\n{sum(r[2] for r in results)}/{len(results)} passed in {time.time() - started:.0f}s; files in {out}")
    return 0 if all(r[2] for r in results) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--server", default=str(Path(sys.executable).parent / "crysviz-mcp"))
    parser.add_argument("--out", type=Path, default=None, help="folder for inputs, images and exports")
    parser.add_argument("--only", default="", help="comma-separated keys, e.g. 1,5,collab")
    options = parser.parse_args()
    out = options.out or Path(tempfile.mkdtemp(prefix="crysviz-acceptance-"))
    out.mkdir(parents=True, exist_ok=True)
    only = {k.strip() for k in options.only.split(",") if k.strip()}
    return asyncio.run(run(options.server, out, only))


if __name__ == "__main__":
    raise SystemExit(main())
