# Crystal Structure Viewer
Crystal Structure Viewer is a standalone exploration tool built on top of Three.js. Paste a POSCAR/CIF snippet, drop a local file, or grab an OPTIMADE endpoint (or just Materials Project or Alexandria IDs).
## Key Features
- No backend required; runs entirely in the browser, no data leaves your machine.
- Surprisingly fast :D
- Toggle mode distances, angles, ability to remove atoms, custom bond lengths with the optional ability to display atoms outside the unit cell.
- Customizable color schemes.

## Notes
A significant 'look and feel' inspiration is drawn from [VESTA](https://jp-minerals.org/vesta/en/). But, if you want something much more polished, head over to [Matterviz](https://matterviz.janosh.dev/).
This project is almost entirely vibe coded, about half a million tokens from chatGPT as well as Claude.


## Limitations
- The CIF support is basic and only supports p1 symmetry.

## Powered By
- [Three.js](https://threejs.org/) for the WebGL rendering pipeline.
- [OPTIMADE](https://www.optimade.org/) compatible structure providers including Materials Project and Alexandria.