// Wyckoff editor rows (StructureInfoPanel/components/IndividualAtomRow.js +
// CompositionRow.js + SymmetryEditModule.js).
//
// The coordinate editor is now three stacked axis rows (label + slider + box).
// Axes the site symmetry freezes are greyed out and disabled; free axes drag
// live without the composition rebuild tearing the row out mid-drag.
'use strict';
const H = require('../harness');

async function enableWyckoff(page) {
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('symmetry');
  });
  await page.waitForTimeout(1500);
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
}

// Expand every Wyckoff composition row and open the first orbit's Position
// editor. Returns a description of that row's axis controls.
async function openFirstCoordEditor(page) {
  return page.evaluate(() => {
    const containers = [...document.querySelectorAll('.comp-container')];
    for (const c of containers) {
      /** @type {HTMLElement} */(c.querySelector('.comp-row'))?.click();
    }
    const rows = [...document.querySelectorAll('.individual-atom-row')];
    const row = rows.find((r) => {
      const btn = /** @type {HTMLButtonElement} */(r.querySelector('[data-editor-button="coord"]'));
      return btn && !btn.disabled;
    });
    if (!row) return null;
    /** @type {HTMLElement} */(row.querySelector('[data-editor-button="coord"]')).click();
    const editor = /** @type {HTMLElement} */(row.querySelector('.atom-coord-editor'));
    const axes = [...editor.querySelectorAll('.coord-axis-row')].map((r) => {
      const slider = /** @type {HTMLInputElement} */(r.querySelector('input[type="range"]'));
      const box = /** @type {HTMLInputElement} */(r.querySelector('input[type="number"]'));
      return {
        axis: /** @type {HTMLElement} */(r).dataset.axis,
        free: /** @type {HTMLElement} */(r).dataset.free === 'true',
        opacity: getComputedStyle(r).opacity,
        sliderDisabled: slider.disabled,
        boxDisabled: box.disabled,
        sliderValue: parseFloat(slider.value),
        boxValue: parseFloat(box.value),
        sliderWidth: slider.getBoundingClientRect().width,
        sliderTop: slider.getBoundingClientRect().top,
      };
    });
    return {
      atomIndex: Number(/** @type {HTMLElement} */(row).dataset.atomIndex),
      editorOpen: editor.style.display !== 'none',
      note: editor.querySelector('.coord-editor-note')?.textContent,
      axes,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await enableWyckoff(page);

  const orbits = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    return (fileBrowser.selectedStructure.symmetry?.orbitGroups ?? []).map((g) => ({
      wyckoff: g.wyckoff, dof: g.dofDimension, fixed: g.isFixed,
      freedom: sym.getOrbitAxisFreedom(g),
    }));
  });
  H.check('Wyckoff mode active with orbit groups', orbits.length > 0, `${orbits.length} orbits`);
  H.check('at least one orbit has a frozen axis (the case the greying is for)',
    orbits.some((o) => o.freedom.includes(false)),
    JSON.stringify(orbits.map((o) => `${o.wyckoff}:${o.freedom.map(Number).join('')}`)));
  H.check('fixed orbits report no free axis',
    orbits.filter((o) => o.fixed).every((o) => o.freedom.every((f) => !f)));

  const ed = await openFirstCoordEditor(page);
  H.check('a movable orbit exposes its coordinate editor', !!ed && ed.editorOpen);
  H.check('three stacked axis rows, each with a slider and a box',
    ed.axes.length === 3
      && ed.axes.map((a) => a.axis).join('') === 'xyz'
      && ed.axes.every((a) => a.sliderWidth > 40),
    JSON.stringify(ed.axes.map((a) => `${a.axis}:${Math.round(a.sliderWidth)}px`)));
  H.check('axis rows are stacked vertically, not side by side',
    ed.axes[0].sliderTop < ed.axes[1].sliderTop && ed.axes[1].sliderTop < ed.axes[2].sliderTop,
    JSON.stringify(ed.axes.map((a) => Math.round(a.sliderTop))));
  H.check('slider and box agree with each other',
    ed.axes.every((a) => Math.abs(a.sliderValue - a.boxValue) < 1e-3));
  H.check('editor states its degrees of freedom', /DOF|fixed/.test(ed.note || ''), ed.note);

  const frozen = ed.axes.filter((a) => !a.free);
  const free = ed.axes.filter((a) => a.free);
  H.check('frozen axes are disabled and greyed out',
    frozen.length > 0 && frozen.every((a) => a.sliderDisabled && a.boxDisabled
      && parseFloat(a.opacity) < 0.6),
    JSON.stringify(frozen.map((a) => `${a.axis} disabled=${a.sliderDisabled} op=${a.opacity}`)));
  H.check('free axes stay enabled at full opacity',
    free.length > 0 && free.every((a) => !a.sliderDisabled && !a.boxDisabled
      && parseFloat(a.opacity) > 0.9),
    JSON.stringify(free.map((a) => `${a.axis} op=${a.opacity}`)));

  // Drag a free axis' slider: the atom must move, the frozen axes must not,
  // and the editor must survive the drag (no composition rebuild).
  const freeAxis = ed.axes.findIndex((a) => a.free);
  const frozenAxis = ed.axes.findIndex((a) => !a.free);
  const before = await page.evaluate(
    (i) => import('./state/store.js').then((m) => [...m.fileBrowser.selectedStructure.atoms[i].position]),
    ed.atomIndex);

  const dragged = await page.evaluate(({ axis, target }) => {
    const row = [...document.querySelectorAll('.individual-atom-row')]
      .find((r) => /** @type {HTMLElement} */(r.querySelector('.atom-coord-editor')).style.display !== 'none');
    const slider = /** @type {HTMLInputElement} */(
      row.querySelectorAll('.coord-axis-row')[axis].querySelector('input[type="range"]'));
    slider.value = String(target);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { axis: freeAxis, target: (before[freeAxis] + 0.15) % 1 });
  await page.waitForTimeout(600);

  const after = await page.evaluate(async (i) => {
    const { fileBrowser } = await import('./state/store.js');
    const row = [...document.querySelectorAll('.individual-atom-row')]
      .find((r) => /** @type {HTMLElement} */(r.querySelector('.atom-coord-editor'))?.style.display !== 'none');
    const boxes = row
      ? [...row.querySelectorAll('.coord-axis-row input[type="number"]')].map((b) => parseFloat(/** @type {HTMLInputElement} */(b).value))
      : null;
    return {
      position: [...fileBrowser.selectedStructure.atoms[i].position],
      editorStillOpen: !!row,
      boxes,
    };
  }, ed.atomIndex);

  H.check('dragging a free axis moves the atom', dragged
    && Math.abs(after.position[freeAxis] - before[freeAxis]) > 1e-4,
    `${before[freeAxis]} -> ${after.position[freeAxis]}`);
  H.check('a frozen axis does not move', frozenAxis < 0
    || Math.abs(after.position[frozenAxis] - before[frozenAxis]) < 1e-6,
    `${before[frozenAxis]} -> ${after.position[frozenAxis]}`);
  H.check('the editor survives the drag (no composition rebuild mid-drag)',
    after.editorStillOpen === true);
  H.check('boxes track what actually landed on the atom',
    after.boxes && after.boxes.every((v, i) => Math.abs(v - after.position[i]) < 1e-5),
    JSON.stringify(after.boxes));

  // Symmetry must still hold across the whole orbit after the edit.
  const symmetryHolds = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const { analyzeStructureSymmetry } = await import('./ui/SymmetryEditModule.js');
    const d = await analyzeStructureSymmetry(s, 1e-4);
    return { number: d.number, before: s.symmetry.number };
  });
  H.check('space group preserved by the orbit edit',
    symmetryHolds.number === symmetryHolds.before,
    `${symmetryHolds.before} -> ${symmetryHolds.number}`);

  const shot = await page.$('.individual-atom-row .atom-coord-editor:not([style*="display: none"])');
  if (shot) {
    const handle = await shot.evaluateHandle((el) => el.closest('.individual-atom-row'));
    await handle.asElement().screenshot({
      path: require('path').join(__dirname, '..', 'artifacts', 'wyckoffeditor-ui.png'),
    });
  }

  // --- the trap: an orbit dragged onto its own symmetry partner ------------
  // Left unchecked this produces a cell moyo cannot analyse at all
  // (PrimitiveSymmetrySearchError), so the editor can never be re-enabled.
  const collapse = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const m = await import('./ui/SymmetryEditModule.js');
    const s = fileBrowser.selectedStructure;
    const orbit = s.symmetry.orbitGroups.find((g) => !g.isFixed && g.atomIndices.length > 1);
    if (!orbit) return null;
    const rep = orbit.representativeIndex;
    const before = [...s.atoms[rep].position];
    const target = [...before];
    target[2] = 0.5; // partner sits at -z, so both land on 1/2
    const applied = m.applyWyckoffOrbitPosition(rep, target, s, { reRenderComposition: false });
    const after = [...s.atoms[rep].position];
    let stillAnalysable = true;
    try { await m.analyzeStructureSymmetry(s, 0.01); } catch { stillAnalysable = false; }
    return { applied, moved: Math.abs(after[2] - before[2]) > 1e-9, stillAnalysable };
  });
  H.check('a site-collapsing move is refused, not applied',
    collapse && collapse.applied === false && collapse.moved === false, JSON.stringify(collapse));
  H.check('structure stays analysable after the refused move',
    collapse && collapse.stillAnalysable === true);

  // --- fail-soft: an unanalysable structure reports instead of throwing ----
  const failSoft = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const m = await import('./ui/SymmetryEditModule.js');
    const s = fileBrowser.selectedStructure;
    // Break the cell the way an MD frame can: a symmetry pair squeezed to
    // within the tolerance, which is what moyo's primitive-cell search chokes
    // on. (Written straight onto the atoms, bypassing the orbit guard.)
    s.atoms[0].position = [0.5, 0.5, 0.4995];
    s.atoms[1].position = [0.5, 0.5, 0.5005];
    m.deactivateWyckoffMode(s);
    document.getElementById('getWyckoffBtn').click();
    await new Promise((r) => setTimeout(r, 2000));
    return {
      status: document.getElementById('calcResult').textContent,
      button: document.getElementById('getWyckoffBtn').textContent.trim(),
      active: m.isWyckoffModeActive(s),
      resultHidden: document.getElementById('symResult').hidden,
    };
  });
  H.check('an unanalysable cell reports in the panel instead of throwing',
    /Symmetry search failed|Symmetry analysis failed|Tolerance/.test(failSoft.status || ''),
    failSoft.status);
  H.check('a failed enable leaves the editor off and the button consistent',
    failSoft.active === false && failSoft.button === 'Enable Wyckoff Editor'
      && failSoft.resultHidden === true, JSON.stringify(failSoft));

  // Same cell, the plain "Get Symmetry Info" path.
  const infoFail = await page.evaluate(async () => {
    document.getElementById('getSymBtn').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      status: document.getElementById('calcResult').textContent,
      resultHidden: document.getElementById('symResult').hidden,
    };
  });
  H.check('Get Symmetry Info reports the same failure instead of throwing',
    /Symmetry search failed/.test(infoFail.status || '') && infoFail.resultHidden === true,
    infoFail.status);

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
