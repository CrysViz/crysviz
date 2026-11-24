# Bond Length Histogram

One low-profile bar chart per bond species pair (Y-O, Cu-O, Ba-O, ...), plus an **All Pairs**
combined chart in which every pair is a segment of each bin's stacked bar — all in one scrollable
list. Every card starts collapsed to just its header; click its ▾ to expand, or **Expand All**/**Collapse
All** for all of them at once. **Bin width** at the top sets the bin width for every card; faint
lines mark the bin edges. Drag a card's own slider (under its chart) to give just that card a custom
view — the ↺ button resets it. Each card's 🌓 switches just that chart between dark and light,
📥 saves it as a PNG and ⛶ expands it. Drag a chart's bottom-right corner to make it taller.

Click a bar (or a pair's segment of it) to highlight the bonds it represents in the 3D view; the
bar gets an outline in every card that shows it. Click it again to clear; clearing the highlight
anywhere else (a click on empty space in 3D, another selection) removes the outline too. Hover a bar to see the
bin's range and the actual bonds in it. Turn on **Show distances** to also drop a floating Å label
on each highlighted bond.

**Group by Wyckoff** — activate Wyckoff mode to use this feature (Symmetry window → **Enable
Wyckoff Editor**, or keep a CIF's symmetry when loading it); until then the toggle is greyed out.
Each element pair then splits into
its pairs of crystallographic sites, named as in the Structure panel's Wyckoff tab, e.g.
*Cu1 (2q) – O2 (2s)*. A site pair is drawn in a shade of its element pair's colour and listed under
it in the legend.

When the structure was read from a CIF with its errors (and **Show CIF Errors** is on), the
bond lengths in the hover list and the distance labels carry their standard uncertainty, e.g.
1.6047(17) Å.

Opened with **Open** next to *Bond Length* under **Histograms** in the Bonds window. It opens in
the wide dock on the right of the 3D scene; like any window, it can be dragged out to float, or
into the left bar.
