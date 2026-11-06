// Focus Regions are a reversible viewing aid for defects and molecules in
// large cells. These checks intentionally assert the scientific interaction
// semantics, not implementation details or screenshots:
// - the inner sphere and outer environment classify in Cartesian Å;
// - overlapping regions preserve anything important to either region;
// - only excluded atoms are exempt; the atoms a region was created from
//   follow the rule like every other atom;
// - focus alpha composes with, and never overwrites, authored atom alpha;
// - the radial gradient ramps linearly across the outer share of the inner sphere;
// - polyhedra follow either their atoms' mean or the rule at their centroid;
// - the volumetric field fades per vertex under the Field panel's opacity;
// - the real defect CONTCAR can create and edit more than one region.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const math = await page.evaluate(async () => {
    const { focusOpacityAt, combinedFocusOpacity, focusOpacityForPolyhedron } =
      await import('./render/FocusRegionModule.js');
    const region = {
      enabled: true, center: [0, 0, 0], centerSourceIndices: [7], excludedSourceIndices: [9],
      innerEnabled: true, innerRadius: 2, innerOpacity: 0.8, outerOpacity: 0.2,
    };
    const second = { ...region, center: [10, 0, 0], centerSourceIndices: [] };
    const gradient = { ...region, gradientEnabled: true, gradientFraction: 0.5 }; // ramp 1 -> 2 Å
    const poly = { vertices: [[1, 0, 0], [3, 0, 0]], vertexSrcList: [1, 2], centerIndex: null };
    return {
      gradientInside: focusOpacityAt([1, 0, 0], gradient, 1),
      gradientMid: focusOpacityAt([1.5, 0, 0], gradient, 1),
      gradientEdge: focusOpacityAt([2, 0, 0], gradient, 1),
      gradientBeyond: focusOpacityAt([3, 0, 0], gradient, 1),
      gradientFull: focusOpacityAt([1, 0, 0], { ...gradient, gradientFraction: 1 }, 1),
      gradientNone: focusOpacityAt([1.9, 0, 0], { ...gradient, gradientFraction: 0 }, 1),
      gradientNoInner: focusOpacityAt([1, 0, 0], { ...gradient, innerEnabled: false }, 1),
      gradientCenter: focusOpacityAt([1.5, 0, 0], gradient, 7),
      polyAverage: focusOpacityForPolyhedron(poly, [region]),
      polyPosition: focusOpacityForPolyhedron(poly, [{ ...region, polyhedraMode: 'position' }]),
      polyFocusCenter: focusOpacityForPolyhedron({ ...poly, centerIndex: 7 }, [region]),
      polyNoRegions: focusOpacityForPolyhedron(poly, []),
      inner: focusOpacityAt([1, 0, 0], region, 1),
      outerNear: focusOpacityAt([3, 0, 0], region, 1),
      outerFar: focusOpacityAt([60, 0, 0], region, 1),
      center: focusOpacityAt([20, 0, 0], region, 7),
      excluded: focusOpacityAt([20, 0, 0], region, 9),
      overlap: combinedFocusOpacity([9, 0, 0], 1, [region, second]),
      earlierFocus: combinedFocusOpacity([0, 0, 0], 7, [region, second]),
      noInner: focusOpacityAt([1, 0, 0], { ...region, innerEnabled: false }, 1),
    };
  });
  H.check('inner sphere and all outer distances use their intended opacity',
    math.inner === 0.8 && math.outerNear === 0.2 && math.outerFar === 0.2, JSON.stringify(math));
  H.check('focus atoms follow the rule while explicit exceptions remain unchanged',
    math.center === 0.2 && math.excluded === 1, JSON.stringify(math));
  H.check('overlapping regions choose maximum visibility', math.overlap === 0.8, JSON.stringify(math));
  H.check('an earlier focus atom keeps its own region\'s inner opacity when another region is added',
    math.earlierFocus === 0.8, JSON.stringify(math));
  H.check('disabling the inner region applies the outer rule near a molecule',
    math.noInner === 0.2, JSON.stringify(math));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  H.check('the radial gradient ramps across the outer share of the inner sphere and meets the outer value at its edge',
    near(math.gradientInside, 0.8) && near(math.gradientMid, 0.5) && near(math.gradientEdge, 0.2)
      && near(math.gradientBeyond, 0.2), JSON.stringify(math));
  H.check('a 100% share ramps from the center and a 0% share is the hard edge',
    near(math.gradientFull, 0.5) && near(math.gradientNone, 0.8), JSON.stringify(math));
  H.check('without an inner region the gradient has no effect',
    near(math.gradientNoInner, 0.2), JSON.stringify(math));
  H.check('focus atoms follow the gradient like any other atom', near(math.gradientCenter, 0.5), JSON.stringify(math));
  H.check('polyhedra average their atoms or take the rule at their centroid',
    near(math.polyAverage, 0.5) && near(math.polyPosition, 0.8) && near(math.polyFocusCenter, 0.6)
      && math.polyNoRegions === 1, JSON.stringify(math));

  const contcar = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tests', 'wav_dat', 'CONTCAR'), 'utf8');
  await page.evaluate(async (source) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(source, 'defect-CONTCAR');
  }, contcar);
  await page.waitForTimeout(1500);

  const result = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const focus = await import('./render/FocusRegionModule.js');
    const panels = await import('./ui/panels/PanelManager.js');
    const structure = fileBrowser.selectedStructure;
    const wrapped = structure.periodic.visibleWrapped;
    const atom0 = structure.atoms[wrapped.srcIndex[0]];
    atom0.setOpacity(0.6);
    const first = focus.createFocusRegion([{
      sourceIndex: wrapped.srcIndex[0], element: wrapped.elements[0], position: wrapped.cart[0],
    }]);
    first.innerRadius = 0.1;
    first.outerOpacity = 0.1;
    const second = focus.createFocusRegion([{
      sourceIndex: wrapped.srcIndex[1], element: wrapped.elements[1], position: wrapped.cart[1],
    }]);
    second.innerEnabled = false;
    second.outerOpacity = 0.1;
    const originalCenterFrac = [...first.centerFractional];
    const adjustedCenterFrac = originalCenterFrac.map((value, axis) => value + (axis + 1) * 0.01);
    focus.setFocusRegionCenterFractional(first, adjustedCenterFrac);
    focus.applyFocusRegions();
    panels.getPanel('focusRegions').expand();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const attr = groups.atomsMesh.geometry.attributes.instanceOpacity;
    const centerSources = new Set([...first.centerSourceIndices, ...second.centerSourceIndices]);
    const farIndex = wrapped.cart.findIndex((p, index) => index > 1
      && !centerSources.has(wrapped.srcIndex[index])
      && Math.hypot(p[0] - first.center[0], p[1] - first.center[1], p[2] - first.center[2]) > first.innerRadius
      && Math.hypot(p[0] - second.center[0], p[1] - second.center[1], p[2] - second.center[2]) > second.innerRadius);
    const { Force, Spin } = await import('./model/index.js');
    const { updateForces, updateSpins } = await import('./render/index.js');
    structure.forces = structure.atoms.map(() => new Force({ vector: [1, 0, 0] }));
    structure.spins = structure.atoms.map(() => new Spin({ vector: [0, 0, 1] }));
    const spinVis = document.createElement('div');
    spinVis.id = 'speciesVisibilityContainer';
    [...new Set(structure.elements)].forEach((element) => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.id = `species-${element}`; checkbox.checked = true;
      spinVis.appendChild(checkbox);
    });
    document.body.appendChild(spinVis);
    updateForces(); updateSpins();
    const farSource = farIndex >= 0 ? wrapped.srcIndex[farIndex] : -1;
    const forceArrow = groups.forcesInstancesBySrcIndex?.get(farSource)?.[0];
    const spinArrow = groups.spinsInstancesBySrcIndex?.get(farSource)?.[0];
    return {
      atomCount: structure.atoms.length,
      regionCount: structure.focusRegions.length,
      gradientDefault: structure.focusRegions.every((region) => region.gradientEnabled === true),
      cards: document.querySelectorAll('#cvPanelBody-focusRegions .focus-regions-card').length,
      innerToggles: document.querySelectorAll('#cvPanelBody-focusRegions [id^="focusInner-"]').length,
      labels: [...document.querySelectorAll('#cvPanelBody-focusRegions .focus-regions-range-heading > span:first-child')]
        .map((label) => label.textContent),
      centerInputs: document.querySelectorAll('.focus-regions-center-coordinates input').length,
      originalCenterFrac,
      adjustedCenterFrac,
      actualCenterFrac: [...first.centerFractional],
      centerOffsetFrac: [...first.centerOffsetFrac],
      authoredOpacity: atom0.getOpacity(),
      centerDisplayOpacity: attr.getX(0),
      farDisplayOpacity: farIndex >= 0 ? attr.getX(farIndex) : null,
      farIndex,
      forceArrowOpacity: forceArrow == null ? null
        : groups.forcesShaftMesh.geometry.attributes.instanceOpacity.getX(forceArrow * 2),
      spinArrowOpacity: spinArrow == null ? null
        : groups.spinShaftMesh.geometry.attributes.instanceOpacity.getX(spinArrow * 2),
    };
  });
  H.check('the supplied defect structure loads as a genuinely large atom set',
    result.atomCount > 100, JSON.stringify(result));
  H.check('multiple regions have independent cards and inner-region controls',
    result.regionCount === 2 && result.cards === 2 && result.innerToggles === 2, JSON.stringify(result));
  H.check('new regions default to the radial gradient',
    result.gradientDefault === true, JSON.stringify(result));
  H.check('the panel exposes inner radius, inner opacity, outer opacity, and the gradient share',
    result.labels.includes('Inner radius') && result.labels.includes('Inner opacity')
      && result.labels.includes('Outer opacity') && result.labels.includes('Gradient share of inner radius')
      && !result.labels.includes('Outer radius') && !result.labels.includes('Gradient radius')
      && !result.labels.includes('Beyond opacity'), JSON.stringify(result.labels));
  H.check('the active inner region exposes editable fractional center coordinates',
    result.centerInputs === 3
      && result.actualCenterFrac.every((value, axis) => Math.abs(value - result.adjustedCenterFrac[axis]) < 1e-9)
      && result.centerOffsetFrac.every((value, axis) => Math.abs(value - (axis + 1) * 0.01) < 1e-9),
    JSON.stringify(result));
  // The shifted center leaves atom 0 outside the 0.1 Å inner sphere, so the
  // outer opacity (0.1) composes with its authored alpha (0.6) -> 0.06.
  H.check('focus composes with authored alpha instead of overwriting it',
    Math.abs(result.authoredOpacity - 0.6) < 1e-6
      && Math.abs(result.centerDisplayOpacity - 0.06) < 1e-5, JSON.stringify(result));
  H.check('atoms outside every region are aggressively reduced',
    result.farIndex >= 0 && result.farDisplayOpacity <= 0.1001, JSON.stringify(result));
  H.check('force and spin arrows follow their atom focus opacity',
    result.forceArrowOpacity <= 0.1001 && result.spinArrowOpacity <= 0.1001,
    JSON.stringify(result));

  // Each card with an inner region carries the gradient toggle (on by default)
  // and every card the polyhedra rule. Widen the first inner sphere over the
  // far atom: with the gradient off it sits at full inner opacity; with the
  // gradient ramping from the center it is partly faded but above the outer
  // value.
  const gradientUi = await page.evaluate(async (farIndex) => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const structure = fileBrowser.selectedStructure;
    const region = structure.focusRegions[0];
    region.innerRadius = 60; // covers the far atom
    region.gradientFraction = 1; // ramp from the center
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const toggle = () => document.querySelector('#cvPanelBody-focusRegions [id^="focusGradient-"]');
    toggle().click(); // off: hard edge, far atom fully inside
    await frame();
    const before = groups.atomsMesh.geometry.attributes.instanceOpacity.getX(farIndex);
    toggle().click(); // on again: ramp fades the far atom partway
    await frame();
    const after = groups.atomsMesh.geometry.attributes.instanceOpacity.getX(farIndex);
    region.innerRadius = 0.1;
    return {
      toggles: document.querySelectorAll('#cvPanelBody-focusRegions [id^="focusGradient-"]').length,
      selects: document.querySelectorAll('#cvPanelBody-focusRegions .focus-regions-polyhedra select').length,
      options: [...document.querySelectorAll('#cvPanelBody-focusRegions .focus-regions-polyhedra select')[0].options]
        .map((option) => option.value),
      enabled: region.gradientEnabled,
      labels: [...document.querySelectorAll('#cvPanelBody-focusRegions .focus-regions-range-heading > span:first-child')]
        .map((label) => label.textContent),
      before, after,
    };
  }, result.farIndex);
  H.check('cards with an inner region carry a gradient toggle; every card a polyhedra rule',
    gradientUi.toggles === 1 && gradientUi.selects === 2
      && gradientUi.options.join(',') === 'average,position', JSON.stringify(gradientUi));
  H.check('the gradient toggle reveals its share slider and fades an atom inside the sphere partway',
    gradientUi.enabled === true && gradientUi.labels.includes('Gradient share of inner radius')
      && gradientUi.before >= 0.999 && gradientUi.after < gradientUi.before - 0.05
      && gradientUi.after > 0.1001, JSON.stringify(gradientUi));

  // Polyhedra: whichever coordination polyhedra the defect cell yields, those
  // away from both focus atoms must be scaled by the outer value, and the
  // authored style alpha must survive on the mesh (never overwritten).
  const polyhedra = await page.evaluate(async () => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updatePolyhedra } = await import('./render/index.js');
    const { applyFocusRegions } = await import('./render/FocusRegionModule.js');
    const structure = fileBrowser.selectedStructure;
    structure.focusRegions[0].gradientEnabled = false;
    structure.focusRegions[0].innerRadius = 0.1;
    general.showPolyhedra = true;
    await updatePolyhedra();
    applyFocusRegions();
    const meshes = (groups.polyhedraGroup?.children ?? []).filter((m) => m.userData?.type === 'polyhedron');
    const dimmed = meshes.filter((m) => m.material.opacity <= m.userData.baseOpacity * 0.1001);
    const authored = meshes.every((m) => m.userData.baseOpacity > 0.1001);
    const edgeDimmed = meshes.every((m) => {
      const edge = m.children.find((c) => c.userData?.type === 'polyhedron-edges');
      return !edge || edge.material.opacity <= m.userData.baseEdgeOpacity + 1e-6;
    });
    general.showPolyhedra = false;
    await updatePolyhedra();
    return { count: meshes.length, dimmed: dimmed.length, authored, edgeDimmed };
  });
  H.check('polyhedra away from every focus scale by the outer value and keep their authored alpha',
    polyhedra.count === 0 || (polyhedra.dimmed > 0 && polyhedra.authored && polyhedra.edgeDimmed),
    JSON.stringify(polyhedra));

  // The volumetric field: a synthetic blob over the cell. Its material keeps
  // the Field panel opacity; the focus factor lives in a vertex alpha.
  const field = await page.evaluate(async () => {
    const { Field, FieldContainer, getIsosurfaceMaterialSettings } = await import('./model/index.js');
    const { fileBrowser, groups } = await import('./state/store.js');
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const { setActiveField, updateField } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    const lat = structure.lattice;
    const nx = 16, ny = 16, nz = 16;
    const values = new Float32Array(nx * ny * nz);
    const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2, sigma = 3.5;
    let maxV = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const v = Math.exp(-((i - cx) ** 2 + (j - cy) ** 2 + (k - cz) ** 2) / (2 * sigma * sigma));
          values[i + nx * (j + ny * k)] = v;
          if (v > maxV) maxV = v;
        }
    const voxel = [0, 1, 2].map((axis) => [lat[axis][0] / [nx, ny, nz][axis],
      lat[axis][1] / [nx, ny, nz][axis], lat[axis][2] / [nx, ny, nz][axis]]);
    const blob = new Field({
      nx, ny, nz, origin: [0, 0, 0], voxel, values, label: 'FocusBlob',
      isoValue: 0.5, minValue: 0, maxValue: maxV, absMinValue: 0, absMaxValue: maxV,
      useAbsoluteIsoValue: false, isVisible: true,
    });
    structure.volumetricFields = new FieldContainer({ fileName: 'focus.cube', source: 'Cube', fields: [blob] });
    fieldBrowser.setCatalog(structure.volumetricFields.catalog);
    setActiveField(blob, false);
    updateField(0.5);
    const mesh = groups.isosurfaceGroup.meshes.positive;
    const color = mesh.geometry.getAttribute('color');
    const alphas = [];
    for (let i = 0; color && i < color.count; i++) alphas.push(color.array[i * 4 + 3]);
    return {
      vertices: mesh.geometry.getAttribute('position')?.count ?? 0,
      itemSize: color?.itemSize ?? 0,
      vertexColors: mesh.material.vertexColors,
      transparent: mesh.material.transparent,
      materialOpacity: mesh.material.opacity,
      panelOpacity: getIsosurfaceMaterialSettings().opacity,
      minAlpha: alphas.length ? Math.min(...alphas) : null,
      maxAlpha: alphas.length ? Math.max(...alphas) : null,
    };
  });
  H.check('the field fades per vertex while its material keeps the Field panel opacity',
    field.vertices > 0 && field.itemSize === 4 && field.vertexColors === true && field.transparent
      && field.minAlpha <= 0.1001 && field.maxAlpha <= 1
      && Math.abs(field.materialOpacity - field.panelOpacity) < 1e-6, JSON.stringify(field));

  const regionSelection = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const structure = fileBrowser.selectedStructure;
    const region = structure.focusRegions[0];
    region.innerRadius = 2;
    region.excludedSourceIndices = [structure.periodic.visibleWrapped.srcIndex.at(-1)];
    document.querySelector('.focus-regions-card .focus-regions-select')?.click();
    document.querySelector('#selectionActionBar .si-selbar-coordinates-toggle')?.click();
    const selected = getSelectedAtoms();
    return {
      selectedCount: selected.length,
      exceptionSelected: selected.some((atom) => atom.sourceIndex === region.excludedSourceIndices[0]),
      coordinateAreas: document.querySelectorAll('#selectionActionBar .si-selbar-coordinates textarea').length,
      fractionalText: document.querySelector('#selectionActionBar .si-selbar-coordinates textarea')?.value ?? '',
      cartesianText: document.querySelectorAll('#selectionActionBar .si-selbar-coordinates textarea')[1]?.value ?? '',
      copyButtons: document.querySelectorAll('#selectionActionBar .si-selbar-copy').length,
    };
  });
  H.check('the region action selects inner atoms and explicit exceptions',
    regionSelection.selectedCount > 1 && regionSelection.exceptionSelected, JSON.stringify(regionSelection));
  H.check('the selection bar exposes copyable fractional and Cartesian coordinates',
    regionSelection.coordinateAreas === 2 && regionSelection.copyButtons === 2
      && regionSelection.fractionalText.includes('\t') && regionSelection.cartesianText.includes('\t'),
    JSON.stringify(regionSelection));

  const reversible = await page.evaluate(async (farIndex) => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { captureState } = await import('./ui/ShareModule.js');
    const { clearFocusRegions } = await import('./render/FocusRegionModule.js');
    const captured = captureState();
    clearFocusRegions();
    const source = fileBrowser.selectedStructure.periodic.visibleWrapped.srcIndex[farIndex];
    const authored = fileBrowser.selectedStructure.atoms[source].getOpacity();
    const fieldMesh = groups.isosurfaceGroup?.meshes?.positive;
    return {
      savedRegions: captured.display.focusRegions?.length,
      savedGradient: captured.display.focusRegions?.[0]?.gradientEnabled,
      savedMode: captured.display.focusRegions?.[0]?.polyhedraMode,
      restoredDisplay: groups.atomsMesh.geometry.attributes.instanceOpacity.getX(farIndex),
      authored,
      fieldVertexColors: fieldMesh?.material.vertexColors,
      fieldHasAlpha: !!fieldMesh?.geometry.getAttribute('color'),
    };
  }, result.farIndex);
  H.check('shared views retain focus-region definitions including the new settings',
    reversible.savedRegions === 2 && typeof reversible.savedGradient === 'boolean'
      && reversible.savedMode === 'average', JSON.stringify(reversible));
  H.check('clearing every region restores the atom’s authored appearance',
    Math.abs(reversible.restoredDisplay - reversible.authored) < 1e-5, JSON.stringify(reversible));
  H.check('clearing every region restores the field material and drops the vertex alpha',
    reversible.fieldVertexColors === false && reversible.fieldHasAlpha === false,
    JSON.stringify(reversible));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
