# Measure

Turn on a measure tool in the toolbar over the 3D view, then click atoms:

- **Distance**: two atoms, the distance between them.
- **Angle**: three atoms, the angle at the middle one.

Turn the tool off with its button when done. An atom's element and coordinates are in the
selection bar's **Coordinates** once the atom is selected (double-click it with the tool off).

Click a highlighted atom again to remove it from the measurement you are making (a double-click
counts as one click); click empty space to drop all of them. Another periodic image of the same
atom is not highlighted: clicking it adds it as one more atom.

**With atoms selected.** Turning a measure tool on takes the selection's highlight off (only the
atoms you click for the measurement glow); the selection is kept, and its highlight comes back when
the tool is turned off. A measurement whose atoms are all in the Selection or Polyhedron Inspector
is drawn there too (its **Measured** switch).

**Errors from a CIF.** For a CIF loaded with its errors (standard uncertainties), each distance
and angle is written with its error in parentheses, as in a crystallographic paper:
`2.3456(12) Å` means 2.3456 ± 0.0012 Å. The error comes from the cell and coordinate errors the
file gives (symmetry copies of one atom count as the same atom). A measurement shows no error once
one of its atoms has been moved, or the cell changed (a supercell keeps them), from what the CIF
gives. **Show CIF Errors** in the Features window hides or shows them. Errors are shown in the
measurement labels, the Selection and Polyhedron Inspectors, the Files window's Parameters
(lattice vectors, cell, volume, fractional positions) and the Bond Length Histogram (its hover
list and **Show distances** labels) — not in the Bonds tab or the other histograms.
