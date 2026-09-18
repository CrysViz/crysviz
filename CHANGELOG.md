# Changelog

## Unreleased

## 0.10.0

### Highlights

- **Phonopy support:** load `band.yaml`, `mesh.yaml` or `qpoints.yaml` (plus `total_dos.dat`/`projected_dos.dat` and `phonopy.yaml`) to get the band structure and DOS in a new Phonon Plots window. Click any point to animate that mode on the atoms, with displacement arrows and a suggested supercell for modes away from Γ. Å/Bohr length units are detected automatically. Mode-map energy scans are experimental and only appear when you open the app with `?experimental`.
- **New file formats:** CASTEP `.cell` files and `.geom`/`.md`/`.ts` trajectories (with per-frame energy, forces and stress), SHELX/AIRSS `.res` files (including many structures in one file), and FHI-aims `geometry.in` and `aims.out` (relaxation/MD trajectory, forces, spin moments). File types are now recognised from the file contents, not only the file name.
- **More export formats:** CIF (plain P1, or symmetrised with a tolerance preview), CASTEP `.cell`, FHI-aims `geometry.in`, and Quantum ESPRESSO structural cards you can copy.
- **Focus Regions:** fade everything outside a sphere around selected atoms, a molecule or a defect, with a soft radial edge, exclusions and a "Select inner atoms" action. Bonds, polyhedra, spins, forces and volumetric fields all follow the region, and regions are remembered per structure.
- **Load from online databases:** paste an OPTIMADE structure URL or an Alexandria ID (`agm…`) to fetch the structure directly.
- **Embeddable widget mode** (`?widget=1`): a structure-only view for embedding in other web pages. It includes a compact menu, a conventional/primitive cell switch, bond and polyhedra toggles, a light or dark theme, and an "Open in CrysViz" link.
- **Faster, lighter trajectories:** large multi-frame OUTCARs are read in the background and loaded frame by frame, so they use far less memory. Smooth trajectories play back by moving atoms and bonds in place, and there is a new "max" playback speed.
- **Fields, spins and forces:** volumetric fields, spin arrows and force arrows now repeat across an extended cell boundary. You can type an exact isosurface level. Spin arrows can be scaled automatically and have an arrowhead-length slider.

### Fixes

- Wyckoff mode: the "Add Site" dropdown no longer gets stuck on "free" for some cells (for example NaCl, primitive or conventional).
- POSCAR files with a negative scale factor (a target cell volume) now load with the correct cell, and Cartesian coordinates are scaled together with the lattice.
- WBOIT transparency mode no longer loses anti-aliasing when the scene is fully opaque, and the change from opaque to slightly transparent is smoother.
- Custom atom colours are once again kept after a browser reload.
- Isosurfaces no longer show artifacts at full opacity, and fields render correctly when a supercell is combined with an extended cell boundary.
- Spin and force arrows no longer vanish when zooming in after changing the cell boundary, and magnetic moments from mCIF files load correctly again.
- Playing long trajectories no longer makes memory use grow steadily.

## 0.1.0

Initial public release of CrysViz.
