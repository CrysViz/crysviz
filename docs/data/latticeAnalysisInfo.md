# Lattice Analysis

Plots the unit-cell parameters — the lengths a, b, c and the angles α, β, γ — of a set of
structures, so a relaxation, a pressure scan or a series of separately loaded files can be read
off as "how did the cell change". **Show plots** opens them in a separate Lattice Plots window
in the wide dock on the right of the 3D scene: one card with a, b, c, one with all three angles,
and one card per angle. Like any window, the plots can be dragged out to float or into the left
bar; drag a plot's bottom-right corner to change its height (as in the Bond Length Histogram).

The table lists each parameter for the frame on screen and its range over all points. Select
values to copy them, **Copy table** copies the whole table as tab-separated text (pastes into a
spreadsheet), and **Export CSV** downloads every plotted point with its cell parameters, energy,
max force, pressure and volume.

**Points** chooses what is plotted:

- *Selected trajectory* — every frame of the selected file (needs 2+ frames).
- *Checked structures* — the rows ticked in the Files table, each at the frame its step box
  currently shows. Tick two or more rows to compare separately loaded structures.

Every plot is wired to the viewer: click a point to show that frame (and row), and the point
currently on screen is ringed in each plot.

**Sort by** orders the points and becomes the x axis: the points' own order (frame number, or
Files-table order), the file name, or a per-frame property — energy, max force, pressure
(stress trace / 3, as in the Trajectory plot) or volume. Entries none of the points carry are
greyed out.

**Custom x axis** lets you type your own value for each point instead — the pressure of each
point of a scan, a temperature ramp — together with a label and a unit; the plots are then drawn
against those values (sorted) and the axis is titled accordingly, e.g. "Pressure (GPa)". It
overrides Sort by until cleared, and is remembered per trajectory while it is loaded.
