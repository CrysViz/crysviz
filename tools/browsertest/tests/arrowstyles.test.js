// Arrow style checkpoint: UI/store mutations reach raster buffers and the
// existing tracer re-encode path (no direct SceneEncoder.encode() calls).
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

function distinctivePixels(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let count = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (r > 120 && b > 100 && g < Math.min(r, b) * 0.55) count++;
  }
  return count;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force, Spin } = await import('./model/index.js');
    const { updateForces, updateSpins, removeForces, removeSpins } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.forces = s.atoms.map(() => new Force({ vector: [1, 0.1, 0] }));
    s.spins = s.atoms.map(() => new Spin({ vector: [0, 0, 1] }));
    const vis = document.createElement('div');
    vis.id = 'speciesVisibilityContainer';
    [...new Set(s.elements)].forEach((el) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = `species-${el}`; cb.checked = true;
      vis.appendChild(cb);
    });
    document.body.appendChild(vis);
    general.forceColorMap = 'none';
    general.spinColorMap = 'none';
    general.forcesActive = true;
    general.spinsActive = true;
    removeForces(); removeSpins();
    updateForces(); updateSpins();
  });
  await page.waitForTimeout(300);

  const waitTracer = async () => H.waitFor(page, async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return p?._shaderState === 'ready' && p._uniforms.uSampleCounter.value >= 8;
  }, { interval: 250 });

  const pollTexels = async (predicate) => {
    const deadline = Date.now() + 30000;
    let current = null;
    while (Date.now() <= deadline) {
      current = await arrowTexels();
      if (current && predicate(current)) return current;
      await page.waitForTimeout(250);
    }
    return current;
  };

  const arrowTexels = async () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { fileBrowser } = await import('./state/store.js');
    const { groups } = await import('./state/store.js');
    const e = app.pipeline?._encoder;
    if (!e?.cylindersTexture?.image?.data || !e.arrowBodyCount) return null;
    const data = e.cylindersTexture.image.data;
    const first = e.cylinderCount - e.arrowBodyCount;
    const arrow = [];
    for (let i = first; i < e.cylinderCount; i++) {
      const d = i * 32;
      arrow.push({ type: data[d + 24], color: [...data.slice(d + 20, d + 23)], listed: data[d + 27] });
    }
    const emissiveArrowBodies = arrow.filter((entry) => entry.type === 3);
    const emissiveArrowIndices = arrow
      .map((entry, j) => entry.type === 3 ? first + j : null)
      .filter((index) => index != null).sort((a, b) => a - b);
    const emissiveListIndices = e._emissiveList
      .filter((entry) => entry.kind === 1 && entry.encIndex >= first && entry.encIndex < e.cylinderCount)
      .map((entry) => entry.encIndex).sort((a, b) => a - b);
    return {
      arrowCount: e.arrowBodyCount, arrow, fingerprint: e._matFingerprint,
      forceEntries: groups.forcesShaftMesh?.count ?? 0,
      emissiveArrowBodies: emissiveArrowBodies.length,
      emissiveListed: emissiveArrowBodies.length > 0 && emissiveArrowBodies.every((entry) => entry.listed === 1),
      emissiveArrowIndices, emissiveListIndices,
      force0: {
        userColor: fileBrowser.selectedStructure.forces?.[0]?.userColor?.getHexString?.(),
        material: fileBrowser.selectedStructure.forces?.[0]?.userMaterial,
      },
    };
  });

  // Per-atom force editor: mutate through its Color/material controls and
  // prove the tracer's own initial encode (not a test-side encode call) sees
  // both fields.
  const perAtomUi = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { createSpinForceEditor } = await import('./ui/StructureInfoPanel/components/SpinForceEditor.js');
    const host = document.createElement('div');
    const editor = createSpinForceEditor(0, host);
    document.body.appendChild(editor);
    editor.querySelectorAll('.spin-mode-switch-btn')[1].click();
    editor.querySelector('.spin-buttons-row button:nth-child(3)').click();
    const color = editor.querySelector('.spin-color-picker-section input[placeholder="#ffcc00"]');
    color.value = '#FF00AA';
    color.dispatchEvent(new Event('change'));
    const type = editor.querySelector('.material-type-select');
    type.value = 'metal';
    type.dispatchEvent(new Event('change'));
    const rough = editor.querySelector('.material-roughness-row input');
    rough.value = '0.05';
    rough.dispatchEvent(new Event('input'));
    const force = fileBrowser.selectedStructure.forces[0];
    const { groups } = await import('./state/store.js');
    const instance = groups.forcesInstanceBySrcIndex.get(0);
    const rgb = groups.forcesShaftMesh.instanceColor.array.slice(instance * 6, instance * 6 + 3);
    return { rgb: [...rgb], color: force.userColor?.getHexString?.(), material: force.userMaterial, instance };
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitTracer();
  const perAtomAfter = await pollTexels((value) => value.arrow.slice(0, 2).length === 2
    && value.arrow.slice(0, 2).every((entry) => entry.type === 1
      && entry.color[0] > 0.8 && entry.color[2] > 0.3));
  H.check('per-atom force editor changes the raster instance color',
    perAtomUi.rgb[0] > 0.9 && perAtomUi.rgb[1] < 0.1 && perAtomUi.rgb[2] > 0.3,
    JSON.stringify(perAtomUi));
  H.check('per-atom force editor stores metal material',
    perAtomUi.material?.type === 'metal' && Math.abs(perAtomUi.material.roughness - 0.05) < 1e-9,
    JSON.stringify(perAtomUi));
  H.check('pipeline re-encodes the per-atom arrow style',
    !!perAtomAfter && perAtomAfter.arrow.slice(0, 2).length === 2
      && perAtomAfter.arrow.slice(0, 2).every((entry) => entry.type === 1
        && entry.color[0] > 0.8 && entry.color[2] > 0.3), JSON.stringify(perAtomAfter));

  // Stored legacy glass is accepted by the model but clamps to standard at
  // arrow decode; glass is absent from the live editor choices.
  const glass = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const editor = document.querySelector('.atom-spin-editor');
    const options = [...editor.querySelector('.material-type-select').options].map((o) => o.value);
    fileBrowser.selectedStructure.forces[0].userMaterial = { type: 'glass', ior: 1.5 };
    requestRender();
    return { options, stored: fileBrowser.selectedStructure.forces[0].userMaterial };
  });
  const glassAfter = await pollTexels((value) => value.arrow.slice(0, 2).length === 2
    && value.arrow.slice(0, 2).every((entry) => entry.type === 0));
  H.check('glass is excluded from the per-arrow material editor', !glass.options.includes('glass'), JSON.stringify(glass));
  H.check('stored legacy glass clamps to standard arrow texels',
    glass.stored.type === 'glass' && glassAfter?.arrow.slice(0, 2).length === 2
      && glassAfter.arrow.slice(0, 2).every((entry) => entry.type === 0), JSON.stringify(glassAfter));

  // Per-atom Reset clears both fields and invalidates the tracer scene.
  const resetBefore = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.pipeline._uniforms.uSampleCounter.value = app.pipeline._cfg.targetSamples;
    return app.pipeline._uniforms.uSampleCounter.value;
  });
  const resetState = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const editor = document.querySelector('.atom-spin-editor');
    const force = fileBrowser.selectedStructure.forces[0];
    editor.querySelector('.spin-buttons-row button:first-child').click();
    return { color: force.userColor, material: force.userMaterial };
  });
  const resetRender = await H.waitFor(page, async () => {
    const { app } = await import('./state/store.js');
    const value = app.pipeline?._uniforms?.uSampleCounter?.value;
    return value < app.pipeline._cfg.targetSamples ? value : null;
  }, { timeout: 30000, interval: 250 });
  H.check('per-atom Reset clears color and material', resetState.color == null && resetState.material == null, JSON.stringify(resetState));
  H.check('per-atom Reset requests a tracer render', resetRender != null, JSON.stringify({ resetBefore, resetRender }));

  // Species editor: set a spin category through the row button, with one
  // per-arrow userColor override. Its color/material mutation must re-encode.
  const element = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { groups } = await import('./state/store.js');
    const { updateSpins } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const el = s.elements[0];
    s.spins[0].userColor = new (await import('./external/three/three.module.js')).Color('#00FF00');
    const button = [...document.querySelectorAll('.spin-force-category-button')]
      .find((candidate) => candidate.closest('.comp-container')?.dataset.element === el);
    if (!button) throw new Error(`no species arrow editor for ${el}`);
    button.click();
    const editor = button.closest('.comp-container').querySelector('.spin-force-category-editor');
    const color = editor.querySelector('.spin-force-category-color input[placeholder="#ffcc00"]');
    color.value = '#2244FF';
    color.dispatchEvent(new Event('change'));
    const type = editor.querySelector('.material-type-select');
    type.value = 'metal';
    type.dispatchEvent(new Event('change'));
    updateSpins();
    const categorySrcIdx = [...groups.spinsInstanceBySrcIndex.keys()]
      .find((srcIdx) => s.elements[srcIdx] === el && srcIdx !== 0);
    const instance = groups.spinsInstanceBySrcIndex.get(categorySrcIdx);
    const rgb = groups.spinShaftMesh.instanceColor.array.slice(instance * 6, instance * 6 + 3);
    const overriddenInstance = groups.spinsInstanceBySrcIndex.get(0);
    const overriddenRgb = groups.spinShaftMesh.instanceColor.array
      .slice(overriddenInstance * 6, overriddenInstance * 6 + 3);
    return { el, categorySrcIdx, spinInstance: instance, rgb: [...rgb],
      overriddenRgb: [...overriddenRgb], category: s.spinCategoryStyles[el] };
  });
  const categoryAfter = await pollTexels((value) => {
    const first = value.forceEntries + element.spinInstance * 2;
    const pair = value.arrow.slice(first, first + 2);
    return pair.length === 2 && pair.every((entry) => entry.type === 1 && entry.color[2] > 0.7);
  });
  H.check('species category color reaches raster arrows',
    element.rgb[0] < 0.2 && element.rgb[2] > 0.7, JSON.stringify(element));
  H.check('per-arrow userColor still wins over species color',
    element.overriddenRgb[1] > 0.8 && element.overriddenRgb[0] < 0.2, JSON.stringify(element));
  H.check('species editor stores metal and pipeline encodes it',
    element.category?.material?.type === 'metal' && categoryAfter && (() => {
      const first = categoryAfter.forceEntries + element.spinInstance * 2;
      const pair = categoryAfter.arrow.slice(first, first + 2);
      return pair.length === 2 && pair.every((entry) => entry.type === 1 && entry.color[2] > 0.7);
    })(),
    JSON.stringify(categoryAfter));

  const emissive = await page.evaluate(async () => {
    const editor = document.querySelector('.spin-force-category-editor');
    const type = editor.querySelector('.material-type-select');
    type.value = 'emissive';
    type.dispatchEvent(new Event('change'));
    return editor.querySelector('.material-type-select').value;
  });
  const emissiveAfter = await pollTexels((value) => value.emissiveArrowBodies === 4
    && value.emissiveListed && value.emissiveArrowIndices.length === 4
    && value.emissiveListIndices.length === 4
    && value.emissiveArrowIndices.every((index, i) => index === value.emissiveListIndices[i]));
  const emissiveIndicesMatch = !!emissiveAfter
    && emissiveAfter.emissiveArrowIndices.length === emissiveAfter.emissiveListIndices.length
    && emissiveAfter.emissiveArrowIndices.every((index, i) => index === emissiveAfter.emissiveListIndices[i]);
  H.check('species emissive material encodes emissive texels', emissive === 'emissive'
    && emissiveAfter?.emissiveArrowBodies === 4
    && emissiveAfter.emissiveListed
    && emissiveIndicesMatch
    && emissiveAfter.arrow.filter((entry) => entry.type === 3).every((entry) => entry.listed === 1),
  JSON.stringify(emissiveAfter));

  // Reset under the "none" colormap must restore the raster/default color,
  // since the none path deliberately does not rewrite arrow.color.
  const noneReset = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { groups } = await import('./state/store.js');
    const editor = document.querySelector('.spin-force-category-editor');
    const reset = editor.querySelector('.spin-force-category-reset');
    const before = groups.spinShaftMesh.instanceColor.array.slice(0, 3);
    const element = fileBrowser.selectedStructure.elements[0];
    const targetIndex = fileBrowser.selectedStructure.spins.findIndex((spin, index) =>
      index !== 0 && fileBrowser.selectedStructure.elements[index] === element && !spin.userColor);
    reset.click();
    const instance = groups.spinsInstanceBySrcIndex.get(targetIndex);
    const after = groups.spinShaftMesh.instanceColor.array.slice(instance * 6, instance * 6 + 3);
    const expected = fileBrowser.selectedStructure.spins[targetIndex].defaultColor;
    return { before: [...before], after: [...after], expected: [expected.r, expected.g, expected.b], targetIndex };
  });
  H.check('none-colormap category Reset restores raster default buffer color',
    noneReset.after.every((value, i) => Math.abs(value - noneReset.expected[i]) < 1e-5), JSON.stringify(noneReset));

  // Actually add the category back after Reset, then exercise capture ->
  // restore on a freshly rebuilt structure.
  const persistence = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const button = [...document.querySelectorAll('.spin-force-category-button')]
      .find((candidate) => candidate.closest('.comp-container')?.dataset.element === fileBrowser.selectedStructure.elements[0]);
    button.click();
    const editor = button.closest('.comp-container').querySelector('.spin-force-category-editor');
    const color = editor.querySelector('.spin-force-category-color input[placeholder="#ffcc00"]');
    color.value = '#FF00AA'; color.dispatchEvent(new Event('change'));
    const type = editor.querySelector('.material-type-select');
    type.value = 'metal'; type.dispatchEvent(new Event('change'));
    const atomEditor = document.querySelector('.atom-spin-editor');
    atomEditor.querySelectorAll('.spin-mode-switch-btn')[1].click();
    atomEditor.querySelector('.spin-buttons-row button:nth-child(3)').click();
    const atomColor = atomEditor.querySelector('.spin-color-picker-section input[placeholder="#ffcc00"]');
    atomColor.value = '#FF00AA'; atomColor.dispatchEvent(new Event('change'));
    const atomType = atomEditor.querySelector('.material-type-select');
    atomType.value = 'metal'; atomType.dispatchEvent(new Event('change'));
    const state = captureState({ includeFrames: true });
    const expected = state.frames[0].forces[0];
    applySharedState(state, 'arrowstyles-roundtrip.vasp');
    return { expected, stateVersion: state.version };
  });
  await page.waitForTimeout(1500);
  const restored = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return {
      color: s.forces[0].userColor?.getHexString?.() ?? null,
      material: s.forces[0].userMaterial,
      category: s.spinCategoryStyles[s.elements[0]],
    };
  });
  H.check('captureState -> restoreState restores a fresh arrow structure',
    persistence.stateVersion && `#${restored.color}` === persistence.expected.color
      && restored.material?.type === persistence.expected.material?.type,
    JSON.stringify({ persistence, restored }));

  const shot = await H.shotCanvas(page, 'arrowstyles-raytrace-force');
  H.check('raytrace arrow screenshot contains the distinctive force hue',
    distinctivePixels(shot) > 5, JSON.stringify({ pixels: distinctivePixels(shot) }));

  const categoryMode = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { renderComposition } = await import('./ui/StructureInfoPanel/General.js');
    const element = fileBrowser.selectedStructure.elements[0];
    const findButton = () => [...document.querySelectorAll('.spin-force-category-button')]
      .find((candidate) => candidate.closest('.comp-container')?.dataset.element === element);
    const button = findButton();
    if (!button) throw new Error(`No Spins/Forces button for ${element}`);
    button.click();
    const before = button.closest('.comp-container').querySelector('.spin-force-category-editor');
    before.querySelector('[data-mode="force"]').click();
    renderComposition('open');
    const rebuiltButton = findButton();
    const rebuilt = rebuiltButton?.closest('.comp-container')
      ?.querySelector('.spin-force-category-editor');
    return {
      display: rebuilt?.style.display,
      forceActive: rebuilt?.querySelector('[data-mode="force"]')?.classList.contains('active'),
    };
  });
  H.check('composition rebuild preserves open Force category editor mode',
    categoryMode.display !== 'none' && categoryMode.forceActive === true,
    JSON.stringify(categoryMode));

  // Wyckoff rows use the same category editor/button contract.
  const wyckoffButton = await page.evaluate(async () => {
    const { createWyckoffCompositionRow } = await import('./ui/StructureInfoPanel/Species.js');
    const row = createWyckoffCompositionRow('Xx', [{ atomIndices: [0], representativeIndex: 0,
      multiplicity: 1, wyckoff: 'a', siteSymmetry: '', isFixed: true, dofDimension: 0 }], 1);
    document.body.appendChild(row);
    const present = !!row.querySelector('.spin-force-category-button');
    row.remove();
    return present;
  });
  H.check('Wyckoff composition rows expose Spins/Forces', wyckoffButton === true);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
