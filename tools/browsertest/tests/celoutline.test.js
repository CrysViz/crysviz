// Cel render style + screen-space outlines: material class switches, the
// polyhedra depth proxies exist, and the outline pass visibly draws (pixel
// assertion: near-black coverage grows with the outline width slider).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }

  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');

  // Polyhedra on (real Features toggle), wait for the async compute.
  await H.clickById(page, 'showPolyhedra');
  const polys = await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    let n = 0;
    groups.polyhedraGroup?.traverse((o) => { if (o.userData?.type === 'polyhedron') n++; });
    return n;
  });
  H.check('polyhedra rendered', polys > 0, `count=${polys}`);

  // Switch to cel via the real dropdown.
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(2000);

  const cel = await page.evaluate(async () => {
    const { groups, general } = await import('./state/store.js');
    let proxies = 0;
    groups.polyhedraGroup?.traverse((o) => {
      if (o.isMesh && o.layers.mask === (1 << 3)) proxies++;
    });
    return {
      style: general.renderStyle,
      atomsMat: groups.atomsMesh?.material?.type,
      bondsMat: groups.bondsMesh?.material?.type,
      atomsOnOutlineLayer: !!(groups.atomsMesh && (groups.atomsMesh.layers.mask & (1 << 3))),
      proxies,
    };
  });
  H.check('atoms use toon material', cel.atomsMat === 'MeshToonMaterial', cel.atomsMat);
  H.check('bonds use toon material', cel.bondsMat === 'MeshToonMaterial', cel.bondsMat);
  H.check('atoms on outline layer', cel.atomsOnOutlineLayer);
  H.check('polyhedra depth proxies exist', cel.proxies > 0, `count=${cel.proxies}`);

  // Outline visibility: near-black pixel coverage must grow with the slider
  // (quadratic slider in 0..1; 1 = max world-unit width).
  await H.setSlider(page, 'celOutlineWidth', 0);
  await page.waitForTimeout(600);
  const dark0 = H.darkFraction(await H.shotCanvas(page, 'cel_outline_off'));
  await H.setSlider(page, 'celOutlineWidth', 1);
  await page.waitForTimeout(600);
  const dark4 = H.darkFraction(await H.shotCanvas(page, 'cel_outline_wide'));
  H.check('outlines draw (dark coverage grows)',
    dark4 > dark0 * 1.3 && dark4 - dark0 > 0.002,
    `off=${dark0.toFixed(4)} wide=${dark4.toFixed(4)}`);

  // Hull outline mode: switching rebuilds meshes with inverted-hull children.
  await H.setSelect(page, 'celOutlineModeMenu', 'hull');
  const hulls = await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    let polyHulls = 0;
    groups.polyhedraGroup?.traverse((o) => { if (o.name === 'celOutline') polyHulls++; });
    const atomHull = !!groups.atomsMesh?.userData?.celOutline;
    const bondHull = !!groups.bondsMesh?.userData?.celOutline;
    return (atomHull && bondHull && polyHulls > 0) ? { atomHull, bondHull, polyHulls } : null;
  });
  H.check('hull mode: outline hulls created', !!hulls, JSON.stringify(hulls));
  await page.waitForTimeout(800);
  const darkHull = H.darkFraction(await H.shotCanvas(page, 'cel_outline_hull'));
  H.check('hull mode: outlines draw', darkHull > dark0 * 1.3 && darkHull - dark0 > 0.002,
    `off=${dark0.toFixed(4)} hull=${darkHull.toFixed(4)}`);

  // Hull outlines under the staged pipelines: the polyhedron hull shells are
  // OPAQUE CHILDREN of the TRANSPARENT face meshes — visibility-based stage
  // switching hid them in every stage (parent hidden in the opaque stage,
  // shell hidden in the transparent stages). The "Polyhedra Outline" width
  // slider drives ONLY the poly hulls, so dark coverage must respond to it.
  for (const id of ['wboit', 'depthpeel']) {
    await page.evaluate(async (id) => {
      const { setActivePipeline } = await import('./render/index.js');
      setActivePipeline(id);
    }, id);
    await H.setSlider(page, 'celHullPolyWidth', 0);
    await page.waitForTimeout(600);
    const polyOff = H.darkFraction(await H.shotCanvas(page, `cel_hull_${id}_off`));
    await H.setSlider(page, 'celHullPolyWidth', 0.2);
    await page.waitForTimeout(600);
    const polyOn = H.darkFraction(await H.shotCanvas(page, `cel_hull_${id}_on`));
    H.check(`hull mode under ${id}: polyhedra hull outlines draw`,
      polyOn - polyOff > 0.002,
      `off=${polyOff.toFixed(4)} on=${polyOn.toFixed(4)}`);
  }
  await page.evaluate(async () => {
    const { setActivePipeline } = await import('./render/index.js');
    setActivePipeline('forward');
  });
  await H.setSlider(page, 'celHullPolyWidth', 0.025); // restore default

  // Back to screen mode: hulls removed on rebuild.
  await H.setSelect(page, 'celOutlineModeMenu', 'screen');
  const noHulls = await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    let polyHulls = 0;
    groups.polyhedraGroup?.traverse((o) => { if (o.name === 'celOutline') polyHulls++; });
    return (!groups.atomsMesh?.userData?.celOutline && polyHulls === 0) ? true : null;
  });
  H.check('screen mode: hulls removed after switch back', !!noHulls);

  // Back to metallic: physical material again, outline pass inert.
  await H.setSlider(page, 'celOutlineWidth', 0.7); // ~default width
  await H.setSelect(page, 'renderStyleMenu', 'metallic');
  await page.waitForTimeout(2000);
  const metallic = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    return { atomsMat: groups.atomsMesh?.material?.type };
  });
  H.check('metallic restores physical material',
    metallic.atomsMat === 'MeshPhysicalMaterial', metallic.atomsMat);
  const darkBack = H.darkFraction(await H.shotCanvas(page, 'metallic_back'));
  H.check('no outlines in metallic', darkBack < dark4, `metallic=${darkBack.toFixed(4)}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
