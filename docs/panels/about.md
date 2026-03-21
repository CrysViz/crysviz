# CrysViz Crystal Structure Visualisation & Analysis

Version 0.9 Beta 2026-03-21

CrysViz is a standalone visualisation tool built on top of Three.js. Paste a POSCAR/OUTCAR/CIF snippet, drop a local file (POSCAR, OUTCAR, CIF or QE input/output), or grab an OPTIMADE endpoint (or just Materials Project or Alexandria IDs). Your crystal structures will NOT leave your device!

by Florian Trybel, Abhijith S Parackal, Oscar Bulancea-Lindvall, and Rickard Armiento

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

## Notes
If you are looking for a desktop application with more features →[VESTA](https://jp-minerals.org/vesta/en/).
If you look for Jupyter Notebook support → [Matterviz](https://matterviz.janosh.dev/).
If you want a JS tool that you can embedd in your webpage → [JSmol](https://jmol.sourceforge.net)
This project is under very active delevopment and an early beta phase with some bugs that we are trying to fix. Please report them on github or directly to Abhijith Parackal (abhijith.s.parackal@liu.se) and Florian Trybel (florian.trybel@liu.se)

## External libraries
- [Three.js](https://threejs.org/) for the WebGL rendering pipeline.
- [OPTIMADE](https://www.optimade.org/) compatible structure providers including Materials Project and Alexandria.
- Symmetry analysis is based on [moyo](https://github.com/spglib/moyo)
- ON-the-fly relaxations and moleceular dynamics uses [NEP-CPU](https://github.com/brucefan1983/NEP_CPU) and the NEP89 weigths from [GPUMD](https://github.com/brucefan1983/GPUMD)
