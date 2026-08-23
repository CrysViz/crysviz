// Vector structure export (render/SvgSceneVector.buildVectorStructure):
// - the emitted defs+body wrap into a document that parses as SVG,
// - every visible atom becomes a <circle> and the unit cell 12 <line>s,
// - polyhedra faces come out as <polygon>s,
// - ids are unique and the global painter's sort really is far -> near,
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

    const _p = new THREE.Vector3();
    const _view = new THREE.Vector3();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const project = (x, y, z) => {
      _view.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      // behind the eye: no meaningful projection
      if (camera.isPerspectiveCamera && _view.z > -1e-6) return null;
      _p.set(x, y, z).project(camera);
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
    const ids = [...doc.querySelectorAll('[id]')].map((el) => el.getAttribute('id'));
    const uniqueIds = new Set(ids).size;

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
      polygons: doc.querySelectorAll('polygon').length,
      gradients: doc.querySelectorAll('defs radialGradient').length,
      idCount: ids.length,
      uniqueIds,
      orderBreaks,
      orderChecked: checked,
      drawn,
      sampledPixels: Math.ceil((width * height) / 17),
    };
  });

  H.check('wrapped SVG parses (no parsererror)', res.parseError === '', res.parseError);
  H.check('every visible atom is a <circle>',
    res.circles >= res.visibleAtoms && res.visibleAtoms > 0,
    `circles=${res.circles} visibleAtoms=${res.visibleAtoms}`);
  H.check('unit cell drawn as >= 12 edge lines', res.cellLines >= 12, `cellLines=${res.cellLines}`);
  H.check('bonds drawn as lines', res.bondLines > 0, `bondLines=${res.bondLines}`);
  H.check('polyhedra faces drawn as polygons', res.polygons > 0, `polygons=${res.polygons}`);
  H.check('one sphere gradient per distinct atom colour',
    res.gradients > 0 && res.gradients < res.circles,
    `gradients=${res.gradients}`);
  H.check('all element ids unique', res.idCount === res.uniqueIds,
    `${res.uniqueIds}/${res.idCount}`);
  H.check('painter’s sort is far -> near',
    res.orderBreaks === 0 && res.orderChecked > 10,
    `breaks=${res.orderBreaks} of ${res.orderChecked}`);
  H.check('rasterises to visible pixels',
    res.drawn > res.sampledPixels * 0.02,
    `painted=${res.drawn}/${res.sampledPixels}`);

  H.check('cel style: flat fills with dark outlines, no gradients',
    res.cel.parseError === '' && res.cel.gradients === 0
      && res.cel.circles > 0 && res.cel.outlined === res.cel.circles,
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
