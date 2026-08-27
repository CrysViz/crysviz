// Focus Regions are a reversible viewing aid for defects and molecules in
// large cells. These checks intentionally assert the scientific interaction
// semantics, not implementation details or screenshots:
// - spatial bands classify in Cartesian Å;
// - overlapping regions preserve anything important to either region;
// - centers/exceptions remain visible;
// - focus alpha composes with, and never overwrites, authored atom alpha;
// - the real defect CONTCAR can create and edit more than one region.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const math = await page.evaluate(async () => {
    const { focusOpacityAt, combinedFocusOpacity } = await import('./render/FocusRegionModule.js');
    const region = {
      enabled: true, center: [0, 0, 0], centerSourceIndices: [7], excludedSourceIndices: [9],
      innerEnabled: true, innerRadius: 2, innerOpacity: 0.8,
      outerRadius: 5, outerOpacity: 0.2, beyondOpacity: 0,
    };
    const second = { ...region, center: [10, 0, 0], centerSourceIndices: [] };
    return {
      inner: focusOpacityAt([1, 0, 0], region, 1),
      shell: focusOpacityAt([3, 0, 0], region, 1),
      beyond: focusOpacityAt([6, 0, 0], region, 1),
      center: focusOpacityAt([20, 0, 0], region, 7),
      excluded: focusOpacityAt([20, 0, 0], region, 9),
      overlap: combinedFocusOpacity([9, 0, 0], 1, [region, second]),
      noInner: focusOpacityAt([1, 0, 0], { ...region, innerEnabled: false }, 1),
    };
  });
  H.check('inner, outer, and beyond bands use their intended opacity',
    math.inner === 0.8 && math.shell === 0.2 && math.beyond === 0, JSON.stringify(math));
  H.check('focus atoms and explicit exceptions remain unchanged',
    math.center === 1 && math.excluded === 1, JSON.stringify(math));
  H.check('overlapping regions choose maximum visibility', math.overlap === 0.8, JSON.stringify(math));
  H.check('disabling the inner region applies the outer rule near a molecule',
    math.noInner === 0.2, JSON.stringify(math));

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
    first.outerRadius = 0.2;
    first.outerOpacity = 0.25;
    first.beyondOpacity = 0.1;
    const second = focus.createFocusRegion([{
      sourceIndex: wrapped.srcIndex[1], element: wrapped.elements[1], position: wrapped.cart[1],
    }]);
    second.innerEnabled = false;
    second.outerRadius = 3;
    focus.applyFocusRegions();
    panels.getPanel('focusRegions').expand();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const attr = groups.atomsMesh.geometry.attributes.instanceOpacity;
    const centerSources = new Set([...first.centerSourceIndices, ...second.centerSourceIndices]);
    const farIndex = wrapped.cart.findIndex((p, index) => index > 1
      && !centerSources.has(wrapped.srcIndex[index])
      && Math.hypot(p[0] - first.center[0], p[1] - first.center[1], p[2] - first.center[2]) > 0.2
      && Math.hypot(p[0] - second.center[0], p[1] - second.center[1], p[2] - second.center[2]) > 3);
    return {
      atomCount: structure.atoms.length,
      regionCount: structure.focusRegions.length,
      cards: document.querySelectorAll('#cvPanelBody-focusRegions .focus-regions-card').length,
      innerToggles: document.querySelectorAll('#cvPanelBody-focusRegions [id^="focusInner-"]').length,
      authoredOpacity: atom0.getOpacity(),
      centerDisplayOpacity: attr.getX(0),
      farDisplayOpacity: farIndex >= 0 ? attr.getX(farIndex) : null,
      farIndex,
    };
  });
  H.check('the supplied defect structure loads as a genuinely large atom set',
    result.atomCount > 100, JSON.stringify(result));
  H.check('multiple regions have independent cards and inner-region controls',
    result.regionCount === 2 && result.cards === 2 && result.innerToggles === 2, JSON.stringify(result));
  H.check('focus keeps the center visible without overwriting authored alpha',
    Math.abs(result.authoredOpacity - 0.6) < 1e-6
      && Math.abs(result.centerDisplayOpacity - 0.6) < 1e-5, JSON.stringify(result));
  H.check('atoms outside every region are aggressively reduced',
    result.farIndex >= 0 && result.farDisplayOpacity <= 0.1001, JSON.stringify(result));

  const reversible = await page.evaluate(async (farIndex) => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { captureState } = await import('./ui/ShareModule.js');
    const { clearFocusRegions } = await import('./render/FocusRegionModule.js');
    const captured = captureState();
    clearFocusRegions();
    const source = fileBrowser.selectedStructure.periodic.visibleWrapped.srcIndex[farIndex];
    const authored = fileBrowser.selectedStructure.atoms[source].getOpacity();
    return {
      savedRegions: captured.display.focusRegions?.length,
      restoredDisplay: groups.atomsMesh.geometry.attributes.instanceOpacity.getX(farIndex),
      authored,
    };
  }, result.farIndex);
  H.check('shared views retain focus-region definitions', reversible.savedRegions === 2,
    JSON.stringify(reversible));
  H.check('clearing every region restores the atom’s authored appearance',
    Math.abs(reversible.restoredDisplay - reversible.authored) < 1e-5, JSON.stringify(reversible));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
