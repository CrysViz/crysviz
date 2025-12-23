# CrysViz Crystal Structure Viewer

by Abhijith S. Parackal and Florian Trybel

Version 0.5 Beta 2025-12-23

## This is the live developement repository. If you are not Abhijith or Florian, you should not be here!

CrysViz is a standalone visualisation tool built on top of Three.js. Paste a POSCAR/OUTCAR/CIF snippet, drop a local file, or grab an OPTIMADE endpoint (or just Materials Project or Alexandria IDs). You crystal structure will NOT leave your device. 

## Key Features
- No backend required; runs entirely in the browser, no data leaves your machine. Runs in nearly every device (in particular smartphons and tablets) and in every browser. 
- Fast and highly repsonse even for several thousand atoms. 
- Visualise Input and output files from VASP and Quantum Espresso. Support for CIFs with symmetry information
- Toggle mode distances, angles, ability to remove atoms, custom bond lengths with the optional ability to display atoms outside the unit cell.
- Customizable color schemes can be choosen for any individual atoms 
- Spin Viewer
- Compare two crystal structures by overlay and lattice differenc radar plot
- Trajectory player. Load OUTCARs and pwscf vc-relax output files directly and visualise the trajectories. (MDs might hit your memory limit!)
- Possibility to activate a calcualtions backend. This allows: (1) symmetry analysis with spglib and (2) structural relaxation with MACE (MPA0 model; trajectory is added and can be played using the trajectory player)
- Watch forces and spins change in relaxaton trajectories (VASP and QE output)
- Bond length histogram
- symmetry analysis and refinement powered by Moyo 

## Currently broken due to developments 
- Structure and lattice comparsion
- Camera does not re-center when switching files in the file browser 
- Due to many new addtions there are side effects in the styles... fonts are to large, panels to wide. Will be cleaned up once the functionalities are working.

## Comming Soon...
- Visualise  stress
- Manipulate structures under symmetry constraints
- Possibility to add atoms

## Experimental
- Trajectory player
- Backend for symmetry refinement and AI-accelerated structural relaxations
- last loaded trajectory is not automaticaly selected... requires currently an extra "click" on the row in the file browser

## Notes
If you are looking for a desktop application with more features →[VESTA](https://jp-minerals.org/vesta/en/).
If you look for Jupyter Notebook support → [Matterviz](https://matterviz.janosh.dev/).
If you want a JS tool that you can embedd in your webpage → [JSmol](https://jmol.sourceforge.net)
This project is under very active delevopment and at best in an early beta phase with known bugs that we are trying to fix. Please report them to Abhijith Parackal (abhijith.s.parackal@liu.se) and Florian Trybel (florian.trybel@liu.se)

## Powered By
- [Three.js](https://threejs.org/) for the WebGL rendering pipeline.
- [OPTIMADE](https://www.optimade.org/) compatible structure providers including Materials Project and Alexandria.
- Structural relaxation are running [MACE-MP](https://github.com/ACEsuit/mace-foundations) models
- Symmetry analysis is based on [moyo](https://github.com/spglib/moyo)
