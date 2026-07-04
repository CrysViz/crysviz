// Bonds tab parity feature: expandable per-pair categories with lazy individual
// bond rows, per-bond persistent user colors, and two-way highlight sync
// (3D dblclick -> panel row; panel row click -> 3D orange highlight).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO — plenty of bonds

  // --- Open the Structure window on the Bonds tab -------------------------------
  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    document.querySelector('#atomBondControlSwitch button[data-mode="bonds"]').click();
  });
  await page.waitForTimeout(300);

  const panelShape = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('#infoBondControls .bond-control')];
    return {
      controls: controls.length,
      withPair: controls.filter((c) => c.dataset.pair).length,
      carets: document.querySelectorAll('#infoBondControls .bond-expand-icon').length,
      lists: document.querySelectorAll('#infoBondControls .individual-bonds').length,
      rowsBeforeExpand: document.querySelectorAll('#infoBondControls .individual-bond-row').length,
    };
  });
  H.check('every bond category row has a data-pair, caret and (empty) bond list',
    panelShape.controls > 0
      && panelShape.withPair === panelShape.controls
      && panelShape.carets === panelShape.controls
      && panelShape.lists === panelShape.controls
      && panelShape.rowsBeforeExpand === 0, // lazy: nothing built yet
    JSON.stringify(panelShape));

  // --- Expand all categories through the UI carets ------------------------------
  const expanded = await page.evaluate(() => {
    document.querySelectorAll('#infoBondControls .bond-expand-icon')
      .forEach((icon) => /** @type {HTMLElement} */ (icon).click());
    const rows = [...document.querySelectorAll('#infoBondControls .individual-bond-row')];
    return {
      rows: rows.length,
      keyed: rows.filter((r) => /** @type {HTMLElement} */ (r).dataset.bondKey).length,
      sampleLabel: rows[0]?.querySelector('span')?.textContent ?? '',
      sampleDist: rows[0]?.querySelectorAll('span')[1]?.textContent ?? '',
      colorButtons: rows.length
        ? rows.filter((r) => r.querySelector('button[data-editor-button="color"]')).length
        : 0,
    };
  });
  H.check('expanding categories builds individual bond rows with keys and color buttons',
    expanded.rows > 0 && expanded.keyed === expanded.rows && expanded.colorButtons === expanded.rows,
    JSON.stringify(expanded));
  H.check('bond rows are labeled like "Cu1–O3" with a length in Å',
    /^[A-Z][a-z]?\d+–[A-Z][a-z]?\d+$/.test(expanded.sampleLabel) && /\d\.\d{3} Å$/.test(expanded.sampleDist),
    JSON.stringify({ label: expanded.sampleLabel, dist: expanded.sampleDist }));

  // --- bondObjectMapping round trip (the off-by-N fix) ---------------------------
  const mapping = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const keys = Object.keys(s.bondObjectMapping).map(Number);
    let ok = 0;
    for (const inst of keys) {
      const [bondIdx, half] = s.bondObjectMapping[inst];
      if (s.bonds[bondIdx]?.instanceIds?.[half] === inst) ok++;
    }
    return { total: keys.length, ok };
  });
  H.check('bondObjectMapping indexes structure.bonds (instance -> bond -> instance round trip)',
    mapping.total > 0 && mapping.ok === mapping.total, JSON.stringify(mapping));

  // --- 3D -> panel: select a bond by instance id --------------------------------
  const sel = await page.evaluate(async () => {
    const { selectBondFromInstance } = await import('./ui/SelectAndHighlightModule.js');
    const { highlightHover, groups } = await import('./state/store.js');
    selectBondFromInstance(0, { scrollToSelection: false });
    const state = highlightHover.currentlyHighlightedBond;
    const glow = state
      ? state.instanceIds.map((i) => groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.getX(i))
      : [];
    const row = state
      ? document.querySelector(`#infoBondControls .individual-bond-row[data-bond-key="${state.key}"]`)
      : null;
    return {
      state,
      glow,
      rowHighlighted: !!row && /** @type {HTMLElement} */ (row).style.borderLeft.includes('rgb(255, 179, 71)'),
      listVisible: !!row && /** @type {HTMLElement} */ (row.closest('.individual-bonds')).style.display !== 'none',
    };
  });
  H.check('selectBondFromInstance sets the selection state and orange emissive on both halves',
    !!sel.state && sel.glow.length === 2 && sel.glow.every((g) => g === 2.0), JSON.stringify({ state: sel.state, glow: sel.glow }));
  H.check('the bond\'s panel row is amber-highlighted inside a visible list',
    sel.rowHighlighted && sel.listVisible, JSON.stringify(sel));

  // --- selecting the same bond again deselects ----------------------------------
  const desel = await page.evaluate(async () => {
    const { selectBondFromInstance } = await import('./ui/SelectAndHighlightModule.js');
    const { highlightHover, groups } = await import('./state/store.js');
    selectBondFromInstance(0, { scrollToSelection: false });
    return {
      state: highlightHover.currentlyHighlightedBond,
      glow: groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.getX(0),
    };
  });
  H.check('double-selecting the same bond deselects (state null, glow cleared)',
    desel.state === null && desel.glow === 0, JSON.stringify(desel));

  // --- panel -> 3D: click a bond row ---------------------------------------------
  const rowClick = await page.evaluate(async () => {
    const { highlightHover, groups } = await import('./state/store.js');
    const row = /** @type {HTMLElement} */ (document.querySelector('#infoBondControls .individual-bond-row'));
    row.click();
    const state = highlightHover.currentlyHighlightedBond;
    return {
      clickedKey: row.dataset.bondKey,
      state,
      glow: state
        ? state.instanceIds.map((i) => groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.getX(i))
        : [],
    };
  });
  H.check('clicking a bond row highlights that bond in 3D',
    !!rowClick.state && rowClick.state.key === rowClick.clickedKey
      && rowClick.glow.every((g) => g === 2.0),
    JSON.stringify(rowClick));

  // --- per-bond user styles: applied, precedent, and persistent across rebuilds --
  const styled = await page.evaluate(async () => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { bondKey } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const bond = s.bonds.find((b) => b.instanceIds);
    const key = bondKey(bond.indices);
    // What the row's Edit controls (color picker + Alpha + Size) persist:
    s.bondUserStyles[key] = { color: '#ff0000', alpha: 0.4, radiusScale: 2, elements: [...bond.elements] };
    // Rebuild bonds twice (as a length-slider drag would) — the styles must survive.
    await updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
    await updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
    const rebuilt = s.bonds.find((b) => bondKey(b.indices) === key);
    const otherBond = s.bonds.find((b) => b.instanceIds && bondKey(b.indices) !== key);
    const attrs = groups.bondsMesh.geometry.attributes;
    const rgbAt = (i) => [
      groups.bondsMesh.instanceColor.getX(i),
      groups.bondsMesh.instanceColor.getY(i),
      groups.bondsMesh.instanceColor.getZ(i),
    ];
    // The instance matrix composes rotation*scale, so the x-scale (bond radius)
    // is the norm of the first column, not the raw [0] element.
    const xScaleAt = (i) => {
      const a = groups.bondsMesh.instanceMatrix.array;
      const o = i * 16;
      return Math.hypot(a[o], a[o + 1], a[o + 2]);
    };
    return {
      modelColor: rebuilt.color,
      userColor: rebuilt.userColor,
      alpha: rebuilt.alpha,
      radius: rebuilt.radius,
      expectedRadius: general.bondRadius * 2,
      meshRGB: rebuilt.instanceIds.map(rgbAt),
      meshOpacity: rebuilt.instanceIds.map((i) => attrs.instanceOpacity.getX(i)),
      otherOpacity: attrs.instanceOpacity.getX(otherBond.instanceIds[0]),
      otherRGB: rgbAt(otherBond.instanceIds[0]),
      xScale: xScaleAt(rebuilt.instanceIds[0]),
      otherXScale: xScaleAt(otherBond.instanceIds[0]),
      materialTransparent: groups.bondsMesh.material.transparent,
    };
  });
  H.check('per-bond user color survives bond rebuilds on model and mesh (both halves red)',
    styled.modelColor[0] === '#ff0000' && styled.modelColor[1] === '#ff0000'
      && styled.userColor[0] === '#ff0000'
      && styled.meshRGB.every(([r, g, b]) => r === 1 && g === 0 && b === 0),
    JSON.stringify({ modelColor: styled.modelColor, meshRGB: styled.meshRGB }));
  H.check('other bonds keep their mode color (only the recolored bond is red)',
    !(styled.otherRGB[0] === 1 && styled.otherRGB[1] === 0 && styled.otherRGB[2] === 0),
    JSON.stringify(styled.otherRGB));
  H.check('per-bond alpha survives rebuilds (instanceOpacity 0.4, material transparent, others opaque)',
    styled.alpha === 0.4
      && styled.meshOpacity.every((o) => Math.abs(o - 0.4) < 1e-6)
      && styled.otherOpacity === 1
      && styled.materialTransparent === true,
    JSON.stringify({ alpha: styled.alpha, meshOpacity: styled.meshOpacity, otherOpacity: styled.otherOpacity, transparent: styled.materialTransparent }));
  H.check('per-bond size survives rebuilds (radius doubled on the instance matrix)',
    Math.abs(styled.radius - styled.expectedRadius) < 1e-9
      && Math.abs(styled.xScale - styled.expectedRadius) < 1e-6
      && Math.abs(styled.otherXScale - styled.expectedRadius / 2) < 1e-6,
    JSON.stringify({ radius: styled.radius, expected: styled.expectedRadius, xScale: styled.xScale, otherXScale: styled.otherXScale }));

  // --- the bond editor exposes Alpha and Size ranges ------------------------------
  const editorRows = await page.evaluate(() => {
    const row = document.querySelector('#infoBondControls .individual-bond-row');
    const btn = /** @type {HTMLElement} */ (row.querySelector('button[data-editor-button="color"]'));
    const labels = [...row.querySelectorAll('.bond-color-editor span')].map((s) => s.textContent);
    const ranges = row.querySelectorAll('.bond-color-editor input[type="range"]').length;
    return { buttonLabel: btn.textContent, labels, ranges };
  });
  H.check('bond rows have an "Edit" button whose editor holds Alpha and Size ranges',
    editorRows.buttonLabel === 'Edit'
      && editorRows.labels.includes('Alpha') && editorRows.labels.includes('Size')
      && editorRows.ranges >= 2,
    JSON.stringify(editorRows));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
