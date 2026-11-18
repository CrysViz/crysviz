# Features

The master switches for what the 3D view draws; each feature's own settings are in its window
(Forces, Spins, Fields, Crystal Planes, Polyhedra).

- **Show Atoms**, **Show Bonds**, and **Show Charges**: the oxidation states the file gives, as
  badges by the atoms (the same switch as **Aˣ⁺** in the Structure window).
- **Neighbour Bonds**: also draw the atoms outside the cell that are bonded to atoms inside it.
- **Complete Rings & Fragments**: molecules and rings that cross the cell boundary are drawn whole.
- **Show Polyhedra**, and **Complete Polyhedra**: polyhedra cut by the cell boundary drawn whole.
- **Show Forces** and **Show Spins**: arrows from a file that has them (an OUTCAR, a magnetic
  CIF, …) or from a Relax/MD run. Both can be on at once; since both are arrows, a banner over the
  view then says so.
- **Show Volumetric Field**: charge densities, ELFs and other fields from cube files or VASP
  output. High-resolution fields take a lot of memory.
- **Show Planes**: the planes set up in the Crystal Planes window.
- **Show CIF Errors**: below.

## Show CIF Errors

For a structure read from a CIF together with its errors (the standard uncertainties the file
gives in parentheses; you are asked when the CIF is loaded), measured lengths and angles are
written with their error: `2.3456(12) Å` in the measurement labels and in the Selection and
Polyhedron Inspectors, including the values they derive (mean bond length; polyhedron volume,
distortion index and angle variance). **Show CIF Errors** switches that off (plain values) and on
again; nothing is lost either way. It does nothing for structures loaded without errors. The
Files window's Parameters write the lattice vectors, cell parameters, volume and fractional positions with their
errors too; the Bonds tab, the histograms and the atom tooltip show plain values.
