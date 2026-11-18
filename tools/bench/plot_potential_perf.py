#!/usr/bin/env python3
"""Figures for the interatomic-potential performance map.

Input: the JSON written by tools/browsertest/tests/potentialperf.bench.js.
Output: four PNG figures (and a CSV table) in OUT_DIR.

    python3 tools/bench/plot_potential_perf.py potentialperf.json OUT_DIR ["note on the PET-MAD models"]

Colour follows the potential family (NEP blue, PET-MAD-XS orange, PET-MAD-S
aqua; the first three slots of the validated reference palette, distinct for
every pair incl. colour-vision deficiency); line style marks how it runs
(solid = multi-threaded worker, dashed = one thread in a worker, dash-dot =
WebGPU, dotted = on the main thread). Viewer options form an ordered ladder and use one blue ramp.
Every line is direct-labelled and the CSV is the table view.
"""
import csv
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter  # noqa: E402

# ---- design tokens (reference palette, light mode) -------------------------
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
VIOLET, MAGENTA, GRAY = "#6250d6", "#e87ba4", "#c3c2b7"
RAMP = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"]  # ordinal, light -> dark

SERIES = {
    "nep": dict(label="NEP89", short="NEP89", color=BLUE, ls="-", marker="o"),
    "xsmt": dict(label="PET-MAD-XS · multi-thread", short="XS · MT", color=ORANGE, ls="-", marker="s"),
    "xs1": dict(label="PET-MAD-XS · 1 thread", short="XS · 1T", color=ORANGE, ls="--", marker="s"),
    "xsgpu": dict(label="PET-MAD-XS · WebGPU", short="XS · GPU", color=ORANGE, ls="-.", marker="s"),
    "xsmain": dict(label="PET-MAD-XS · main thread", short="XS · main", color=ORANGE, ls=":", marker="s"),
    "smt": dict(label="PET-MAD-S · multi-thread", short="S · MT", color=AQUA, ls="-", marker="D"),
    "s1": dict(label="PET-MAD-S · 1 thread", short="S · 1T", color=AQUA, ls="--", marker="D"),
    "sgpu": dict(label="PET-MAD-S · WebGPU", short="S · GPU", color=AQUA, ls="-.", marker="D"),
}
ORDER = ["nep", "xsmt", "xs1", "xsgpu", "xsmain", "smt", "s1", "sgpu"]
VISUALS = ["atoms", "bonds", "images", "force"]
VIS_LABEL = {
    "atoms": "Atoms only",
    "bonds": "+ bonds",
    "images": "+ periodic images",
    "force": "+ force colour map",
}

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9.5,
    "axes.edgecolor": AXIS,
    "axes.labelcolor": INK2,
    "axes.titlecolor": INK,
    "axes.titlesize": 10.5,
    "axes.titleweight": "bold",
    "axes.titlelocation": "left",
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "xtick.labelcolor": INK2,
    "ytick.labelcolor": INK2,
    "axes.grid": True,
    "grid.color": GRID,
    "grid.linewidth": 0.8,
    "axes.axisbelow": True,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "figure.facecolor": SURFACE,
    "axes.facecolor": SURFACE,
    "savefig.facecolor": SURFACE,
    "legend.frameon": False,
    "lines.linewidth": 2.0,
    "lines.markersize": 5.5,
})


def plain_number(v, _pos=None):
    if v >= 1:
        return f"{v:g}"
    return f"{v:.2g}"


def log_axis(ax, axis="both"):
    fmt = FuncFormatter(plain_number)
    if axis in ("x", "both"):
        ax.set_xscale("log")
        ax.xaxis.set_major_formatter(fmt)
        ax.xaxis.set_minor_formatter(NullFormatter())
    if axis in ("y", "both"):
        ax.set_yscale("log")
        ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0)))
        ax.yaxis.set_major_formatter(fmt)
        ax.yaxis.set_minor_formatter(NullFormatter())


def size_ticks(ax, sizes):
    """Ticks at the measured cell sizes (log x axis)."""
    ax.set_xticks(sizes)
    ax.set_xticklabels([str(n) for n in sizes])
    ax.xaxis.set_minor_formatter(NullFormatter())
    ax.tick_params(axis="x", which="minor", length=0)


def model_note(meta):
    """What the PET-MAD curves were measured with (meta.pet_models, set by
    whoever made the run; the headless sandbox bench used stand-ins)."""
    return meta.get("pet_models") or "PET-MAD: the published GGUF models"


