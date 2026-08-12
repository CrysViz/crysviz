// Occupancy checkpoint: CIF disorder uses the same WedgeAtoms ordering in both
// tracers, and the pie shader is assembled only while an occupancy atom exists.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

const CIF = `data_mixed
_cell_length_a 8
_cell_length_b 8
_cell_length_c 8
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Na1 Na 0.50 0.50 0.50 0.55
Cl1 Cl 0.50 0.50 0.50 0.45
C1 C 0.15 0.15 0.15 0.70
`;

function pixel(file, x, y) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const ix = Math.max(0, Math.min(png.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(png.height - 1, Math.round(y)));
  const o = (iy * png.width + ix) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2]];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'mixed.cif');
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25;
    general.rtRasterPreview = false;
  }, CIF);
  await page.waitForTimeout(1500);

  const model = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return { atomCount: s?.atoms?.length ?? 0,
      disordered: !!s?.atoms?.some((a) => a.isDisordered?.()),
      species: s?.atoms?.map((a) => a.species) ?? [] };
  });
  H.check('CIF fixture groups two co-located rows into a partial site',
    model.atomCount === 2 && model.disordered, JSON.stringify(model));
  const vacancyState = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { wedgeDataForAtom } = await import('./render/WedgeAtoms.js');
    const atom = fileBrowser.selectedStructure.atoms.find((a) => a.species?.some((s) => s.element === 'C'));
    const wedge = wedgeDataForAtom(atom);
    return { hasVacancySlot: !!wedge?.slots?.some((s) => s.vacancy),
      hasVacancyHatch: !!wedge?.packed?.some((v) => v < 0) };
  });
  H.check('occupancy data retains an implicit vacancy hatch wedge',
    vacancyState.hasVacancySlot && vacancyState.hasVacancyHatch, JSON.stringify(vacancyState));

  const sourceState = await page.evaluate(async () => {
    const { makeSceneFragment } = await import('./render/pipeline/raytrace/sceneFragment.js');
    const { makePtSceneFragment } = await import('./render/pipeline/pathtrace/ptSceneFragment.js');
    const digest = async (source) => [...new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(source)))].map((v) => v.toString(16).padStart(2, '0')).join('');
    const ray = makeSceneFragment();
    const path = makePtSceneFragment();
    return { rayHash: await digest(ray), pathHash: await digest(path),
      rayHasMarker: ray.includes('pieAtomColor'), pathHasMarker: path.includes('pieAtomColor') };
  });
  H.check('no-occupancy ray source retains the committed byte hash',
    sourceState.rayHash === '1ac4c121a6d76a452623349dca332b537a79fc89ea3de9bc50316fd39fac70f2'
      && !sourceState.rayHasMarker, JSON.stringify(sourceState));
  H.check('no-occupancy path source retains the committed byte hash',
    sourceState.pathHash === '1e62ed52acefc3e11f697ce27673c87c3765363631c902dcb911192f0a334631'
      && !sourceState.pathHasMarker, JSON.stringify(sourceState));

  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const mixedIndex = s.atoms.findIndex((a) => a.isDisordered?.());
    s.atomUserMaterials = s.atomUserMaterials ?? {};
    s.atomUserMaterials[mixedIndex] = { type: 'emissive', intensity: 8 };
  });
  await page.waitForTimeout(700);
  const raster = await H.shotCanvas(page, 'tracer-occupancy-raster');
  const sampleGeometry = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, groups } = await import('./state/store.js');
    const matrix = new THREE.Matrix4();
    app.camera.updateMatrixWorld();
    groups.atomsMesh.updateWorldMatrix(true, false);
    groups.atomsMesh.getMatrixAt(1, matrix);
    const worldMatrix = new THREE.Matrix4().multiplyMatrices(groups.atomsMesh.matrixWorld, matrix);
    const worldCenter = new THREE.Vector3().setFromMatrixPosition(worldMatrix);
    const center = worldCenter.clone().project(app.camera);
    const edge = worldCenter.clone().add(new THREE.Vector3(worldMatrix.elements[0], worldMatrix.elements[1], worldMatrix.elements[2]))
      .project(app.camera);
    const rect = app.renderer.domElement.getBoundingClientRect();
    const radius = Math.max(8, Math.abs(edge.x - center.x) * rect.width * 0.65);
    return { x: rect.left + (center.x + 1) * rect.width / 2,
      y: rect.top + (1 - center.y) * rect.height / 2, radius };
  });
  // WedgeAtoms' atan(y,x) ordering puts the two species on opposite vertical
  // sides for a 55/45 split, so these screen samples straddle the boundary.
  const sampleX = sampleGeometry.x - 460 - sampleGeometry.radius * 0.2;
  const sampleY = sampleGeometry.y - 120;
  const rasterTop = pixel(raster, sampleX, sampleY - sampleGeometry.radius * 0.6);
  const rasterBottom = pixel(raster, sampleX, sampleY + sampleGeometry.radius * 0.6);
  H.check('raster occupancy pie contains two different species colours',
    distance(rasterTop, rasterBottom) > 25, JSON.stringify({ rasterTop, rasterBottom, sampleGeometry }));

  const waitTracer = async () => H.waitFor(page, async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return p?._shaderState === 'ready' && p._uniforms.uSampleCounter.value >= 8;
  }, { timeout: 90000, interval: 500 });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitTracer();
  const rayState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const e = p._encoder;
    return { hasOccupancy: e.hasOccupancy, hasEmissive: e.hasEmissive,
      emissiveCount: e.emissiveCount, atomCount: e.atomCount,
      occupancyTexture: e.occupancyTexture.image.width * e.occupancyTexture.image.height,
      shaderHasPie: p._rtMesh.material.fragmentShader.includes('pieAtomColor'),
      folded: e.occupancyFoldedSites };
  });
  H.check('ray encoder flags and uploads the occupancy table',
    rayState.hasOccupancy && rayState.hasEmissive && rayState.emissiveCount > 0
      && rayState.shaderHasPie && rayState.occupancyTexture >= 4,
    JSON.stringify(rayState));
  const rayFile = await H.shotCanvas(page, 'tracer-occupancy-ray');
  const rayTop = pixel(rayFile, sampleX, sampleY - sampleGeometry.radius * 0.6);
  const rayBottom = pixel(rayFile, sampleX, sampleY + sampleGeometry.radius * 0.6);
  H.check('ray occupancy pie exposes two angular species colours',
    distance(rayTop, rayBottom) > 15, JSON.stringify({ rayTop, rayBottom }));
  H.check('ray and raster pies agree on the two sampled colours',
    distance(rayTop, rasterTop) < 150 && distance(rayBottom, rasterBottom) < 150,
    JSON.stringify({ rayTop, rayBottom, rasterTop, rasterBottom }));

  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await waitTracer();
  const pathFile = await H.shotCanvas(page, 'tracer-occupancy-path');
  const pathTop = pixel(pathFile, sampleX, sampleY - sampleGeometry.radius * 0.6);
  const pathBottom = pixel(pathFile, sampleX, sampleY + sampleGeometry.radius * 0.6);
  H.check('path tracer resolves pie-selected emissive species colours',
    distance(pathTop, pathBottom) > 15, JSON.stringify({ pathTop, pathBottom }));
  H.check('path tracer renders occupancy pie pixels', H.nonUniformFraction(pathFile) > 0.005,
    JSON.stringify({ nonUniform: H.nonUniformFraction(pathFile) }));

  // Toggle the disorder away and back in-place. Drive each transition render
  // synchronously so the compile-gate invariant is observable: source swaps
  // enter compiling and the transition frame accumulates zero samples.
  const transition = async (partial) => page.evaluate(async (isPartial) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    s.atoms[0].species = isPartial
      ? [{ element: 'C', occupancy: 0.70, oxidationState: null, color: null }]
      : [{ element: 'C', occupancy: 1, oxidationState: null, color: null }];
    s.atoms[1].species = isPartial
      ? [{ element: 'Na', occupancy: 0.55, oxidationState: null, color: null },
        { element: 'Cl', occupancy: 0.45, oxidationState: null, color: null }]
      : [{ element: 'Na', occupancy: 1, oxidationState: null, color: null }];
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    // The UI requestRender normally marks this sticky flag through the next
    // coordinator pass; set it explicitly so this checkpoint drives the
    // transition frame synchronously and cannot race that pass.
    p._sceneDirty = true;
    const before = p._uniforms.uSampleCounter.value;
    p.render({ renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: false });
    return { before, after: p._uniforms.uSampleCounter.value, state: p._shaderState,
      hasOccupancy: p._encoder.hasOccupancy,
      shaderHasPie: p._rtMesh.material.fragmentShader.includes('pieAtomColor') };
  }, partial);
  const offTransition = await transition(false);
  H.check('occupancy on-to-off transition enters async compile with zero samples',
    offTransition.before >= 8 && offTransition.after === 0
      && offTransition.state === 'compiling' && !offTransition.hasOccupancy
      && !offTransition.shaderHasPie, JSON.stringify(offTransition));
  const toggled = await H.waitFor(page, async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return p?._shaderState === 'ready' && !p._encoder.hasOccupancy
      && !p._rtMesh.material.fragmentShader.includes('pieAtomColor');
  }, { timeout: 90000, interval: 500 });
  H.check('removing partial occupancy recompiles the tracer without the pie chunk', !!toggled,
    JSON.stringify(toggled));
  await waitTracer();
  const onTransition = await transition(true);
  H.check('occupancy off-to-on transition also defers with zero samples',
    onTransition.before >= 8 && onTransition.after === 0
      && onTransition.state === 'compiling' && onTransition.hasOccupancy
      && onTransition.shaderHasPie, JSON.stringify(onTransition));
  const restored = await H.waitFor(page, async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return p?._shaderState === 'ready' && p._encoder.hasOccupancy
      && p._rtMesh.material.fragmentShader.includes('pieAtomColor');
  }, { timeout: 90000, interval: 500 });
  H.check('restored partial occupancy recompiles with the pie chunk', !!restored,
    JSON.stringify(restored));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
