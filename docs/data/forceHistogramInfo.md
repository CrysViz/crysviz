# Force Histogram

A live |F| (force magnitude) distribution for the current structure: one stacked bar per bin, a
segment per species. Drag **Bin width** to change the bin width and **Max |F|** to change the
plotted range; faint lines mark the bin edges. Hover a bar for its range and atom count. Click a
bar (or a species' segment of it) to highlight those atoms in the 3D view and outline the bar —
click it again to clear the highlight. Clearing it anywhere else removes the outline too.

**Group by Wyckoff** — activate Wyckoff mode to use this feature (Symmetry window → **Enable
Wyckoff Editor**, or keep a CIF's symmetry when loading it); until then the toggle is greyed out.
It gives one segment per
crystallographic site (e.g. *O2 (2s)*) instead of per element, drawn in shades of the element's
colour. Atoms on one site carry the same force under the symmetry lock, and sites fixed by
symmetry carry none.