def footer(fig, meta, extra=""):
    text = (f"MD through the CrysViz MD panel · headless Chromium, software WebGL · "
            f"{meta.get('cpus')} CPU cores · {meta.get('date', '')[:10]}")
    if extra:
        text += " · " + extra
    fig.text(0.01, 0.005, text, fontsize=7.5, color=MUTED, ha="left", va="bottom")


def series_points(records, pot, vis, key):
    pts = sorted(((r["atoms"], r.get(key)) for r in records
                  if r["potential"] == pot and r["visual"] == vis
                  and isinstance(r.get(key), (int, float)) and r.get(key) == r.get(key)),
                 key=lambda t: t[0])
    return [p[0] for p in pts], [p[1] for p in pts]


def end_label(ax, xs, ys, text, color, dy=0):
    if not xs:
        return
    ax.annotate(text, (xs[-1], ys[-1]), xytext=(6, dy), textcoords="offset points",
                fontsize=8, color=INK2, va="center", ha="left",
                annotation_clip=False)
    ax.plot([xs[-1]], [ys[-1]], marker="o", ms=3, color=color, zorder=5)


# ---- figure 1: throughput -------------------------------------------------
def fig_throughput(records, meta, out):
    fig, axes = plt.subplots(1, 4, figsize=(15, 4.6), sharey=True)
    for ax, vis in zip(axes, VISUALS):
        for pot in ORDER:
            xs, ys = series_points(records, pot, vis, "stepsPerS")
            if not xs:
                continue
            s = SERIES[pot]
            ax.plot(xs, ys, ls=s["ls"], marker=s["marker"], color=s["color"], label=s["label"],
                    markeredgecolor=SURFACE, markeredgewidth=1.2)
        log_axis(ax)
        size_ticks(ax, sorted({r["atoms"] for r in records}))
        ax.set_title(VIS_LABEL[vis])
        ax.set_xlabel("atoms in the cell")
    axes[0].set_ylabel("MD steps per second")
    # direct labels on the right-most panel only (same series everywhere)
    ax = axes[-1]
    placed = []
    for pot in ORDER:
        xs, ys = series_points(records, pot, VISUALS[-1], "stepsPerS")
        if xs:
            placed.append((ys[-1], pot, xs, ys))
    placed.sort()
    last_y = None
    for y, pot, xs, ys in placed:
        dy = 0
        if last_y and abs((y / last_y) - 1) < 0.25:
            dy = 9
        end_label(ax, xs, ys, SERIES[pot]["short"], SERIES[pot]["color"], dy=dy)
        last_y = y
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=6, bbox_to_anchor=(0.5, 1.0),
               fontsize=8.5, handlelength=2.6)
    fig.suptitle("MD throughput by potential, cell size and viewer options",
                 x=0.01, y=0.93, ha="left", fontsize=13, fontweight="bold", color=INK)
    fig.tight_layout(rect=(0, 0.03, 0.96, 0.9))
    footer(fig, meta, "higher is better · " + model_note(meta))
    fig.savefig(out / "1_throughput.png", dpi=170)
    plt.close(fig)


