# File Upload 


The most important information is that CrysViz is mainly a static html page using the resources from your computer. There is no backend unless you choose *AI mode*. This means that the structures you upload are stored in the temporary browser storage on **your computer**. Reloading the website will remove the data. Clearing browser history will make sure no data is left.

Currently it is possible to view the following file types: 

- **VASP**:
    - POSCAR: structure only.
    - OUTCAR: structure, forces, and spin for the complete trajectory of a MD or relaxation.

- **Quantum Espresso**:
    - Input file: structure only.
    - Output vc relax: structure forces, stress, spin for the complete trajectory.
    - Output relax: not implemented at the moment 
    - Output md: implemented but experimental

- **CIF**: CrysViz provides a CIF reader.

- **CASTEP**:
    - `.cell` input file: structure only (reads `LATTICE_CART`/`LATTICE_ABC` and `POSITIONS_FRAC`/`POSITIONS_ABS`). An AIRSS `buildcell` seed with absolute positions and no lattice loads as a molecule in a centered box.
    - `.geom` (geometry optimization), `.md` (molecular dynamics) and `.ts` (transition-state search): the full trajectory with per-frame energy, forces and stress (pressure).
    - The `.param` file holds run settings only and carries no structure.

- **SHELX / AIRSS `.res`**: structure only. A single `.res` may hold many structures back to back (e.g. an AIRSS search dump); they load as a stepped set you can page through, with each candidate's enthalpy shown as its energy.

- **.xyz and .exzy format**: Currently under implementation

- **FHI-aims**:
    - `geometry.in`: structure and magnetism (`initial_moment`, collinear or non-collinear). A non-periodic geometry loads as a molecule in a centered box.
    - `aims.out` output: the full relaxation/MD trajectory with per-frame energy and forces, plus per-atom spin moments when the Mulliken analysis is present.
