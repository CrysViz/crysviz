# CrysViz Crystal Structure Viewer
by Abhijith S. Parackal and Florian Trybel

Version 0.2 Beta

## This is the live developement repository. If you are not Abhijith or Florian, you should not be here!

CrysViz is a standalone visualisation tool built on top of Three.js. Paste a POSCAR/OUTCAR/CIF snippet, drop a local file, or grab an OPTIMADE endpoint (or just Materials Project or Alexandria IDs). You crystal structure will NOT leave your device. 

## Key Features
- No backend required; runs entirely in the browser, no data leaves your machine. Runs in nearly every device (in particular smartphons and tablets) and in every browser. 
- Fast and highly repsonse even for several thousand atoms. 
- Toggle mode distances, angles, ability to remove atoms, custom bond lengths with the optional ability to display atoms outside the unit cell.
- Customizable color schemes can be choosen for any individual atoms 
- Spin Viewer
- Compare two crystal structures by overlay and lattice differenc radar plot

## Comming Soon...
- Visualise forces and stree
- Visualise trajectories with spins or forces/stress
- Read Quantum Espresso Input
- Manipulate structures under symmetry constraints 

## Notes
If you are looking for a desktop application with more features →[VESTA](https://jp-minerals.org/vesta/en/).
If you look for Jupyter Notebook support → [Matterviz](https://matterviz.janosh.dev/).
If you want a JS tool that you can embedd in your webpage → [JSmol](https://jmol.sourceforge.net)
This project is under very active delevopment and at best in an early beta phase with known bugs that we are trying to fix. Please report them to Abhijith Parackal (abhijith.s.parackal@liu.se) or Florian Trybel (florian.trybel@liu.se)

## Powered By
- [Three.js](https://threejs.org/) for the WebGL rendering pipeline.
- [OPTIMADE](https://www.optimade.org/) compatible structure providers including Materials Project and Alexandria.
