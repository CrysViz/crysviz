<img src="old/CrysViz_logo_clear_back.png" width="400">

# CrysViz - Crystal Structure Visualisation & Analysis

## Light-weight browser-based crystal structure visualisation with on-device rendering.

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

Copyright (C) 2025-2026 Florian Trybel, Abhijith S Parackal, Oscar Bulancea-Lindvall and Rickard Armiento 

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Source code: https://github.com/ftrybel/CrysViz_hot_develop

## Maintainers
- **[Florian Trybel](https://github.com/ftrybel)** - Project lead, core development, and design.
- **[Abhijith S Parackal](https://github.com/Abhivega)** - Core development, and design

## Contributors
- **[Rickard Armiento](https://github.com/rartino)** - CIF Reader, I/O
- **[Oscar Bulancea-Lindvall](https://github.com/oscarlindbul)** - Vector Field Visualisation (ELF, Charge)

## Key Features
- No backend required; runs entirely in the browser, no data leaves your machine. Runs in nearly every device (in particular smartphons and tablets) and in every browser.
- Visualise Input and output files from VASP and Quantum Espress as well as CIFs.
- Toggle mode distances, angles, ability to remove atoms, custom bond lengths with the optional ability to display atoms outside the unit cell.
- Customizable color schemes can be choosen for any individual atoms
- Watch forces and spins change in relaxaton trajectories
- Charge density and electron localisation functions viewer (CHGCAR/ELFCAR or .cube files spin resolved)
- Compare two crystal structures by overlaying the structure; view lattice differences in a radar plot
- Trajectory player. Load OUTCARs and pwscf vc-relax output files directly and visualise the trajectories. Long MD trajecetories might be beyond your browsers memory limits.
- Analyse symmetry and symmetrise structures (powered by Moyo)
- Run relxations and molecular dynamics directly on your device with NEP potentials.
- Possibility to activate a calcualtions backend. This allow structural relaxations with any ASE compatible calculater, e.g. MACE, UPET; trajectory is added and can be played using the trajectory player
- Watch forces and spins change in relaxaton trajectories (VASP and QE output)
- View a bond length histogram (angles and coordiantion numbers are comming)

## Comming Soon...
- Visualise  stress
- Manipulate structures under symmetry constraints
- Possibility to add atoms
- eXYZ reader for trajectories or sets of files.


## Experimental
- Charge density and electron localisation functions viewer (CHGCAR/ELFCAR or .cube files spin resolved). High memory requirements for large files.


Third-Party Libraries and Attribution:

1. Moyo
   - Repository: https://github.com/spglib/moyo
   - License: MIT or Apache-2.0
   - Copyright: Kohei Shinohara
   - See LICENSE-moyo for the full license text.
   - Explicitly moyo-wasm is used.
   - License and code can be found in /docs/backend/moyo

2. NEP_CPU
   - Repository: https://github.com/brucefan1983/NEP_CPU
   - License: GPL-3.0
   - Copyright: NEP_CPU authors
   - See LICENSE-NEP_CPU for the full license text.
   - Explicitly NEP_CPU is compliled into a WASM module. 
   - License and code can be found in  /docs/backend/nep_wasm/

3. THREE.js
   - Repository: https://github.com/mrdoob/three.js/
   - License: MIT
   - Copyright: THREE.js authors
   - See LICENSE-THREEjs for the full license text.
   - License and code can be found in /docs/backend/thee

4. NEP89 Weights (from GPUMD)
   - Repository: https://github.com/brucefan1983/GPUMD
   - License: GPL-3.0
   - Copyright: GPUMD authors
   - The weights can be found in /docs/backend/nep_wasm/
   - See LICENSE-GPUMD for the full license text.

