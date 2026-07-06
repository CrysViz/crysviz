<img src="docs/data/CrysViz_logo_clear_back.png" width="400">

# CrysViz - Crystal Structure Visualisation & Analysis

[![Checks](https://github.com/ftrybel/CrysViz_hot_develop/actions/workflows/check.yml/badge.svg)](https://github.com/ftrybel/CrysViz_hot_develop/actions/workflows/check.yml)

## Light-weight browser-based crystal structure visualisation with on-device rendering.

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

Copyright (C) 2025-2026 Florian Trybel, Abhijith S Parackal, Oscar Bulancea-Lindvall, and Rickard Armiento 

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
- Measure distances and angles.
- Use custom bond lengths with the optional ability to display atoms outside the unit cell that are bonded neighbours.
- Customizable color schemes can be choosen for any individual atoms
- Forces and spin visualisation. Dynamically for relaxaton or MD trajectories
- Trajectory player. Load OUTCARs and pwscf vc-relax output files directly and visualise the trajectories. Long MD trajecetories might be beyond your browsers memory limits.
- Symmetry anlysis and structure refinement (powered by Moyo WASM)
- Relxations and molecular dynamics simulations directly on your device with NEP potentials with upt to several hundred atoms.
- Possibility to activate a calculation backend. This allow structural relaxations with any ASE compatible calculater, e.g. MACE, UPET; trajectory is added and can be played using the trajectory player
- Bond length histogram (angles and coordiantion numbers are comming)

## Work in progress... (already available)
- Crystal structures structure comparison via structure overlay; Lattice difference analysis inradar plot
- Charge density and electron localisation functions viewer (CHGCAR/ELFCAR or .cube files spin resolved). High memory requirements for large files.
- Share links that contain the structure, view angle, colors and measurements (currently selected structure in trajectory only)

## Comming soon...
- Stress visualisation
- Updated trajectory player for larger and longer trajectories
- Structures manipulation under symmetry constraints
- Add atoms and vaccuum
- eXYZ reader for trajectories or sets of files.

Third-Party Libraries and Attribution:

1. Moyo
   - Repository: https://github.com/spglib/moyo
   - License: MIT or Apache-2.0
   - Copyright: Kohei Shinohara
   - See docs/external/moyo-test/LICENSE for the full license text.
   - Explicitly moyo-wasm is used.
   - License and code can be found in docs/external/moyo-test/

2. NEP_CPU
   - Repository: https://github.com/brucefan1983/NEP_CPU
   - License: GPL-3.0
   - Copyright: NEP_CPU authors
   - See docs/external/nep_wasm/LICENSE-NEP_CPU for the full license text.
   - Explicitly NEP_CPU is compliled into a WASM module. 
   - License and code can be found in docs/external/nep_wasm/

3. THREE.js
   - Repository: https://github.com/mrdoob/three.js/
   - License: MIT
   - Copyright: THREE.js authors
   - See docs/external/three/LICENSE for the full license text.
   - License and code can be found in docs/external/three/

4. NEP89 Weights (from GPUMD)
   - Repository: https://github.com/brucefan1983/GPUMD
   - License: GPL-3.0
   - Copyright: GPUMD authors
   - The weights can be found in docs/external/nep_wasm/
   - See docs/external/nep_wasm/LICENSE-GPUMD for the full license text.

5. three-wboit
   - Repository: https://github.com/stevinz/three-wboit
   - License: MIT
   - Copyright: Stephens Nunnally (@stevinz); portions mrdoob and three.js authors, Alexander Rose
   - See docs/external/three-wboit/LICENSE for the full license text.
   - Used by the optional "Weighted blended (WBOIT)" rendering pipeline.
   - License and code can be found in docs/external/three-wboit/

6. three-depthpeeling-demo
   - Repository: https://github.com/gkjohnson/three-depthpeeling-demo
   - License: MIT
   - Copyright: Garrett Johnson
   - See docs/external/three-depthpeeling/LICENSE for the full license text.
   - Adapted (not verbatim) for the optional "Depth peeling" rendering pipeline;
     see docs/external/three-depthpeeling/README.md for the divergences.
   - License and code can be found in docs/external/three-depthpeeling/

7. THREE.js-RayTracing-Renderer
   - Repository: https://github.com/erichlof/THREE.js-RayTracing-Renderer
   - License: CC0 1.0 (public domain; attribution given as a courtesy)
   - Author: Erich Loftis (@erichlof)
   - See docs/external/three-raytracing/LICENSE for the full license text.
   - GLSL chunk library adapted for the optional "Ray tracing" rendering
     pipeline; see docs/external/three-raytracing/README.md for the adaptations.
   - License and code can be found in docs/external/three-raytracing/