# ---- figure 2: where the time of one step goes -----------------------------
def fig_breakdown(records, meta, out):
    """100 % bars: the share of one MD step spent waiting for the potential,
    updating the viewer, and on everything else; the step's total time is
    written at the end of each bar. One fixed row order for every panel, so a
    configuration missing from a panel leaves its row empty."""
    sizes = sorted({r["atoms"] for r in records})
    pots = [p for p in ORDER if any(r["potential"] == p for r in records)]
    ys = {p: len(pots) - 1 - i for i, p in enumerate(pots)}
    fig, axes = plt.subplots(2, len(sizes), figsize=(15, 6.4), sharey=True, squeeze=False)
    for row, vis in enumerate(["bonds", "force"]):
        for col, n in enumerate(sizes):
            ax = axes[row][col]
            for pot in pots:
                r = next((r for r in records if r["potential"] == pot and r["atoms"] == n and r["visual"] == vis), None)
                if not r:
                    continue
                total = r.get("msPerStep") or 0
                if total <= 0:
                    continue
                force = min(total, r.get("forceMs") or 0)
                viewer = min(total - force, r.get("viewerMs") or 0)
                other = max(0.0, total - force - viewer)
                left = 0.0
                for val, color, name in ((force, VIOLET, "waiting for the potential"),
                                         (viewer, MAGENTA, "viewer update"),
                                         (other, GRAY, "everything else (yield, plot, save, render)")):
                    share = 100.0 * val / total
                    ax.barh(ys[pot], share, left=left, height=0.62, color=color, edgecolor=SURFACE, linewidth=1.5,
                            label=name if (row == 0 and col == 0 and pot == pots[0]) else None)
                    left += share
                label = f"{total / 1000:.1f} s" if total >= 1000 else f"{total:.0f} ms"
                ax.text(101.5, ys[pot], label, va="center", ha="left", fontsize=7.5, color=INK2)
            ax.set_xlim(0, 100)
            ax.set_xticks([0, 50, 100])
            ax.set_xticklabels(["0", "50", "100 %"])
            ax.grid(axis="y", visible=False)
            ax.set_yticks([ys[p] for p in pots])
            ax.set_yticklabels([SERIES[p]["short"] for p in pots])
            if row == 0:
                ax.set_title(f"{n} atoms")
            if row == 1:
                ax.set_xlabel("share of one MD step")
        axes[row][0].set_ylabel(VIS_LABEL[vis], fontsize=10, color=INK, fontweight="bold")
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, bbox_to_anchor=(0.5, 1.0), fontsize=8.5)
    fig.suptitle("Where one MD step's time goes (total per step at the bar end)",
                 x=0.01, y=0.94, ha="left", fontsize=13, fontweight="bold", color=INK)
    fig.tight_layout(rect=(0, 0.03, 0.97, 0.91), w_pad=3.5)
    footer(fig, meta, "the viewer runs while the worker computes, so 'everything else' includes waiting for it")
    fig.savefig(out / "2_step_breakdown.png", dpi=170)
    plt.close(fig)


