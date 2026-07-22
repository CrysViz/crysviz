// After an MD/relax run the code should auto-switch selection to the recorded
// trajectory row (the last-added container) so the viewer refreshes to it
// instead of staying on the source structure. This exercises selectLastAddedRow
// — the mechanism the run's finally block uses — directly: with two rows loaded
// and the FIRST selected, it must move selection + the viewer to the LAST row.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // A is also a short trajectory so the Trajectory panel stays available (and
  // expanded) across the switch, exactly as it is during a live run.
  const A = [
    '1', 'Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3', 'Si 0 0 0',
    '1', 'Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3', 'Si 0.1 0 0',
  ].join('\n');
  // A 3-frame trajectory (like MD_…) so the Trajectory panel/scrubber applies.
  const B = [
    '2', 'Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3', 'Na 0 0 0', 'Cl 2 0 0',
    '2', 'Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3', 'Na 0.1 0 0', 'Cl 2.1 0 0',
    '2', 'Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3', 'Na 0.2 0 0', 'Cl 2.2 0 0',
  ].join('\n');

  const res = await page.evaluate(async (structs) => {
    const cv = await import('./core/crystal-viewer.js');
    const { selectLastAddedRow } = await import('./ui/panels/../FileBrowswerPanel.js');
    const { refreshActivePanels, openPanel } = await import('./ui/panels/PanelManager.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');

    await cv.loadStructure(structs.A, 'Si.xyz');
    await cv.loadStructure(structs.B, 'MD_Si.xyz');
    await new Promise((r) => setTimeout(r, 200));

    // Force selection back onto the FIRST row (the "source structure" case).
    const rows = document.querySelectorAll('#objectTable tbody tr');
    rows[0].click();
    await new Promise((r) => setTimeout(r, 200));
    const before = {
      rowIndex: fileBrowser.selectedRowIndex,
      selectedIsFirst: rows[0].classList.contains('selected'),
      elements: [...(fileBrowser.selectedStructure?.elements || [])],
    };

    // The auto-switch the run performs (row switch + panel rebuild), then the
    // panel is shown (during a real run it is already open+expanded).
    selectLastAddedRow();
    refreshActivePanels();
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 400));
    const lastContainer = structureShip.container[structureShip.container.length - 1];
    const slider = document.getElementById('frameSlider');
    const ind = document.getElementById('frameIndicator');
    const after = {
      rowIndex: fileBrowser.selectedRowIndex,
      lastRowSelected: rows[rows.length - 1].classList.contains('selected'),
      firstRowStillSelected: rows[0].classList.contains('selected'),
      elements: [...(fileBrowser.selectedStructure?.elements || [])],
      lastContainerElements: [...(lastContainer.structures[0].elements || [])],
      frames: lastContainer.structures.length,
      sliderMax: Number(slider?.max),
      indicatorTotal: ind?.querySelector('.tfTot')?.textContent,
    };
    return { rowCount: rows.length, before, after };
  }, { A, B });

  // A default structure is loaded at startup, so the two we add sit after it.
  H.check('at least two rows loaded', res.rowCount >= 2, JSON.stringify(res));
  H.check('starts on the first (source) row', res.before.rowIndex === 0 && res.before.selectedIsFirst, JSON.stringify(res.before));
  H.check('auto-switch moves selection to the last row', res.after.rowIndex === res.rowCount - 1 && res.after.lastRowSelected && !res.after.firstRowStillSelected, JSON.stringify(res.after));
  H.check('viewer structure refreshes to the last container (NaCl, not Si)',
    JSON.stringify(res.after.elements) === JSON.stringify(res.after.lastContainerElements)
      && res.after.elements.includes('Na'), JSON.stringify(res.after));
  H.check('trajectory scrubber rebuilds for the new container (slider max = frames-1)',
    res.after.sliderMax === res.after.frames - 1 && res.after.frames === 3, JSON.stringify(res.after));
  H.check('frame indicator total matches the trajectory frame count',
    String(res.after.indicatorTotal) === String(res.after.frames), JSON.stringify(res.after));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
