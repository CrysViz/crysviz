
<img src="https://raw.githubusercontent.com/CrysViz/crysviz/main/docs/data/CrysViz_logo_clear_back.png" width="400">

# CrysViz - Crystal Structure Visualisation & Analysis

## Light-weight browser-based crystal structure visualisation and analysis with on-device rendering.

Version 0.9.10 Beta 2026-08-28

<img width="600" alt="Screenshot_crysviz" src="https://raw.githubusercontent.com/CrysViz/crysviz/deploy/docs/data/CrysViz_screenshot.png" />


CrysViz is a standalone visualisation tool built on top of Three.js. Paste a POSCAR/OUTCAR/CIF snippet, drop a local file (POSCAR, OUTCAR, CIF or QE input/output), or grab an OPTIMADE endpoint (or just Materials Project or Alexandria IDs). Your crystal structures will NOT leave your device!

Copyright (C) 2025-2026 Florian Trybel, Abhijith S Parackal, Oscar Bulancea-Lindvall, Henricus R.A. ten Eikelder and Rickard Armiento


## Key Features
- No backend required; runs entirely in the browser, no data leaves your machine. Runs in nearly every device (in particular smartphons and tablets) and in every browser. 
- Visualise Input and output from VASP, Quantum Espresso, and CIF files.
- Measure distances and angles.
- Use custom bond lengths with the optional ability to display atoms outside the unit cell that are bonded neighbours.
- Customizable color schemes can be choosen for any individual atoms 
- Forces and spin visualisation. Dynamically for relaxaton or MD trajectories
- Trajectory player. Load VASP OUTCARs and Quantum Espresso vc-relax output files directly and visualise the trajectories. Long MD trajecetories might be beyond your browsers memory limits.
- Symmetry anlysis and structure refinement (powered by Moyo WASM)
- Relxations and molecular dynamics simulations directly on your device with NEP potentials with upt to several hundred atoms. 
- Possibility to activate a calculation backend. This allows structural relaxations with any ASE compatible calculater, e.g., MACE, UPET, VASP, QE; trajectory is added and can be played using the trajectory player.
- Bond length histogram (angles and coordiantion numbers are comming soon).
- and many more...


This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see https://www.gnu.org/licenses/.


## Maintainer
- **[Florian Trybel](https://github.com/ftrybel)** - Project lead
- **[Abhijith S Parackal](https://github.com/Abhivega)**
- **[Rickard Armiento](https://github.com/rartino)**
- **[Oscar Bulancea-Lindvall](https://github.com/oscarlindbul)**
- **[Henricus R.A. ten Eikelder](https://github.com/RicktenE)**


### Local in-browser installation and use

If you do not want to use CrysViz over the Internet, you can run it via a webserver on your own computer:

* Clone the CrysViz repository from GitHub

* Start the local server:

   ```bash
   make serve
   ```
* Visit the URL shown.


### Run CrysViz as a stand-alone application

The stand-alone application uses pywebview, which requires a native GUI backend.
This sometimes works automatically via CrysViz dependency handling,
but if not, follow the [installation instructions for pywebview](https://pywebview.flowrl.com/guide/installation.html)).

We suggest that you set up pywebview and CrysViz in a venv.
For pywebview to access its required system packages, you may need to create it as, e.g.:
```bash
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
python -m pip install pywebview
```
And then test that the pywebview backend works:
```python
import webview
webview.create_window('Hello world', 'https://pywebview.flowrl.com/')
webview.start()
```
Now you can install CrysViz into the venv as:
```bash
python -m pip install -e .
```
(Good alternatives are via `pipx install` or `uv tool install` if you have these tools available.)

And then run the standalone application with:
```
crysviz
```

### Python API

If you have the standalone application installed, you can also use the Python API for visualization and remote-control from Python. For example:

```python
from crysviz import Payload, Viewer, show

payload = Payload("silicon.cif", "data_Si\n_cell_length_a 5.43\n")
with Viewer([payload]) as viewer:
    structures = viewer.list_structures()
    viewer.select(structures[0].id, frame=0)
    viewer.update_lattice([[5.7, 0.0, 0.0], [0.2, 5.4, 0.0], [0.0, 0.0, 5.2]])
    viewer.update_fractional_positions([[0.0, 0.0, 0.0]], commit=False)
    viewer.commit_positions()
    viewer.recenter_camera()

# Equivalent concise construction; returns once the window is ready.
viewer = show(["structure.cif"])
```

For more, see [examples](examples/).

## Third-Party Libraries

1. THREE.js
   - Repository: https://github.com/mrdoob/three.js/
   - License: MIT
   - Copyright: THREE.js authors
   - See docs/external/three/LICENSE for the full license text.
   - License and code can be found in docs/external/three/
   
2. Moyo
   - Repository: https://github.com/spglib/moyo
   - License: MIT or Apache-2.0
   - Copyright: Kohei Shinohara
   - See docs/external/moyo-test/LICENSE for the full license text.
   - Explicitly moyo-wasm is used.
   - License and code can be found in docs/external/moyo-test/

3. NEP_CPU
   - Repository: https://github.com/brucefan1983/NEP_CPU
   - License: GPL-3.0
   - Copyright: NEP_CPU authors
   - See docs/external/nep_wasm/LICENSE-NEP_CPU for the full license text.
   - Explicitly NEP_CPU is compliled into a WASM module. 
   - License and code can be found in docs/external/nep_wasm/

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
  The CC0 dedication applies to the upstream original only; CrysViz's
     local adaptations in docs/external/three-raytracing/ and the first-party ray/path
     tracing code under docs/render/pipeline/ are licensed AGPL-3.0.
   - Author: Erich Loftis (@erichlof)
   - See docs/external/three-raytracing/LICENSE for the full license text.
   - GLSL chunk library adapted for the optional "Ray tracing" rendering
     pipeline; see docs/external/three-raytracing/README.md for the adaptations.
   - License and code can be found in docs/external/three-raytracing/

8. THREE.js-PathTracing-Renderer
   - Repository: https://github.com/erichlof/THREE.js-PathTracing-Renderer
   - License: CC0 1.0 (public domain; attribution given as a courtesy)
  The CC0 dedication applies to the upstream original only; CrysViz's
     local adaptations in docs/external/three-pathtracing/ and the first-party ray/path
     tracing code under docs/render/pipeline/ are licensed AGPL-3.0.
   - Author: Erich Loftis (@erichlof)
   - See docs/external/three-pathtracing/LICENSE for the full license text.
   - GLSL chunk library adapted for the optional "Path tracing" rendering
     pipeline; see docs/external/three-pathtracing/README.md for the adaptations.
   - License and code can be found in docs/external/three-pathtracing/

9. QR Code generator
   - Repository: https://github.com/nayuki/QR-Code-generator
   - License: MIT
   - Copyright: Project Nayuki
   - Loaded on demand from jsDelivr (npm `nayuki-qr-code-generator`) to draw the
     QR code in the share-link dialog.

## Other Attributions

- CrysViz uses some color maps from the [Scientific colour maps by Fabio Crameri](https://doi.org/10.5281/zenodo.1243862) (Version 8)
- [OPTIMADE](https://www.optimade.org/) compatible structure providers including Materials Project and Alexandria.
