# Phonons

Load phonopy output and look at the modes: the band structure (with the DOS, if you load it too) opens
in the **Phonon Plots** window in the wide dock on the right, and clicking any point animates that mode
on the atoms in the 3D view. Imaginary modes (negative frequencies) are listed separately, and their
potential-energy surface along the mode can be mapped with the built-in interatomic potentials.

## Files

Drop the files on the 3D view or the Files window (or use Upload) — the format is recognised from the
content, not the name:

- `band.yaml`, `mesh.yaml`, `qpoints.yaml` — frequencies and eigenvectors. Run phonopy with
  `EIGENVECTORS = .TRUE.` (or `--eigvecs`); without eigenvectors the bands are plotted but nothing can
  be animated.
- `total_dos.dat` / `projected_dos.dat` — drawn beside the bands.
- `phonopy.yaml` (`phonopy_disp.yaml`, `phonopy_params.yaml`) — the cells. Needed only for old
  band.yaml files that carry no `lattice`/`points`; on its own it loads as a structure.

**Units.** phonopy writes the cell in the calculator's own length unit and converts nothing in
`band.yaml`: VASP, CASTEP, CP2K and FHI-aims runs are in Å, but QE, abinit, siesta, elk and wien2k runs
are in Bohr. Only `phonopy.yaml` records which (`calculator` and `physical_unit`), so load it alongside
and the unit is picked up automatically. Without it the unit is judged from the geometry: the closest
interatomic contact is compared with the two atoms' radii — read in the right unit it sits near the
radii sum, read as Å when the file is in Bohr nothing touches, read as Bohr when the file is in Å the
atoms overlap — and a dialog shows both readings for you to confirm or override (a molecular crystal
in Bohr is the one genuinely ambiguous case). The **Length unit** selector forces a unit outright and
skips the dialog. Frequencies are THz in every case.

Loading a mode file adds a row `phonon_<file>_1x1x1` to the Files window holding the primitive cell the
eigenvectors refer to, and the phonon data belongs to that row: both windows follow the selected
structure (they close when another structure is shown and come back when the row is selected again),
and several phonopy datasets can be loaded side by side. Rows made from a dataset — mode-map scans and
loaded minima — keep its windows open. The Plots button reopens the plots window after closing it. Change the **Supercell** to see modes away from Γ properly: a mode at q is only
periodic in a supercell where q·n is an integer along every axis, and the panel suggests the smallest
one that works.

## Animation

Each atom moves as u(t) = A · Re[ e / √m · exp(2πi q·r − iωt) ]. **Amplitude** is the largest atomic
excursion in Å (all modes animate with the same visual amplitude and speed — the frequency is on the
axis of the plot, not in the motion). **Arrows** show the displacement pattern at phase zero, with the Forces window's controls: a length
scale (optionally logarithmic), the arrow diameter, and a colour by magnitude, direction or sign with a
colour bar whose range follows the displacements until you edit its limits (Auto Range restores that).
The bar can be dragged out over the scene and is included in image exports. Pause
freezes the atoms where they are, so the displaced structure can be saved with the Download menu;
Stop puts them back.

## Mode map (experimental — open the app with `?experimental`)

Following ModeMap (J. M. Skelton et al.): the selected mode is frozen into a supercell of its own — by
default the smallest one in which its q is periodic, or any size you type — at a series of
amplitudes Q, every structure is evaluated with the active in-browser potential (NEP or PET-MAD, chosen
in the Atomistic window), and U(Q) is fitted with an even polynomial. Q is the normal-mode coordinate
in amu^½·Å, normalised so that Σ m u² = Q²; a harmonic mode then has U = ½ω²Q², and the frequency
fitted from the quadratic term is directly comparable with the phonopy value shown next to it (a good
check of the potential). The Q range is automatic until you type one: for a stable mode it spans a
harmonic energy of 1 meV per atom (well inside the harmonic regime), and for an imaginary mode
**Compute** first probes outward from Q = 0 with a few single points until the energy comes back above
E(0), so the scan brackets the actual well rather than the walls beyond it. **Zoom to minimum**
narrows the range to ±1.8× the minimum for a second, finer pass. The fit order is automatic (the lowest even order that reproduces the points to 1 %) unless you pick one. The table reports the lowest computed
point independently of the fit and flags a fit that does not describe the points. For an imaginary mode the curve is a double well; the panel reports the
minima and the barrier, **Load minimum** adds the deepest minimum as a new structure (relax it from the
Atomistic window to find the distorted phase), and clicking a point in the plot shows that structure.

**Axes.** The plot and the table use the normal-mode coordinate Q by default. ModeMap plots the
phonopy MODULATION amplitude A instead (u = A·Re c/√N, so A = Q·√(N/Σ m |Re c|²)) and energies per
atom; choose "phonopy amplitude" and "meV / atom" under the Q range to compare curves on the same axes.
The typed range is re-expressed when the convention changes, so the scan itself does not move.

**Export structures** downloads the displaced supercells as a POSCAR set with a CSV index (Q, the
equivalent phonopy MODULATION amplitude, the largest displacement and, after a scan, the energies) for
single-point DFT calculations of the same map. It works before a scan too, on the Q range set here.
