// Slice planes through a BLOCK field (field.periodic === false). Planes are
// built directly (model Plane) on the default YBCO lattice, with a constant-1
// block of known footprint so "field colour" vs "no-field colour" is exact.
// Asserts (DW-3.1) field colours inside the footprint and the neutral plane
// colour outside it, (DW-3.2) no NaN in the vertex colours or the baked atlas,
// (DW-3.3) a periodic field still wraps into its own cell as it always did,
// plus: a point exactly on the block face, no wrapping at unit bounds for a
// block crossing a cell face, and repetition with the lattice when widened.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO, orthorhombic

  const r = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { Field, Plane } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const lat = fileBrowser.selectedStructure.lattice;
    const cell = lat.map((v) => new THREE.Vector3(...v));
    const cz = 3.9; // inside the cell along c
    const neutral = new THREE.Color(0x8c8c99);

    const makeField = (opts) => {
      const n = opts.n ?? 10;
      return new Field({
        nx: n, ny: n, nz: n, origin: opts.origin, voxel: opts.voxel, periodic: opts.periodic,
        values: opts.values ?? new Float32Array(n * n * n).fill(1),
        isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false,
      });
    };
    const makePlane = (field, bounds) => new Plane({
      normal: [0, 0, 1], d: cz, cell, resolution: 24, mode: 'Field', field, colormap: 'jet',
      bounds,
    });
    const colorAt = (plane, x, y) => {
      plane._configureLutRange();
      const c = plane.fieldColorAtWorldPoint(new THREE.Vector3(x, y, cz), plane._fieldFracBasisInv());
      return [c.r, c.g, c.b];
    };
    const isNeutral = (c) => Math.abs(c[0] - neutral.r) + Math.abs(c[1] - neutral.g) + Math.abs(c[2] - neutral.b) < 1e-6;
    const hasNaN = (arr) => Array.from(arr).some((v) => !Number.isFinite(v));
    const step = 0.2;
    const voxel = [[step, 0, 0], [0, step, 0], [0, 0, step]];
    const out = {};

    // Block fully inside the cell: x,y in [1, 2.8], z in [3, 4.8].
    const inner = makePlane(makeField({ origin: [1, 1, 3], voxel, periodic: false }));
    const col = inner.geometry.getAttribute('color').array;
    const pos = inner.geometry.getAttribute('position').array;
    let inside = 0, outside = 0, badInside = 0, badOutside = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const c = [col[i], col[i + 1], col[i + 2]];
      const x = pos[i], y = pos[i + 1];
      if (x > 1.05 && x < 2.75 && y > 1.05 && y < 2.75) { inside++; if (isNeutral(c)) badInside++; }
      else if (x < 0.95 || x > 2.85 || y < 0.95 || y > 2.85) { outside++; if (!isNeutral(c)) badOutside++; }
    }
    out.vertices = { inside, outside, badInside, badOutside, nan: hasNaN(col), length: col.length };
    out.pointsInner = {
      centre: isNeutral(colorAt(inner, 1.9, 1.9)),
      faceLow: isNeutral(colorAt(inner, 1, 1.9)),
      faceHigh: isNeutral(colorAt(inner, 1 + 9 * step, 1.9)),
      justOutside: isNeutral(colorAt(inner, 0.9, 1.9)),
      farOutside: isNeutral(colorAt(inner, 3.5, 3.5)),
    };

    // Atlas bake: finite bytes, neutral texels outside, a field colour inside.
    const size = 16;
    const data = new Uint8ClampedArray(size * size * 4);
    out.bakeOk = inner.bakeFieldAtlasTile(data, size, 0, 0, size);
    const px = new Set();
    for (let i = 0; i < data.length; i += 4) px.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    out.bakeDistinct = px.size;

    // Plane z outside the block's z range: nothing but the neutral colour.
    const skew = new Plane({ normal: [0, 0, 1], d: 8, cell, resolution: 8, mode: 'Field',
      field: makeField({ origin: [1, 1, 3], voxel, periodic: false }), colormap: 'jet' });
    const sc = skew.geometry.getAttribute('color').array;
    out.skewAllNeutral = Array.from({ length: sc.length / 3 }, (_, i) => isNeutral([sc[3 * i], sc[3 * i + 1], sc[3 * i + 2]])).every(Boolean);

    // Block crossing the +a face (x from a-1 to a+0.8), unit bounds: no wrapping.
    const a = lat[0][0];
    const cross = makeField({ origin: [a - 1, 1, 3], voxel, periodic: false });
    const unit = makePlane(cross);
    out.unitCross = {
      past: isNeutral(colorAt(unit, a + 0.2, 1.9)),   // block lies here, drawn in place
      wrapped: isNeutral(colorAt(unit, 0.2, 1.9)),    // would be the wrapped copy: must be empty
    };
    // Bounds a hair over the unit cell (1e-7) are unit bounds, like Isosurface/SceneEncoder:
    // drawn once in place, no tiling.
    const nearUnit = makePlane(makeField({ origin: [a - 1, 1, 3], voxel, periodic: false }), [[0, 1.0000001], [0, 1], [0, 1]]);
    out.nearUnit = {
      past: isNeutral(colorAt(nearUnit, a + 0.2, 1.9)),
      wrapped: isNeutral(colorAt(nearUnit, 0.2, 1.9)),
      repeated: isNeutral(colorAt(nearUnit, 2 * a - 0.5, 1.9)),
    };
    const wide = makePlane(makeField({ origin: [a - 1, 1, 3], voxel, periodic: false }), [[0, 2], [0, 1], [0, 1]]);
    out.wideCross = {
      inFirst: isNeutral(colorAt(wide, a - 0.5, 1.9)),
      repeated: isNeutral(colorAt(wide, 2 * a - 0.5, 1.9)),   // the lattice image at +a
      gap: isNeutral(colorAt(wide, a * 1.5 + 0.3, 1.9)),      // between images (block spans < a)
      nan: hasNaN(wide.geometry.getAttribute('color').array),
    };

    // Degenerate block (one point on an axis): no volume, no field, no NaN.
    const flat = makeField({ n: 10, origin: [1, 1, 3], voxel, periodic: false });
    flat.nz = 1;
    flat.values = new Float32Array(100).fill(1);
    const fp = makePlane(flat);
    out.degenerate = { neutral: isNeutral(colorAt(fp, 1.9, 1.9)), nan: hasNaN(fp.geometry.getAttribute('color').array) };

    // Periodic field: wraps into its own cell exactly as before.
    const pn = 8;
    const pv = lat.map((row) => row.map((v) => v / pn));
    const pvals = new Float32Array(pn * pn * pn).map((_, i) => (i % 7) / 6);
    const pfield = makeField({ n: pn, origin: [0, 0, 0], voxel: pv, periodic: true, values: pvals });
    const pp = makePlane(pfield);
    const frac = (x, y) => {
      const wrap = (t) => ((t % 1) + 1) % 1;
      return pfield.getValueAtPoint(wrap(x / lat[0][0]), wrap(y / lat[1][1]), wrap(cz / lat[2][2]));
    };
    pp._configureLutRange();
    const expect = (x, y) => { const c = pp._lut.getColor(frac(x, y)); return [c.r, c.g, c.b]; };
    const close = (u, v) => u.every((e, k) => Math.abs(e - v[k]) < 1e-6);
    out.periodic = {
      inCell: close(colorAt(pp, 1.3, 2.1), expect(1.3, 2.1)),
      wrapped: close(colorAt(pp, 1.3 + 2 * lat[0][0], 2.1 - lat[1][1]), expect(1.3, 2.1)),
    };
    return out;
  });

  const v = r.vertices;
  H.check('DW-3.1 plane vertices exist inside and outside the footprint', v.inside > 10 && v.outside > 10, JSON.stringify(v));
  H.check('DW-3.1 vertices inside the footprint carry a field colour', v.badInside === 0, JSON.stringify(v));
  H.check('DW-3.1 vertices outside the footprint carry the neutral plane colour', v.badOutside === 0, JSON.stringify(v));
  H.check('DW-3.1 sampled points: field inside, neutral outside',
    r.pointsInner.centre === false && r.pointsInner.justOutside && r.pointsInner.farOutside, JSON.stringify(r.pointsInner));
  H.check('DW-3.2 no NaN in the vertex colours', v.nan === false && v.length > 0, JSON.stringify(v));
  H.check('face: points exactly on the low and high block faces are inside the block',
    r.pointsInner.faceLow === false && r.pointsInner.faceHigh === false, JSON.stringify(r.pointsInner));
  H.check('atlas bake: succeeds and holds both field and neutral texels', r.bakeOk === true && r.bakeDistinct >= 2,
    JSON.stringify({ ok: r.bakeOk, distinct: r.bakeDistinct }));
  H.check('a plane beside the block (outside its z range) is entirely neutral', r.skewAllNeutral === true);
  H.check('unit bounds, block crossing the cell face: drawn in place past the face, not wrapped back',
    r.unitCross.past === false && r.unitCross.wrapped === true, JSON.stringify(r.unitCross));
  H.check('bounds [0,1.0000001] behave as unit bounds: drawn once in place, not tiled or wrapped',
    r.nearUnit.past === false && r.nearUnit.wrapped === true && r.nearUnit.repeated === true, JSON.stringify(r.nearUnit));
  H.check('widened bounds: block repeats with the lattice, gaps stay neutral, no NaN',
    r.wideCross.inFirst === false && r.wideCross.repeated === false && r.wideCross.gap === true && r.wideCross.nan === false,
    JSON.stringify(r.wideCross));
  H.check('degenerate block (one point on an axis): neutral everywhere, no NaN',
    r.degenerate.neutral === true && r.degenerate.nan === false, JSON.stringify(r.degenerate));
  H.check('DW-3.3 periodic field still wraps into its own cell', r.periodic.inCell && r.periodic.wrapped, JSON.stringify(r.periodic));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
