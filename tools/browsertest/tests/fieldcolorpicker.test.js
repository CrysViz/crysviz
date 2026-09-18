// The Fields panel used native <input type="color"> swatches for the
// isosurface colors; it must use the app's own canvas-based color picker
// (ColorPickerModule.js) like every other panel instead.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const result = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { addFieldPanel, fieldBrowser } = await import('./ui/FieldPanel.js');

    const { Field, FieldContainer } = await import('./model/index.js');
    const lat = fileBrowser.selectedStructure.lattice;
    const n = 2;
    const voxel = lat.map((row) => row.map((component) => component / n));
    const values = new Float32Array(n * n * n);
    values[0] = 1;
    const field = new Field({
      nx: n, ny: n, nz: n, origin: [0, 0, 0], voxel, values,
      label: 'test-field', isoValue: 0.1, minValue: 0, maxValue: 1,
      useAbsoluteIsoValue: false,
    });
    fileBrowser.selectedStructure.volumetricFields = new FieldContainer({
      fileName: 'test', source: 'Cube', fields: [field], fieldCount: 1,
    });

    const target = document.getElementById('cvPanelBody-field');
    addFieldPanel('cvPanelBody-field');

    const posContainer = document.getElementById('FieldPosColorPicker');
    const negContainer = document.getElementById('FieldNegColorPicker');
    const nativeColorInputs = target.querySelectorAll('input[type="color"]').length;
    const posCanvases = posContainer?.querySelectorAll('canvas').length ?? 0;
    const negCanvases = negContainer?.querySelectorAll('canvas').length ?? 0;

    const { getIsosurfaceMaterialSettings } = await import('./model/index.js');
    const before = getIsosurfaceMaterialSettings().positiveColor;

    // Simulate a real drag on the custom picker's hue canvas, exactly like a
    // user would, and confirm it flows into the isosurface material settings.
    const hueCanvas = posContainer.querySelectorAll('canvas')[1];
    const rect = hueCanvas.getBoundingClientRect();
    hueCanvas.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: rect.left + rect.width / 2, clientY: rect.top + 5, bubbles: true,
    }));
    const after = getIsosurfaceMaterialSettings().positiveColor;

    return { nativeColorInputs, posCanvases, negCanvases, before, after };
  });

  H.check('no native <input type=color> left in the Fields panel', result.nativeColorInputs === 0, JSON.stringify(result));
  H.check('positive color container hosts the custom picker (SV + hue canvases)', result.posCanvases === 2, JSON.stringify(result));
  H.check('negative color container hosts the custom picker (SV + hue canvases)', result.negCanvases === 2, JSON.stringify(result));
  H.check('dragging the custom picker updates the isosurface material color', result.before !== result.after, JSON.stringify(result));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
