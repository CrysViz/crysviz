// Element Materials Map: the per-species tracer-material presets
// (defaults/material_defaults.js -> Structure.getDefaultElementMaterial ->
// SceneEncoder cascade) and their "Element Materials Map" dropdown in the
// Visual window (ui/ColorPanel.js) — resolver categories, editor
// default-awareness, tracer-only gating, atom+bond texel encoding, the
// color-palette-parity wipe on switch, and ShareModule persistence
// (colors.elementMaterialsMap, v2.15; absent key = pre-map state = 'standard').
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

function changedPixelCount(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 90) n++;
  }
  return n;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO: Y, Ba, Cu, O

  // --- Resolver: category presets under 'crysviz', null under 'standard' ---------
  const resolver = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const probe = () => ({
      Cu: s.getDefaultElementMaterial('Cu'),   // polished metal
      Ba: s.getDefaultElementMaterial('Ba'),   // alkaline-earth metal
      O: s.getDefaultElementMaterial('O'),     // matte nonmetal
      He: s.getDefaultElementMaterial('He'),   // noble-gas glass bubble
      Cl: s.getDefaultElementMaterial('Cl'),   // waxy halogen
      Si: s.getDefaultElementMaterial('Si'),   // metalloid sheen
      Xx: s.getDefaultElementMaterial('Xx'),   // unknown -> null
    });
    const shipped = general.elementMaterialsMap;
    const crysviz = probe();
    general.elementMaterialsMap = 'standard';
    const standard = probe();
    general.elementMaterialsMap = 'crysviz';
    return { shipped, crysviz, standard };
  });
  H.check('map ships as crysviz and resolves the category presets',
    resolver.shipped === 'crysviz'
      && resolver.crysviz.Cu?.type === 'metal' && Math.abs(resolver.crysviz.Cu.roughness - 0.05) < 1e-9
      && resolver.crysviz.Ba?.type === 'metal' && Math.abs(resolver.crysviz.Ba.roughness - 0.3) < 1e-9
      && resolver.crysviz.O?.type === 'standard' && Math.abs(resolver.crysviz.O.gloss - 0.5) < 1e-9
      && resolver.crysviz.He?.type === 'glass' && Math.abs(resolver.crysviz.He.ior - 1.05) < 1e-9
      && resolver.crysviz.Cl?.type === 'translucent'
      && resolver.crysviz.Si?.type === 'standard' && Math.abs(resolver.crysviz.Si.reflectivity - 0.3) < 1e-9
      && resolver.crysviz.Xx === null,
    JSON.stringify(resolver.crysviz));
  H.check('the standard map resolves no presets',
    Object.values(resolver.standard).every((m) => m === null), JSON.stringify(resolver.standard));

  // --- MaterialEditor default-awareness (getDefault seeds + clear-to-default) ----
  const editorCheck = await page.evaluate(async () => {
    const { createMaterialEditor } = await import('./ui/StructureInfoPanel/components/MaterialEditor.js');
    const { fileBrowser } = await import('./state/store.js');
    const structure = fileBrowser.selectedStructure;
    const calls = [];
    let stored;
    const editor = createMaterialEditor(
      () => stored,
      (m) => { calls.push(m); stored = m ?? undefined; },
      { getDefault: () => structure.getDefaultElementMaterial('Cu') });
    document.body.appendChild(editor);
    const sel = editor.querySelector('.material-type-select');
    const roughSlider = editor.querySelector('.material-roughness-row input');
    const seeded = { type: sel.value, rough: roughSlider.value };
    // an untouched commit equals the map preset -> clears the entry
    sel.dispatchEvent(new Event('change'));
    const clearedOnUntouched = calls.length === 1 && calls[0] === null;
    // a real edit stores an entry
    roughSlider.value = '0.6';
    roughSlider.dispatchEvent(new Event('input'));
    const storedOnEdit = !!stored && stored.type === 'metal' && Math.abs(stored.roughness - 0.6) < 1e-9;
    // clearing the store + syncFromStore returns the editor to the map preset
    stored = undefined;
    editor.syncFromStore();
    const resynced = { type: sel.value, rough: roughSlider.value };
    editor.remove();
    return { seeded, clearedOnUntouched, storedOnEdit, resynced };
  });
  H.check('material editor seeds from the map preset and clears back to it',
    editorCheck.seeded.type === 'metal' && Math.abs(parseFloat(editorCheck.seeded.rough) - 0.05) < 1e-9
      && editorCheck.clearedOnUntouched && editorCheck.storedOnEdit
      && editorCheck.resynced.type === 'metal'
      && Math.abs(parseFloat(editorCheck.resynced.rough) - 0.05) < 1e-9,
    JSON.stringify(editorCheck));

  // --- Dropdown: next to the Element Color Map, tracer-gated ----------------------
  const dropdownRaster = await page.evaluate(() => {
    const select = document.getElementById('atomsElementMaterialsMapMenu');
    const row = select?.closest('.control-row');
    const colorRow = document.getElementById('atomsElementColorMapMenu')?.closest('.control-row');
    return {
      exists: !!select,
      value: select?.value,
      besideColorMap: !!row && !!colorRow && row.parentElement === colorRow.parentElement,
      hiddenUnderRaster: row ? getComputedStyle(row).display === 'none' : false,
    };
  });
  H.check('materials-map dropdown sits beside the color map and hides under raster',
    dropdownRaster.exists && dropdownRaster.value === 'crysviz'
      && dropdownRaster.besideColorMap && dropdownRaster.hiddenUnderRaster,
    JSON.stringify(dropdownRaster));

  // --- Persistence (still raster; applySharedState reloads the structure) --------
  const persist = await page.evaluate(async () => {
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { general } = await import('./state/store.js');
    const state = captureState();
    const version = state.version;
    const captured = state.colors?.elementMaterialsMap;
    applySharedState(JSON.parse(JSON.stringify(state)), 'roundtrip.vasp');
    const roundTrip = general.elementMaterialsMap;
    const roundTripSelect = document.getElementById('atomsElementMaterialsMapMenu')?.value;
    // a pre-map (v2.14-era) state has no key: restore must force 'standard'
    const legacy = JSON.parse(JSON.stringify(state));
    delete legacy.colors.elementMaterialsMap;
    applySharedState(legacy, 'legacy.vasp');
    const legacyMap = general.elementMaterialsMap;
    const legacySelect = document.getElementById('atomsElementMaterialsMapMenu')?.value;
    return { version, captured, roundTrip, roundTripSelect, legacyMap, legacySelect };
  });
  H.check('elementMaterialsMap persists at v2.15 and absent-key restores to standard',
    persist.version === '2.15' && persist.captured === 'crysviz'
      && persist.roundTrip === 'crysviz' && persist.roundTripSelect === 'crysviz'
      && persist.legacyMap === 'standard' && persist.legacySelect === 'standard',
    JSON.stringify(persist));
  await H.setSelect(page, 'atomsElementMaterialsMapMenu', 'crysviz'); // back to the default

  // --- Tracer: presets encode into the atom + bond-half texels --------------------
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false;
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(3500);

  const dropdownTracer = await page.evaluate(() => {
    const row = document.getElementById('atomsElementMaterialsMapMenu')?.closest('.control-row');
    return { visible: row ? getComputedStyle(row).display !== 'none' : false };
  });
  H.check('materials-map dropdown shows under the tracer', dropdownTracer.visible,
    JSON.stringify(dropdownTracer));

  const readTexels = async () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const enc = app.pipeline._encoder;
    const atoms = enc.atomsTexture.image.data;
    let metalAtoms = 0, matteAtoms = 0, otherAtoms = 0;
    for (let i = 0; i < enc.atomCount; i++) {
      const type = atoms[i * 12 + 8];
      if (type === 1) metalAtoms++;
      else if (type === 0 && Math.abs(atoms[i * 12 + 10] - 0.5) < 1e-6) matteAtoms++; // O gloss 0.5
      else if (type !== 0) otherAtoms++;
    }
    const cyls = enc.cylindersTexture.image.data;
    let metalHalves = 0, polishedHalves = 0;
    for (let i = 0; i < enc.cylinderCount; i++) {
      if (cyls[i * 32 + 24] === 1) {
        metalHalves++;
        if (Math.abs(cyls[i * 32 + 25] - 0.05) < 1e-6) polishedHalves++; // Cu half roughness
      }
    }
    return { metalAtoms, matteAtoms, otherAtoms, metalHalves, polishedHalves };
  });

  const crysvizTexels = await readTexels();
  H.check('crysviz map: Y/Ba/Cu atoms encode as metal, O as matte standard, bond halves inherit',
    crysvizTexels.metalAtoms > 0 && crysvizTexels.matteAtoms > 0 && crysvizTexels.otherAtoms === 0
      && crysvizTexels.metalHalves > 0 && crysvizTexels.polishedHalves > 0,
    JSON.stringify(crysvizTexels));
  const crysvizShot = await H.shotCanvas(page, 'materialsmap-crysviz');

  await H.setSelect(page, 'atomsElementMaterialsMapMenu', 'standard');
  await page.waitForTimeout(3500);
  const standardTexels = await readTexels();
  H.check('standard map: every primitive returns to the plain standard texel',
    standardTexels.metalAtoms === 0 && standardTexels.matteAtoms === 0
      && standardTexels.otherAtoms === 0 && standardTexels.metalHalves === 0,
    JSON.stringify(standardTexels));
  const standardShot = await H.shotCanvas(page, 'materialsmap-standard');
  const mapDelta = changedPixelCount(crysvizShot, standardShot);
  H.check('switching the materials map visibly changes the traced image',
    mapDelta > 500, JSON.stringify({ mapDelta }));

  // --- Color-palette parity: switching the map wipes manual material edits --------
  const wipe = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = { Cu: { type: 'glass', ior: 2.0 } };
    structure.atomUserMaterials = { 0: { type: 'emissive', intensity: 3 } };
    structure.bondCategoryStyles['Cu-O'] = { color: 0x123456, material: { type: 'metal' } };
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('atomsElementMaterialsMapMenu'));
    select.value = 'crysviz';
    select.dispatchEvent(new Event('change'));
    return {
      atomMaterials: Object.keys(structure.atomMaterials).length,
      atomUserMaterials: Object.keys(structure.atomUserMaterials).length,
      bondMaterialGone: structure.bondCategoryStyles['Cu-O'].material === undefined,
      bondColorKept: structure.bondCategoryStyles['Cu-O'].color === 0x123456,
    };
  });
  H.check('map switch wipes manual material edits but keeps non-material style fields',
    wipe.atomMaterials === 0 && wipe.atomUserMaterials === 0
      && wipe.bondMaterialGone && wipe.bondColorKept,
    JSON.stringify(wipe));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
