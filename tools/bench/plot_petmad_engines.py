#!/usr/bin/env python3
"""PET-MAD evaluation time vs system size for each engine, on one CPU:
PyTorch (metatomic's ASE calculator, as upet's UPETCalculator runs it),
mlip.cpp native, and the CrysViz browser build (wasm) before and after the
graph-allocator fix. Reads the tidy CSV written alongside it.

    python3 tools/bench/plot_petmad_engines.py tools/bench/results/2026-10-25-petmad-engines/engines.csv

Writes engines.png next to the CSV.
"""
import csv
import math
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FixedLocator, FuncFormatter, LogFormatterSciNotation, LogLocator, NullFormatter, NullLocator

# Reference palette (light): categorical slots 1-4, text and chart tokens.
SURFACE, INK, INK2, MUTED = "#fcfcfb", "#0b0b0b", "#52514e", "#898781"
GRID, AXIS = "#e1e0d9", "#c3c2b7"
ENGINES = [  # (key, label, colour, marker) in fixed slot order
    ("pytorch", "PyTorch", "#2a78d6", "o"),
    ("native", "mlip.cpp native", "#eb6834", "s"),
    ("wasm-new", "Browser, new build", "#1baf7a", "^"),
    ("wasm-old", "Browser, old build", "#eda100", "D"),
]

path = Path(sys.argv[1])
rows = list(csv.DictReader(path.open()))
data = defaultdict(list)  # (model, threads, engine) -> [(atoms, ms or None)]
for r in rows:
    sec = float(r["ms"]) / 1000 if r["status"] == "ok" else None
    data[(r["model"], int(r["threads"]), r["engine"])].append((int(r["atoms"]), sec))

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "text.color": INK,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED,
    "axes.facecolor": SURFACE, "figure.facecolor": SURFACE,
})
fig, axes = plt.subplots(2, 2, figsize=(11.5, 8.6), sharex=True, sharey=True)
fig.subplots_adjust(left=0.08, right=0.98, top=0.815, bottom=0.1, hspace=0.22, wspace=0.06)
ATOMS = sorted({int(r["atoms"]) for r in rows})
YMIN, YMAX = 0.05, 200  # seconds

for col, model in enumerate(["xs", "s"]):
    for row, threads in enumerate([1, 4]):
        ax = axes[row][col]
        ax.set_xscale("log"); ax.set_yscale("log")
        ax.set_xlim(ATOMS[0] / 1.35, ATOMS[-1] * 4.2)  # room for the end labels
        ax.set_ylim(YMIN, YMAX)
        ax.grid(True, which="major", axis="both", color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ends = []  # (atoms, ms, label) at each line's end, placed after all lines
        for key, label, colour, marker in ENGINES:
            pts = sorted(data.get((model, threads, key), []))
            ok = [(a, ms) for a, ms in pts if ms is not None]
            if ok:
                xs, ys = zip(*ok)
                ax.plot(xs, ys, color=colour, linewidth=2, marker=marker, markersize=7.5,
                        markeredgecolor=SURFACE, markeredgewidth=1.5, solid_capstyle="round", zorder=3)
                # Direct labels in the first panel only, where the lines end apart;
                # the legend above names them everywhere.
                if key != "wasm-old" and (row, col) == (0, 0):
                    ends.append((xs[-1], ys[-1], label.replace("Browser, ", "browser, ")))
            # Sizes the build could not evaluate (wasm out of memory): a cross on the top band.
            for a in [a for a, ms in pts if ms is None]:
                ax.plot([a], [YMAX], marker="X", markersize=9, color=colour,
                        markeredgecolor=SURFACE, markeredgewidth=1.2, zorder=4, clip_on=False)
        # Direct labels at the line ends, in text ink; nudged apart (at least
        # MIN_GAP decades) with a thin leader where lines end close together.
        MIN_GAP = 0.12
        ends.sort(key=lambda e: math.log10(e[1]))
        placed = []
        for x, y, text in ends:
            ly = math.log10(y)
            if placed and ly - placed[-1] < MIN_GAP:
                ly = placed[-1] + MIN_GAP
            placed.append(ly)
            lx = x * 1.22
            if abs(ly - math.log10(y)) > 0.02:
                ax.plot([x * 1.07, lx * 0.97], [y, 10 ** ly], color=AXIS, linewidth=0.8, zorder=2)
            ax.text(lx, 10 ** ly, text, va="center", fontsize=8.5, color=INK2)
        ax.set_title(f"PET-MAD {model.upper()} stand-in · {threads} thread{'s' if threads > 1 else ''}",
                     loc="left", fontsize=11, color=INK, pad=8)
        ax.xaxis.set_major_locator(FixedLocator(ATOMS))
        ax.xaxis.set_minor_locator(NullLocator())
        ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{int(v)}"))
        ax.yaxis.set_major_locator(LogLocator(base=10))
        ax.yaxis.set_minor_locator(LogLocator(base=10, subs=range(2, 10)))
        ax.yaxis.set_major_formatter(LogFormatterSciNotation(base=10))
        ax.yaxis.set_minor_formatter(NullFormatter())
        if row == 1:
            ax.set_xlabel("atoms (YBCO supercell)")
        if col == 0:
            ax.set_ylabel("time per evaluation (s)")

# Legend: its own row between the subtitle and the panels, flush with the panels' left edge.
handles = [plt.Line2D([], [], color=c, marker=m, linewidth=2, markersize=7.5, markeredgecolor=SURFACE)
           for _, _, c, m in ENGINES]
fig.legend(handles, [e[1] for e in ENGINES], loc="lower left", bbox_to_anchor=(0.072, 0.878), ncol=4,
           frameon=False, fontsize=10, labelcolor=INK2, handlelength=2.4, columnspacing=2.4,
           borderaxespad=0, borderpad=0)
fig.text(0.08, 0.872, "\u00d7  on the top edge of a panel: that build ran out of memory at that size (no result)",
         fontsize=9, color=MUTED, va="top")
fig.text(0.08, 0.965, "PET-MAD: time per evaluation vs system size, by engine", fontsize=14, color=INK, weight="bold")
fig.text(0.08, 0.932, "Energy + forces + stress, same 4-core CPU (Xeon, AVX-512), same model weights and structures. "
         "Lower is better.", fontsize=9.5, color=INK2)
fig.text(0.08, 0.012, "Random-weight PET models at the published file sizes (XS 4.4 M, S 25 M parameters), exported with "
         "mlip.cpp's export_pet_gguf.py; the real models are lighter,\nso absolute times differ. Browser = mlip.cpp compiled "
         "to WebAssembly (the CrysViz build), run in Node 22. Old build = before the graph-allocator fix.",
         fontsize=8, color=MUTED, linespacing=1.4)
out = path.with_name("engines.png")
fig.savefig(out, dpi=160)
print(out)
