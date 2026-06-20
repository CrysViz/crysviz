# three.js (vendored)

Vendored copy of [three.js](https://threejs.org/) — the WebGL library CrysViz
uses for all 3D rendering.

- Upstream: https://github.com/mrdoob/three.js
- Version: **r182dev** (see `REVISION` in `three.core.js`)
- License: **MIT** — see `LICENSE-THREE` at the repo root.

## Files
- `three.module.js` / `three.core.js` — the core library (ES modules). App code
  imports three from `three.module.js` (kept vendored for consistency rather
  than an npm/CDN copy).
- Add-ons (from three.js `examples/jsm/`): `BufferGeometryUtils.js`,
  `ConvexGeometry.js`, `ConvexHull.js`, `CSS2DRenderer.js`, `Lut.js`,
  `TrackballControls.js`.
