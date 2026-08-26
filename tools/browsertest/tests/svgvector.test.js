// Vector structure export (render/SvgSceneVector.buildVectorStructure):
// - the emitted defs+body wrap into a document that parses as SVG,
// - every visible atom becomes a <circle> and the unit cell 12 <line>s,
// - polyhedra faces come out as <polygon>s,
// - ids are unique and the global painter's sort really is far -> near,
// - a cell edge running away from the camera is cut into pieces and each one
//   paints on the correct side of the atoms it crosses,
// - the whole thing rasterises to visible pixels in an <img>,
// - estimateVectorPrimitiveCount() matches what was actually emitted.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const SVG_OUT = path.join(__dirname, 'artifacts', 'svgvector.svg');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }

  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await page.waitForTimeout(500);
  // YBCO's coordination polyhedra are the face/edge test case.
  await H.clickById(page, 'showPolyhedra');
  await page.waitForTimeout(2500);

  const res = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, groups } = await import('./state/store.js');
    const { buildVectorStructure, estimateVectorPrimitiveCount } =
      await import('./render/SvgSceneVector.js');

    const view = document.getElementById('view');
    const width = view.clientWidth;
    const height = view.clientHeight;
    const camera = app.camera;
    camera.updateMatrixWorld();

    // Same projector shape the SVG export builds, for any camera: the module
    // itself never touches a camera, it only calls these two closures.
    const makeProjector = (cam) => {
      const _p = new THREE.Vector3();
      const _view = new THREE.Vector3();
      cam.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
      const project = (x, y, z) => {
        _view.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
        // behind the eye: no meaningful projection
        if (cam.isPerspectiveCamera && _view.z > -1e-6) return null;
        _p.set(x, y, z).project(cam);
        if (!Number.isFinite(_p.x) || !Number.isFinite(_p.y)) return null;
        return {
          x: (_p.x * 0.5 + 0.5) * width,
          y: (0.5 - _p.y * 0.5) * height,
          depth: -_view.z,
        };
      };
      const radiusPx = (x, y, z, r) => {
        const a = project(x, y, z);
        const b = project(x + right.x * r, y + right.y * r, z + right.z * r);
        if (!a || !b) return 0;
        return Math.hypot(b.x - a.x, b.y - a.y);
      };
      return { project, radiusPx };
    };
    const { project, radiusPx } = makeProjector(camera);

    const out = buildVectorStructure({ project, radiusPx, width, height, idPrefix: 'cv-' });
    const estimate = estimateVectorPrimitiveCount();

    // 'cel' swaps the sphere gradients for a flat fill + dark outline.
    const { general } = await import('./state/store.js');
    const prevStyle = general.renderStyle;
    general.renderStyle = 'cel';
    const celOut = buildVectorStructure({ project, radiusPx, width, height, idPrefix: 'cel-' });
    general.renderStyle = prevStyle;
    const celDoc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg"`
      + ` xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">`
      + `<defs>${celOut.defs}</defs>${celOut.body}</svg>`, 'image/svg+xml');
    const celCircles = [...celDoc.querySelectorAll('circle')];
    const cel = {
      parseError: celDoc.querySelector('parsererror') ? 'parsererror' : '',
      gradients: celDoc.querySelectorAll('radialGradient').length,
      outlined: celCircles.filter((c) => c.getAttribute('stroke')).length,
      bondOutlines: celDoc.querySelectorAll('line.bond-outline').length,
      circles: celCircles.length,
    };

    const svg = `<svg xmlns="http://www.w3.org/2000/svg"`
      + ` xmlns:xlink="http://www.w3.org/1999/xlink"`
      + ` xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`
      + ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
      + `<defs>${out.defs}</defs>`
      + `<g inkscape:groupmode="layer" inkscape:label="Structure" id="layer-structure">`
      + `${out.body}</g></svg>`;

    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const parseError = doc.querySelector('parsererror')?.textContent?.slice(0, 200) ?? '';

    // Visible atoms of the main mesh (radius 0 = hidden instance).
    let visibleAtoms = 0;
    const matrices = groups.atomsMesh?.instanceMatrix?.array;
    if (matrices) {
      for (let i = 0; i < groups.atomsMesh.count; i++) if (matrices[i * 16] > 0) visibleAtoms++;
    }

    const circles = [...doc.querySelectorAll('circle')];
    const bondOwnerPairs = [];
    for (const line of doc.querySelectorAll('line.bond')) {
      const owner = line.getAttribute('data-owner-atom');
      if (owner) bondOwnerPairs.push([line.id, owner]);
    }
    const ids = [...doc.querySelectorAll('[id]')].map((el) => el.getAttribute('id'));
    const uniqueIds = new Set(ids).size;
    const documentOrder = new Map(ids.map((id, index) => [id, index]));
    const bondOwnerOrderBreaks = bondOwnerPairs.filter(([bond, atom]) =>
      documentOrder.get(bond) >= documentOrder.get(atom)).length;

    // Painter's order: walk the atom circles in document order and re-project
    // each one. Depth must never increase (farther first, nearer last).
    let orderBreaks = 0;
    let lastDepth = Infinity;
    let checked = 0;
    for (const c of circles) {
      const m = /^cv-atom-(\d+)$/.exec(c.getAttribute('id') || '');
      if (!m || !matrices) continue;
      const o = Number(m[1]) * 16;
      const p = project(matrices[o + 12], matrices[o + 13], matrices[o + 14]);
      if (!p) continue;
      if (p.depth > lastDepth + 1e-6) orderBreaks++;
      lastDepth = p.depth;
      checked++;
    }

    // --- lattice z-order against the atoms -------------------------------
    // A <line> carries ONE depth into the painter's sort, so a unit-cell edge
    // running away from the camera is drawn wholly in front of or wholly
    // behind every atom it passes unless the export cuts it into pieces the
    // sort can resolve. Check it from an oblique camera of the test's own (the
    // module never touches a camera, only the two closures), so the cell edges
    // are guaranteed to span depth whatever view the app happens to be in.
    const zo = (() => {
      if (!matrices) return { checked: 0, breaks: 0, pieces: 0, longest: 0 };
      // Bounding sphere of the visible atoms -> a camera looking down a body
      // diagonal, where every cell edge is foreshortened.
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < groups.atomsMesh.count; i++) {
        const o = i * 16;
        if (!(matrices[o] > 0)) continue;
        for (let k = 0; k < 3; k++) {
          const v = matrices[o + 12 + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      if (!Number.isFinite(min[0])) return { checked: 0, breaks: 0, pieces: 0, longest: 0 };
      const mid = min.map((v, k) => (v + max[k]) / 2);
      const span = Math.max(...max.map((v, k) => v - min[k]), 1e-3);
      const cam = new THREE.PerspectiveCamera(45, width / height, 0.1, span * 20);
      const dir = new THREE.Vector3(1, 0.55, 1.25).normalize();
      cam.position.set(...mid).addScaledVector(dir, span * 2.2);
      cam.lookAt(mid[0], mid[1], mid[2]);
      cam.updateMatrixWorld();
      const proj = makeProjector(cam);
      const built = buildVectorStructure({ ...proj, width, height, idPrefix: 'zo-' });
      const zdoc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg"`
        + ` xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">`
        + `<defs>${built.defs}</defs>${built.body}</svg>`, 'image/svg+xml');
      const order = new Map();
      [...zdoc.querySelectorAll('[id]')].forEach((el, i) => order.set(el.getAttribute('id'), i));

      // Atom discs, in the same screen space the export drew them in.
      const discs = [];
      for (let i = 0; i < groups.atomsMesh.count; i++) {
        const o = i * 16;
        const r = matrices[o];
        if (!(r > 0) || !order.has(`zo-atom-${i}`)) continue;
        const x = matrices[o + 12], y = matrices[o + 13], z = matrices[o + 14];
        const p = proj.project(x, y, z);
        if (!p) continue;
        const rPx = proj.radiusPx(x, y, z, r);
        if (!(rPx > 1)) continue;
        discs.push({ id: `zo-atom-${i}`, p, r, rPx });
      }

      // Cell-edge pieces, grouped by the edge they came from: 'zo-cell-3' when
      // the edge needed no splitting, 'zo-cell-3-s0..' when it did.
      const byEdge = new Map();
      let pieces = 0;
      let longest = 0;
      for (const el of zdoc.querySelectorAll('line.cell-edge')) {
        const id = el.getAttribute('id') || '';
        const m = /^zo-cell-(\d+)(?:-s\d+)?$/.exec(id);
        if (!m) continue;
        const list = byEdge.get(m[1]) ?? [];
        list.push({
          id,
          x1: Number(el.getAttribute('x1')), y1: Number(el.getAttribute('y1')),
          x2: Number(el.getAttribute('x2')), y2: Number(el.getAttribute('y2')),
        });
        byEdge.set(m[1], list);
        pieces++;
        if (list.length > longest) longest = list.length;
      }

      // World endpoints of the same edges (LatticeModule's cylinder children).
      const _v = new THREE.Vector3();
      const _q = new THREE.Quaternion();
      const _s = new THREE.Vector3();
      const _a = new THREE.Vector3();
      const group = groups.latticeGroup;
      let checked = 0;
      let breaks = 0;
      let index = -1;
      for (const mesh of (group?.visible ? group.children ?? [] : [])) {
        if (!mesh.visible || !mesh.geometry?.parameters) continue;
        mesh.updateWorldMatrix(true, false);
        mesh.matrixWorld.decompose(_v, _q, _s);
        const len = (mesh.geometry.parameters.height ?? 1) * Math.abs(_s.y);
        const radius = (mesh.geometry.parameters.radiusTop ?? 0.015)
          * Math.max(Math.abs(_s.x), Math.abs(_s.z));
        if (!(len > 1e-6) || !(radius > 0)) continue;
        index++;
        const list = byEdge.get(String(index));
        if (!list) continue;
        _a.set(0, 1, 0).applyQuaternion(_q).normalize().multiplyScalar(len / 2);
        const e1 = _v.clone().sub(_a);
        const e2 = _v.clone().add(_a);
        const SAMPLES = 60;
        for (let k = 0; k < SAMPLES; k++) {
          const t = (k + 0.5) / SAMPLES;
          const wx = e1.x + (e2.x - e1.x) * t;
          const wy = e1.y + (e2.y - e1.y) * t;
          const wz = e1.z + (e2.z - e1.z) * t;
          const sp = proj.project(wx, wy, wz);
          if (!sp) continue;
          // The piece of this edge that paints this sample.
          let piece = null;
          let pieceD = Infinity;
          for (const seg of list) {
            const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
            const l2 = dx * dx + dy * dy || 1;
            const u = Math.max(0, Math.min(1, ((sp.x - seg.x1) * dx + (sp.y - seg.y1) * dy) / l2));
            const d = Math.hypot(seg.x1 + dx * u - sp.x, seg.y1 + dy * u - sp.y);
            if (d < pieceD) { pieceD = d; piece = seg; }
          }
          if (!piece || pieceD > 1.5) continue;
          for (const disc of discs) {
            const d = Math.hypot(sp.x - disc.p.x, sp.y - disc.p.y);
            // Stay off the silhouette, where "in front" is a coin flip.
            if (d > disc.rPx * 0.85) continue;
            const bulge = disc.r * Math.sqrt(Math.max(0, 1 - (d / disc.rPx) ** 2));
            const skin = disc.r * 0.15; // grazing contact: not a real ordering
            let edgeInFront;
            if (sp.depth < disc.p.depth - bulge - skin) edgeInFront = true;
            else if (sp.depth > disc.p.depth + bulge + skin) edgeInFront = false;
            else continue;
            checked++;
            const painted = order.get(piece.id) > order.get(disc.id);
            if (painted !== edgeInFront) breaks++;
          }
        }
      }
      return { checked, breaks, pieces, longest };
    })();

    // Rasterise the wrapped document and count painted pixels.
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const drawn = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0, width, height);
        const d = cx.getImageData(0, 0, width, height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4 * 17) if (d[i] > 8) painted++;
        resolve(painted);
      };
      img.onerror = () => resolve(-1);
      img.src = url;
    });
    URL.revokeObjectURL(url);

    return {
      svg,
      cel,
      counts: out.counts,
      skipped: out.skipped,
      estimate,
      parseError,
      visibleAtoms,
      circles: circles.length,
      cellLines: doc.querySelectorAll('line.cell-edge').length,
      bondLines: doc.querySelectorAll('line.bond').length,
      bondOwnerOrderBreaks,
      bondOwnerOrderChecked: bondOwnerPairs.length,
      polygons: doc.querySelectorAll('polygon').length,
      gradients: doc.querySelectorAll('defs radialGradient').length,
      idCount: ids.length,
      uniqueIds,
      orderBreaks,
      orderChecked: checked,
      drawn,
      zo,
      sampledPixels: Math.ceil((width * height) / 17),
    };
  });

  H.check('wrapped SVG parses (no parsererror)', res.parseError === '', res.parseError);
  H.check('every visible atom is a <circle>',
    res.circles >= res.visibleAtoms && res.visibleAtoms > 0,
    `circles=${res.circles} visibleAtoms=${res.visibleAtoms}`);
  H.check('unit cell drawn as >= 12 edge lines', res.cellLines >= 12, `cellLines=${res.cellLines}`);
  H.check('bonds drawn as lines', res.bondLines > 0, `bondLines=${res.bondLines}`);
  H.check('owning atoms paint over their buried bond caps',
    res.bondOwnerOrderChecked > 0 && res.bondOwnerOrderBreaks === 0,
    `breaks=${res.bondOwnerOrderBreaks} of ${res.bondOwnerOrderChecked}`);
  H.check('polyhedra faces drawn as polygons', res.polygons > 0, `polygons=${res.polygons}`);
  H.check('one sphere gradient per distinct atom colour',
    res.gradients > 0 && res.gradients < res.circles,
    `gradients=${res.gradients}`);
  H.check('all element ids unique', res.idCount === res.uniqueIds,
    `${res.uniqueIds}/${res.idCount}`);
  H.check('painter’s sort is far -> near',
    res.orderBreaks === 0 && res.orderChecked > 10,
    `breaks=${res.orderBreaks} of ${res.orderChecked}`);
  H.check('a foreshortened cell edge is split into depth-sorted pieces',
    res.zo.longest > 1 && res.zo.pieces >= 12,
    `longest=${res.zo.longest} pieces=${res.zo.pieces}`);
  H.check('cell edges paint on the right side of the atoms they cross',
    res.zo.checked > 50 && res.zo.breaks <= res.zo.checked * 0.02,
    `breaks=${res.zo.breaks} of ${res.zo.checked}`);

  H.check('rasterises to visible pixels',
    res.drawn > res.sampledPixels * 0.02,
    `painted=${res.drawn}/${res.sampledPixels}`);

  H.check('cel style: flat fills with dark outlines, no gradients',
    res.cel.parseError === '' && res.cel.gradients === 0
      && res.cel.circles > 0 && res.cel.outlined === res.cel.circles
      && res.cel.bondOutlines > 0,
    JSON.stringify(res.cel));

  const sum = Object.values(res.counts).reduce((a, b) => a + b, 0);
  H.check('estimate is a tight upper bound on what was emitted',
    res.estimate >= sum && res.estimate <= sum * 1.25,
    `estimate=${res.estimate} emitted=${sum} ${JSON.stringify(res.counts)}`);

  fs.mkdirSync(path.dirname(SVG_OUT), { recursive: true });
  fs.writeFileSync(SVG_OUT, res.svg);
  console.log(`  sample written to ${SVG_OUT} (${res.svg.length} bytes)`);
  console.log(`  skipped: ${JSON.stringify(res.skipped)}`);

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
