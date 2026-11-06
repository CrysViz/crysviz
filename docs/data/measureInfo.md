# Measure

Click atoms in the 3D view to measure distances, angles and dihedrals between them.

- **1 atom**: shows its element and fractional/cartesian coordinates.
- **2 atoms**: distance between them.
- **3 atoms**: angle at the middle atom.
- **4 atoms**: dihedral angle.

Click a highlighted atom again to remove it from the current measurement.

**Errors from a CIF.** For a CIF loaded with its errors (standard uncertainties), each distance
and angle is written with its error in parentheses, as in a crystallographic paper:
`2.3456(12) Å` means 2.3456 ± 0.0012 Å. The error comes from the cell and coordinate errors the
file gives (symmetry copies of one atom count as the same atom). A measurement shows no error once
one of its atoms has been moved, or the cell changed (a supercell keeps them), from what the CIF
gives. **Show CIF Errors** in the Features window hides or shows them. Errors are shown in the
measurement labels and the Selection and Polyhedron Inspectors only — not in the Bonds tab, the
histograms, the atom tooltip or the Files window's Parameters.