# ---- figure 3: cost of the viewer options ----------------------------------
def fig_viewer(records, meta, out):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.6))
    # left: viewer ms per step vs atoms (median over potentials: the viewer
    # does the same work whichever potential produced the frame)
    sizes = sorted({r["atoms"] for r in records})
    for vis, color in zip(VISUALS, RAMP):
        xs, ys = [], []
        for n in sizes:
            vals = sorted(r["viewerMs"] for r in records
                          if r["atoms"] == n and r["visual"] == vis and isinstance(r.get("viewerMs"), (int, float)))
            if vals:
                xs.append(n)
                ys.append(vals[len(vals) // 2])
        ax1.plot(xs, ys, color=color, marker="o", markeredgecolor=SURFACE, markeredgewidth=1.2,
                 label=VIS_LABEL[vis])
        end_label(ax1, xs, ys, VIS_LABEL[vis], color)
    log_axis(ax1)
    size_ticks(ax1, sizes)
    ax1.set_title("Viewer update per MD step")
    ax1.set_xlabel("atoms in the cell")
    ax1.set_ylabel("ms per step (median over potentials)")
    ax1.margins(x=0.08)
    # right: slowdown of NEP vs atoms-only (where the viewer matters)
    pot = "nep"
    for vis, color in zip(VISUALS[1:], RAMP[1:]):
        xs, ys = [], []
        for n in sizes:
            base = next((r for r in records if r["potential"] == pot and r["atoms"] == n and r["visual"] == "atoms"), None)
            cur = next((r for r in records if r["potential"] == pot and r["atoms"] == n and r["visual"] == vis), None)
            if base and cur and base.get("stepsPerS") and cur.get("stepsPerS"):
                xs.append(n)
                ys.append(cur["stepsPerS"] / base["stepsPerS"])
        ax2.plot(xs, ys, color=color, marker="o", markeredgecolor=SURFACE, markeredgewidth=1.2)
        end_label(ax2, xs, ys, VIS_LABEL[vis], color)
    ax2.axhline(1.0, color=AXIS, lw=1)
    ax2.set_xscale("log")
    size_ticks(ax2, sizes)
    ax2.set_ylim(0, 1.15)
    ax2.set_title("NEP89: throughput relative to 'atoms only'")
    ax2.set_xlabel("atoms in the cell")
    ax2.set_ylabel("steps/s ÷ steps/s with atoms only")
    ax2.margins(x=0.08)
    fig.suptitle("What the viewer options cost", x=0.01, y=0.97, ha="left", fontsize=13,
                 fontweight="bold", color=INK)
    fig.tight_layout(rect=(0, 0.03, 0.93, 0.93))
    footer(fig, meta, "software WebGL exaggerates render cost compared with a GPU")
    fig.savefig(out / "3_viewer_options.png", dpi=170)
    plt.close(fig)


# ---- figure 4: threads and the worker ---------------------------------------
def fig_threads(records, meta, out):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.6))
    sizes = sorted({r["atoms"] for r in records})
    for one, multi in (("xs1", "xsmt"), ("s1", "smt")):
        xs, ys = [], []
        for n in sizes:
            a = [r["forceMs"] for r in records if r["potential"] == one and r["atoms"] == n
                 and isinstance(r.get("forceMs"), (int, float))]
            b = [r["forceMs"] for r in records if r["potential"] == multi and r["atoms"] == n
                 and isinstance(r.get("forceMs"), (int, float))]
            if a and b:
                a.sort()
                b.sort()
                xs.append(n)
                ys.append(a[len(a) // 2] / b[len(b) // 2])
        s = SERIES[multi]
        if not xs:
            continue
        ax1.plot(xs, ys, color=s["color"], marker=s["marker"], markeredgecolor=SURFACE, markeredgewidth=1.2)
        end_label(ax1, xs, ys, "PET-MAD-XS" if one == "xs1" else "PET-MAD-S", s["color"])
    ax1.axhline(1.0, color=AXIS, lw=1)
    if len(ax1.lines) > 1:  # the y = 1 reference line is always there
        ax1.set_xscale("log")
        size_ticks(ax1, sizes)
    ax1.set_ylim(bottom=0)
    ax1.set_title(f"Multi-thread speed-up of a force evaluation ({meta.get('cpus')} cores)")
    ax1.set_xlabel("atoms in the cell")
    ax1.set_ylabel("time on 1 thread ÷ time multi-threaded")
    ax1.margins(x=0.1)

    for pot in ("xsmain", "xs1", "nep"):
        xs, ys = [], []
        for n in sizes:
            vals = [r["longestGapMs"] for r in records if r["potential"] == pot and r["atoms"] == n
                    and isinstance(r.get("longestGapMs"), (int, float))]
            if vals:
                xs.append(n)
                ys.append(max(vals))
        s = SERIES[pot]
        if not xs:
            continue
        ax2.plot(xs, ys, color=s["color"], ls=s["ls"], marker=s["marker"], markeredgecolor=SURFACE,
                 markeredgewidth=1.2)
        end_label(ax2, xs, ys, s["label"], s["color"])
    if ax2.lines:
        log_axis(ax2)
        size_ticks(ax2, sizes)
    ax2.set_title("Longest page freeze during an MD run")
    ax2.set_xlabel("atoms in the cell")
    ax2.set_ylabel("ms without a 16 ms timer tick (max over viewer options)")
    ax2.margins(x=0.1)
    fig.suptitle("Threads and the worker", x=0.01, y=0.97, ha="left", fontsize=13,
                 fontweight="bold", color=INK)
    fig.tight_layout(rect=(0, 0.03, 0.9, 0.93))
    footer(fig, meta)
    fig.savefig(out / "4_threads_worker.png", dpi=170)
    plt.close(fig)


def write_csv(records, out):
    cols = ["potentialLabel", "atoms", "drawnAtoms", "bonds", "visualLabel", "steps", "stepsPerS", "msPerStep",
            "forceMs", "viewerMs", "plotMs", "saveMs", "waitMs", "fastFrames", "fullFrames", "threads",
            "variant", "longestGapMs", "evalMs"]
    with open(out / "potential_perf.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in sorted(records, key=lambda r: (ORDER.index(r["potential"]), r["atoms"], VISUALS.index(r["visual"]))):
            w.writerow([round(r[c], 3) if isinstance(r.get(c), float) else r.get(c) for c in cols])


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    data = json.loads(src.read_text())
    records = [r for r in data["records"] if r.get("finished") and r.get("potential") in SERIES
               and isinstance(r.get("atoms"), int)]
    # steps/s from the per-step wall time where it is known: the console
    # profile rounds steps/s to one decimal (0.0 for a 30 s step).
    for r in records:
        ms = r.get("msPerStep")
        if isinstance(ms, (int, float)) and ms > 0:
            r["stepsPerS"] = 1000.0 / ms
    meta = data.get("meta", {})
    if len(sys.argv) > 3:
        meta["pet_models"] = sys.argv[3]
    fig_throughput(records, meta, out)
    fig_breakdown(records, meta, out)
    fig_viewer(records, meta, out)
    fig_threads(records, meta, out)
    write_csv(records, out)
    print(f"{len(records)} records -> {out}")


if __name__ == "__main__":
    main()
