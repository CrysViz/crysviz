# CrysViz - Crystal Structure Visualisation & Analysis

## Light-weight browser-based crystal structure visualisation and analysis with on-device rendering.

Version 0.9 Beta 2026-03-21

Copyright (C) 2025-2026 Florian Trybel, Abhijith S Parackal, Oscar Bulancea-Lindvall, and Rickard Armiento

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

CrysViz is a standalone visualisation tool built on top of Three.js. Paste a POSCAR/OUTCAR/CIF snippet, drop a local file (POSCAR, OUTCAR, CIF or QE input/output), or grab an OPTIMADE endpoint (or just Materials Project or Alexandria IDs). Your crystal structures will NOT leave your device!

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see https://www.gnu.org/licenses/.


## Maintainers
- **[Florian Trybel](https://github.com/ftrybel)** - Project lead, core development, and design.
- **[Abhijith S Parackal](https://github.com/Abhivega)** - Core development, and design

## Contributors
- **[Rickard Armiento](https://github.com/rartino)** - I/O (CIF), rendering (depth peeling, WBOIT, ray/path tracing), dockable window GUI, polyhedra, camera controls, bond styling, standalone app with Python API, PNG export, dev tooling/CI/browser tests.
- **[Oscar Bulancea-Lindvall](https://github.com/oscarlindbul)** - Vector Field Visualisation (ELF, Charge densities, Wavefunctions)

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

## Work in progress... (already partially available)
- Crystal structure comparison via structure overlay; Lattice difference analysis in radar plot.
- Wyckoff Mode: all structure manipulation, relaxation and even molecular dynamics are in symmetry.
- Charge density and electron localisation functions viewer (CHGCAR/ELFCAR or .cube files spin resolved). Also WAVECAR loading and wavefunction/partial density visualization, collinear and non-collinear. Possible high memory requirements for large files.
- Share links that contain the structure, view angle, colors and measurements (currently selected structure in trajectory only).
- Bond color maps.
- Use (i) buttons to get more information about features; A detailed documentation of all features is comming soon!
- Semi-permanent storage in browser cache (still fully on your device) to allow reload without loosing any modification to structure or trajectories. 

## Comming soon...
- Stress Visualisation.
- Updated Trajectory Player for larger and longer trajectories.
- Add atoms and vaccuum.
- eXYZ reader for trajectories or sets of files. 
- Castep file reader.


## Notes
If you are looking for a desktop application with more features →[VESTA](https://jp-minerals.org/vesta/en/).
If you look for Jupyter Notebook support → [Matterviz](https://matterviz.janosh.dev/).
If you want a JS tool that you can embedd in your webpage → [JSmol](https://jmol.sourceforge.net)
This project is under very active delevopment and an early beta phase with some bugs that we are trying to fix. Please report them on github or directly to Abhijith Parackal (abhijith.s.parackal@liu.se) and Florian Trybel (florian.trybel@liu.se)

## Legal and privacy information

**Local processing and user-provided data.** The website is designed to perform its functionality in the user’s browser. Data loaded into or created with the tool, such as crystal structures, configuration data, or application state, is used to provide the requested functionality. Unless explicitly stated for a specific feature, this data is not uploaded to our servers by the website.

**Cookies and persistent storage.** This website may use cookies, local storage, or similar browser storage mechanisms to store information on your device. *We do not use cookies, local storage, or similar technologies for advertising, analytics, profiling, cross-site tracking, or identifying users across websites.*

We use these mechanisms only for storage that is necessary to provide functionality requested or selected by the user, for example, remembering selected display options, configuration settings, application state crystal structures, or other data that the user has chosen to work with, so that the website can restore or continue that functionality between visits or page reloads. The amount and kind of information stored can be chosen by the user via the “Storage Information” setting. The stored data remains in your browser until you change the relevant settings, reset the website configuration, overwrite the stored data, or clear your browser’s site data.

Because this storage is limited to what is necessary to provide functionality requested or selected by the user, we treat it as strictly necessary storage and do not request separate “cookie consent” for it.

**Server logs and hosting provider.** The website may be served either from our own infrastructure or by a third-party hosting provider. In either case, the server or hosting provider will receive basic technical information needed to deliver the website, such as the requested page, time of access, browser type, referrer, and IP address.

This information may be logged or otherwise processed for purposes such as delivering the website, maintaining security, diagnosing technical problems, and producing aggregate usage statistics. We do not use this information for advertising, profiling, cross-site tracking, or identifying individual users.

**Third-party services.** The website may contain links to third-party services. These third-party services operate as separate entities from this website and our services. Visits to them are subject to their own respective terms of service and privacy policies.

*The website does not embed advertising trackers, profiling tools, cross-site tracking tools, or user-tracking analytics services.*

**No warranty.** This website is provided as a technical/scientific tool. While we aim for correctness, results may be incomplete, inaccurate, or unsuitable for a particular purpose. Users should independently verify any results before relying on them.

## Use of AI

Software used in our projects, e.g., as part of this website, and otherwise for executing computations, analyzing results, disseminating research data, and as part of computational pipelines generating data, are created by humans that use generative and other forms of AI as part of their tools. Generative AI based on large language models (LLMs) can greatly speed up many tasks in programming and data processing, but the final outcome is almost always a result of many iterations with substantial human input to instruct and control these tools.

## External libraries
- [Three.js](https://threejs.org/) for the WebGL rendering pipeline, with rendering pipelines options built on [three-wboit](https://github.com/stevinz/three-wboit), [three-depthpeeling-demo](https://github.com/gkjohnson/three-depthpeeling-demo), [THREE.js-RayTracing-Renderer](https://github.com/erichlof/THREE.js-RayTracing-Renderer), [THREE.js-PathTracing-Renderer](https://github.com/erichlof/THREE.js-PathTracing-Renderer).
- Symmetry analysis is based on [moyo](https://github.com/spglib/moyo).
- ON-the-fly relaxations and moleceular dynamics uses [NEP-CPU](https://github.com/brucefan1983/NEP_CPU) and the NEP89 weigths from [GPUMD](https://github.com/brucefan1983/GPUMD).

## Other credits

- CrysViz use some color maps from the [Scientific colour maps by Fabio Crameri](https://doi.org/10.5281/zenodo.1243862) (Version 8).
- [OPTIMADE](https://www.optimade.org/) compatible structure providers including Materials Project and Alexandria.
