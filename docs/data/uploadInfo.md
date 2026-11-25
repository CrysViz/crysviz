# Opening files


The most important information is that CrysViz is mainly a static html page using the resources from your computer. Nothing leaves your computer unless you connect a compute server yourself (ASE in the Atomistic window). This means that the structures you open are stored in the temporary browser storage on **your computer**. Reloading the website will remove the data. Clearing browser history will make sure no data is left.

Currently it is possible to view the following file types: 

- **VASP**:
    - POSCAR: structure only.
    - OUTCAR: structure, forces, and spin for the complete trajectory of a MD or relaxation.
    - INCAR: magnetic moments only. Load the structure first, select it, then load the INCAR (the file name must contain `INCAR`): its `MAGMOM` is read together with `LNONCOLLINEAR`/`LSORBIT` and `SAXIS` — one signed moment per atom for a collinear run, a 3-vector per atom for a non-collinear one, repeat counts such as `4*1.5` included — and, after you confirm, replaces the structure's spins. The number of values must fit the selected structure. A `MAGMOM` written with variables (`m -m`) can be loaded with the variables set to unit magnitude.

- **Quantum Espresso**:
    - Input file: structure only.
    - Output vc relax: structure forces, stress, spin for the complete trajectory.
    - Output relax: not implemented at the moment 
    - Output md: implemented but experimental

- **CIF** and magnetic **mCIF**: CrysViz provides a CIF reader. A CIF that declares a space group
  asks whether to keep its symmetry (Wyckoff editor), symmetrise, or load it as a plain structure.
  A CIF or mCIF that gives **errors** (standard uncertainties, the digits in parentheses:
  `5.4307(2)`) for its cell or coordinates also asks whether to read them — a tick box in the
  symmetry dialog (ticked unless you said no last time), or a dialog of its own for a CIF without
  symmetry and for an mCIF. With the errors read, measured lengths and angles (the measurement
  labels, the Selection and Polyhedron Inspectors, the Bond Length Histogram's hover list and
  distance labels) are written with their error, `2.3456(12) Å`,
  and so are the cell parameters and positions in **Parameters** below;
  **Show CIF Errors** in the Features window hides them again. The errors are kept in a supercell
  and saved with a `.crysviz` file or a share link.
  Partially occupied and mixed sites (`_atom_site_occupancy`) are saved with a `.crysviz` file or a
  share link too: occupancies, oxidation states and per-species colours.

- **CASTEP**:
    - `.cell` input file: structure only (reads `LATTICE_CART`/`LATTICE_ABC` and `POSITIONS_FRAC`/`POSITIONS_ABS`). An AIRSS `buildcell` seed with absolute positions and no lattice loads as a molecule in a centered box.
    - `.geom` (geometry optimization), `.md` (molecular dynamics) and `.ts` (transition-state search): the full trajectory with per-frame energy, forces and stress (pressure).
    - The `.param` file holds run settings only and carries no structure.

- **SHELX / AIRSS `.res`**: structure only. A single `.res` may hold many structures back to back (e.g. an AIRSS search dump); they load as a stepped set you can page through, with each candidate's enthalpy shown as its energy.

- **.xyz and .exzy format**: Currently under implementation

- **ASE trajectory (`.traj`)**: the frames ASE writes (MD runs, relaxations, MLIP trajectories), with per-frame cell, energy, forces, stress and magnetic moments. A frame without a cell (a molecule) loads in a centered box.

- **FHI-aims**:
    - `geometry.in`: structure and magnetism (`initial_moment`, collinear or non-collinear). A non-periodic geometry loads as a molecule in a centered box.
    - `aims.out` output: the full relaxation/MD trajectory with per-frame energy and forces, plus per-atom spin moments when the Mulliken analysis is present.

## Selection menu (≡)

The ≡ button at the top left of the structure list acts on the rows whose boxes are ticked:

- **Deselect** and **Select all** untick or tick every row.
- **Make Trajectory** joins the frames of two or more ticked rows, in list order, into one new
  trajectory row.
- **Average Structure** makes one new structure whose atomic positions and cell are the mean over
  every frame of the ticked rows: the time-averaged structure of an MD run (tick its row alone), or
  the mean of several structures. Atoms are matched by their place in the list, so every frame
  must have the same atoms in the same order; otherwise the item is greyed out and its tooltip
  says where they differ. An atom that leaves through one face of the cell between frames and
  comes back through the opposite one is averaged at its nearest image to where it is in the
  first frame, so it stays at its site instead of being pulled to the middle of the cell.
  If an atom moves more than 0.1 of a cell axis (a, b or c) away from where it is in the first
  frame, in any frame, its average may fall between sites (a hop, diffusion, structures that do
  not match atom for atom), so a warning comes first. It lists those atoms, largest move first:
  the atom's name, its largest move in Å and as a fraction of the axis (`1.20 Å · 0.30 of a`),
  and the row and frame where it happens. Click one to see it: its row is shown at that frame,
  with the atom glowing. **Average anyway** goes on to the name; **Cancel** (or Esc) makes
  nothing. Either way the row shown, its frame and the camera are put back as they were.
  Positions are averaged as fractional coordinates and the cell component by component;
  mixed or partially occupied sites keep the first frame's occupancies. Forces, spins, energy and
  stress are not carried over. To leave out the start of a run, copy the frames you want with
  the row's ⧉ (**Copy Range of Steps**) and average the copy.

Both add the new row at the end of the list, select it and untick the rows they were made from,
which stay as they are.

## Parameters

Under the structure table, **Parameters** unfolds the selected structure's scalar properties (energy, pressure, max force — whichever it carries) and their **Source**: the code that computed them (VASP, Quantum ESPRESSO, CASTEP, FHI-aims, AIRSS, or the calculator an ASE trajectory names) or the potential that ran in the Atomistic, EOS, phonon or Order Structure window (PET-MAD xs, NEP89, a model on your ASE server); then its lattice vectors,
cell parameters and volume, its atomic positions (fractional or Cartesian) and its Wyckoff
positions (space group and one row per crystallographic orbit, from the active Wyckoff lock or a
symmetry analysis at a tight tolerance (1e-5 Å); the space group links to its symdata page, and the copied text also carries each orbit's
site symmetry). Select any text to copy it, or use a block's ⧉ to copy that block. The ✎ opens
the same Modify Structure panel as the pen in the Structure window.

For a CIF loaded with its **errors** (standard uncertainties), the lattice vectors' components,
the cell parameters and the volume are written with them, `a = 5.4307(2) Å` (a component's error
follows the cell's orientation: with a along x, `a_x` carries σ(a) and `a_y`, `a_z` none), and so
are the fractional positions and the Wyckoff
coordinates, `0.4135(3)` (a symmetry copy's through the operation that made it, a supercell's
scaled with the cell); the ⧉ copies carry them too. Values the file gives exactly (`90`, `0.5`)
have none. Cartesian positions are shown without errors. An atom moved from where the CIF puts it,
or a changed cell, loses its errors here as everywhere else; **Show CIF Errors** in the Features
window hides them.
