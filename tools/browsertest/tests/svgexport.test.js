// SVG export (render/SvgExportModule.captureSceneToSvg). The point of this
// format is that the file opens in Inkscape as editable ASSETS, so the checks
// are about structure, not pixels: named layers, real <text> elements, one
// embedded <image> in raster mode and none in vector mode — plus the two
// things that break silently, namely that the SVG still RENDERS (rasterised
// back through an <img>) and that the live view survives the capture.
//
// The samples are written to artifacts/ so xmllint and Inkscape can be pointed
// at them: those are off-browser checks this file can't make.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const ARTIFACTS = path.join(__dirname, 'artifacts');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }

  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await page.waitForTimeout(500);

  // A distance measurement gives the export a value pill to turn into <text>
  // (atoms are an InstancedMesh, so feed the API proxy objects — same trick as
  // pngexport.test.js). The pill is a sprite, so its text lives in userData,
  // not in a DOM element.
  const labelText = await page.evaluate(async () => {
    const { addDistanceMeasurement } = await import('./render/MeasurementModule.js');
    const { measurements, fileBrowser } = await import('./state/store.js');
    const { fracToCart } = await import('./math/index.js');
    const THREE = await import('./external/three/three.module.js');
    const s = fileBrowser.selectedStructure;
    if (!s || !s.atoms || s.atoms.length < 2) return '';
    const mk = (i) => ({
      position: new THREE.Vector3(...fracToCart([s.atoms[i].position], s.lattice)[0]),
      userData: { atomIndex: i, element: s.elements[i] },
    });
    addDistanceMeasurement(mk(0), mk(1));
    const last = measurements.measureLabels[measurements.measureLabels.length - 1];
    return String(last?.userData?.labelText || '').trim();
  });
  H.check('measurement label present for export', labelText.length > 0, `label="${labelText}"`);

  const res = await page.evaluate(async () => {
    const { captureSceneToSvg } = await import('./render/index.js');
    const { app, groups } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const INK_NS = 'http://www.inkscape.org/namespaces/inkscape';

    /** What a figure editor would see in the file. */
    const inspect = (text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const err = doc.querySelector('parsererror');
      const svg = doc.documentElement;
      const groupsOf = [...doc.getElementsByTagNameNS(SVG_NS, 'g')];
      const layerEls = groupsOf.filter((g) => g.getAttributeNS(INK_NS, 'groupmode') === 'layer');
      const images = [...doc.getElementsByTagNameNS(SVG_NS, 'image')];
      const ids = [...doc.getElementsByTagName('*')]
        .map((el) => el.getAttribute('id')).filter(Boolean);
      const bg = layerEls.find((g) => g.getAttributeNS(INK_NS, 'label') === 'Background');
      return {
        parseError: err ? err.textContent.slice(0, 200) : null,
        root: svg.nodeName,
        width: svg.getAttribute('width'),
        height: svg.getAttribute('height'),
        viewBox: svg.getAttribute('viewBox'),
        hasInkscapeNs: !!svg.getAttribute('xmlns:inkscape'),
        layers: layerEls.map((g) => g.getAttributeNS(INK_NS, 'label')),
        imageCount: images.length,
        imageHref: images.length ? (images[0].getAttribute('href') || '').slice(0, 22) : '',
        texts: [...doc.getElementsByTagNameNS(SVG_NS, 'text')].map((t) => t.textContent),
        baselineAttrs: [...doc.getElementsByTagName('*')].filter((el) => el
          .hasAttribute('dominant-baseline') || el.hasAttribute('alignment-baseline')).length,
        clippedLayers: layerEls.filter((g) => g.hasAttribute('clip-path')).length,
        circles: doc.getElementsByTagNameNS(SVG_NS, 'circle').length,
        measurementMarkers: doc.querySelectorAll('g.measurement-marker').length,
        lines: doc.getElementsByTagNameNS(SVG_NS, 'line').length,
        gradients: doc.getElementsByTagNameNS(SVG_NS, 'radialGradient').length
          + doc.getElementsByTagNameNS(SVG_NS, 'linearGradient').length,
        backgroundRects: bg ? bg.getElementsByTagNameNS(SVG_NS, 'rect').length : 0,
        uniqueIds: new Set(ids).size === ids.length,
        idCount: ids.length,
      };
    };

    /** Rasterise through an <img> and count pixels that differ from the
     *  top-left corner — proof the file renders, not just that it parses. */
    const rasterise = async (text, w, h) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
      try {
        const img = new Image();
        img.width = w;
        img.height = h;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('the SVG failed to load into an <img>'));
          img.src = url;
        });
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const c0 = [d[0], d[1], d[2], d[3]];
        let differing = 0;
        let sampled = 0;
        for (let i = 0; i < d.length; i += 4 * 37) {
          sampled++;
          if (Math.abs(d[i] - c0[0]) + Math.abs(d[i + 1] - c0[1])
            + Math.abs(d[i + 2] - c0[2]) + Math.abs(d[i + 3] - c0[3]) > 24) differing++;
        }
        return { differing, sampled };
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    const blob = await captureSceneToSvg({ width: 640, height: 480, structure: 'raster' });
    const text = await blob.text();
    const transparentText = await (await captureSceneToSvg({
      width: 320, height: 240, transparent: true, structure: 'raster',
    })).text();

    const size = app.renderer.getSize(new THREE.Vector2());
    const view = document.getElementById('view');
    const out = {
      type: blob.type,
      text,
      info: inspect(text),
      transparent: inspect(transparentText),
      render: await rasterise(text, 640, 480),
      restoredW: Math.round(size.x),
      restoredH: Math.round(size.y),
      viewW: view.clientWidth,
      viewH: view.clientHeight,
      visibleAtoms: groups.atomsMesh?.visible ? (groups.atomsMesh.count || 0) : 0,
    };

    // Vector mode is a separate module (render/SvgSceneVector.js); report a
    // missing/throwing one as one clear failure rather than a wall of them.
    try {
      const vecText = await (await captureSceneToSvg({
        width: 640, height: 480, structure: 'vector',
      })).text();
      out.vector = {
        available: true,
        text: vecText,
        info: inspect(vecText),
        render: await rasterise(vecText, 640, 480),
      };
    } catch (e) {
      out.vector = { available: false, error: String((e && e.message) || e) };
    }
    return out;
  });

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const samplePath = path.join(ARTIFACTS, 'svgexport-raster.svg');
  fs.writeFileSync(samplePath, res.text);
  console.log(`  wrote ${samplePath} (${res.text.length} bytes)`);

  const info = res.info;
  H.check('raster: blob is image/svg+xml', /^image\/svg\+xml/.test(res.type), res.type);
  H.check('raster: parses as SVG', !info.parseError && info.root === 'svg',
    info.parseError || info.root);
  H.check('raster: page box is the requested size',
    info.width === '640' && info.height === '480' && info.viewBox === '0 0 640 480',
    `${info.width}x${info.height} viewBox=${info.viewBox}`);
  H.check('raster: inkscape namespace declared', info.hasInkscapeNs);
  H.check('raster: expected layers present',
    ['Background', 'Structure (raster)', 'Measurements', 'Axes', 'Color bars',
      'Composition legend'].every((name) => info.layers.includes(name)),
    JSON.stringify(info.layers));
  H.check('raster: exactly one embedded PNG image',
    info.imageCount === 1 && info.imageHref.startsWith('data:image/png;base64'),
    `${info.imageCount} image(s), href="${info.imageHref}"`);
  H.check('raster: the measurement label is a real <text>',
    info.texts.includes(labelText), JSON.stringify(info.texts.slice(0, 12)));
  H.check('raster: a/b/c axis labels are real <text>',
    ['a', 'b', 'c'].every((ch) => info.texts.includes(ch)),
    JSON.stringify(info.texts.slice(0, 12)));
  H.check('raster: no dominant-baseline/alignment-baseline (Inkscape ignores them)',
    info.baselineAttrs === 0, `count=${info.baselineAttrs}`);
  H.check('raster: no clip-path on any layer', info.clippedLayers === 0,
    `count=${info.clippedLayers}`);
  H.check('raster: every id is unique', info.uniqueIds, `ids=${info.idCount}`);
  H.check('raster: the background layer carries a rect', info.backgroundRects === 1,
    `rects=${info.backgroundRects}`);
  H.check('raster: the file renders to real pixels',
    res.render.differing > res.render.sampled * 0.05, JSON.stringify(res.render));

  H.check('transparent: no background layer at all',
    !res.transparent.layers.includes('Background'), JSON.stringify(res.transparent.layers));
  H.check('transparent: still an SVG with the structure image',
    !res.transparent.parseError && res.transparent.imageCount === 1,
    res.transparent.parseError || `images=${res.transparent.imageCount}`);

  H.check('live view restored after the SVG export',
    res.restoredW === res.viewW && res.restoredH === res.viewH,
    `renderer=${res.restoredW}x${res.restoredH} view=${res.viewW}x${res.viewH}`);

  if (!res.vector.available) {
    H.check('vector mode is available (render/SvgSceneVector.js)', false, res.vector.error);
  } else {
    fs.writeFileSync(path.join(ARTIFACTS, 'svgexport-vector.svg'), res.vector.text);
    const v = res.vector.info;
    H.check('vector: parses as SVG', !v.parseError && v.root === 'svg', v.parseError || v.root);
    H.check('vector: nothing is embedded as a bitmap', v.imageCount === 0,
      `images=${v.imageCount}`);
    H.check('vector: one circle per visible atom, at least',
      v.circles >= res.visibleAtoms && res.visibleAtoms > 0,
      `circles=${v.circles} atoms=${res.visibleAtoms}`);
    H.check('vector: the unit cell contributes at least its 12 edges',
      v.lines >= 12, `lines=${v.lines}`);
    H.check('vector: measurement atom highlights are editable marker groups',
      v.measurementMarkers >= 2, `markers=${v.measurementMarkers}`);
    H.check('vector: shaded atoms come from gradients in <defs>', v.gradients > 0,
      `gradients=${v.gradients}`);
    H.check('vector: overlays are still layers with real <text>',
      v.layers.includes('Measurements') && v.texts.includes(labelText),
      JSON.stringify({ layers: v.layers, texts: v.texts.slice(0, 12) }));
    H.check('vector: every id is unique', v.uniqueIds, `ids=${v.idCount}`);
    H.check('vector: the file renders to real pixels',
      res.vector.render.differing > res.vector.render.sampled * 0.02,
      JSON.stringify(res.vector.render));
  }

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
