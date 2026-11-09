# Selection Inspector

The selected atoms in their own small 3D view, with the bonds between them (by the Bonds-tab
lengths), each bond's length, and every angle between two of those bonds that meet at an atom.
The summary counts the atoms (with their composition), bonds and angles, and gives the mean bond
length. Drag to rotate, scroll to zoom.

Open it with **Inspect** on the Structure window's selection bar (shown whenever atoms are
selected), or search for "Selection Inspector".

## Choosing atoms

It follows the selection in the main 3D view: click an atom, **Shift-click** to add more,
**Ctrl/⌘-click** to remove one, or drag to select a region. Ctrl/⌘-click an atom in the inspector's
own view removes it too.

The **add-neighbour** button at the top (an atom, a faint atom and a +) shows every atom bonded to
the selection faintly; click the ones you want to add them, and press the button again or **Esc** to finish — the
rest disappear. **Add all** takes every neighbour at once. Its **ⓘ** explains the details, including
why some neighbours cannot be added while "Link periodic copies" is on.

While periodic copies are linked, an amber note under the view says so: a selected atom then stands
for all its copies, so a second copy of the same atom (an O on the far face of a cell, say) cannot be
selected beside it. Switch off **Link colors of periodic copies** in the Structure window for exact
copies; the selection is kept.

## The view

The view frames itself when you start on a new set of atoms. Adding or removing atoms, or showing
neighbours, leaves it where you put it; **double-click** to re-centre (on the faint neighbours too
while the tool is on).

## Labels

- **Lengths** and **Angles** show or hide every bond-length or angle label at once.
- **Point at a label** (tap it, on touch) and press the small **×** beside it to hide just that
  one, as on the measurement labels. **Show all labels**
  brings every hidden label back. A hidden label stays hidden while you change the selection, as
  long as its bond or angle is still shown.
- **Move labels** lets you place labels yourself, to keep them clear of each other: while it is on
  the view does not turn, and dragging a label (mouse or finger) moves it. A moved label draws over
  everything, with a thin grey line back to the centre of its bond or the middle of its arc. Press
  **Move labels** again to turn the view again — moved labels stay beside their bond or angle as it
  turns, and keep their place in an export. While placing, each moved label has a **↺** on its
  left that puts just that one back on its bond or angle (no leader, hidden behind atoms again like
  any other label); its **×** stays on the right. **Reset positions** puts
  them all back.
- **Colours** sets the colour of the values, of the length and angle label backgrounds and of the
  angle arcs — for figures, black values on white labels, say. Click a swatch for the colour
  picker; its Reset (or the row's **Reset**) goes back to the default.

## Errors from a CIF

For a CIF loaded with its errors (standard uncertainties — asked when the file is loaded), every
length and angle is written with its error in parentheses, `1.234(5) Å` (1.234 ± 0.005 Å), and so
is the mean bond length (its error propagated through the mean, with shared sites counted
once); the summary then has an **Errors** row. The errors come from the cell and
coordinate errors in the file, and symmetry copies of one atom count as the same atom (the bond
between an atom and its inversion image moves at both ends). An atom moved away from where the
CIF puts it has no error any more. **Show CIF Errors** in the Features window hides them. With
Compare on, each structure's values carry that structure's own errors (when it has them):
`1.234(4)  1.234(5) Å`.

## Comparing with a second structure

**Compare** shows each length and angle in a second structure too — tick that structure in the
Files list (exactly one other), then press Compare. Its **ⓘ** explains how structures are matched,
the status line and the legend.

## Exporting the view

**Export image…** saves the inspector's view through the main image dialog — the same sizes,
aspect, margin, transparent background and PNG or SVG — with the legend drawn on it as on
screen. The SVG embeds the 3D view as an image, with the legend as editable text.

**Background** (next to Export image…) sets the view's background colour — shown in the
inspector as you work, and used for the exported image (white for a paper figure, say); until
you choose one it is the main view's background. Ticking **Transparent background** in the
dialog still gives a transparent image. The Colours row's Reset puts it back.
