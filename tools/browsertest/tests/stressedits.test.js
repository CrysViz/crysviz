// Stress test: every way to edit an atom's look or place, in every combination
// of the annotation and selection settings, checking after each edit that
// nothing else broke.
//
// Structure: rutile TiO2 written out in P1 with its charges (Ti4+, O2-), so
// the charges (Aˣ⁺) are there, a Wyckoff lock finds P4_2/mnm, and the O site
// (4f, x x 0) keeps a free coordinate.
//
// Combinations (32): atom labels (Aₓ) × charges (Aˣ⁺) × Wyckoff lock ×
// "Link colors of periodic copies" × Selection Inspector open. Each starts
// from a freshly loaded rutile, and checks its switches took (the lock must
// be rutile's: Ti 2a fixed, O 4f) before editing.
//
// Edits, through the real controls: an atom/orbit row's colour (picker +
// Apply), its Reset, its alpha and size sliders (+ Apply), its coordinates
// (+ Apply; a free Wyckoff coordinate under the lock), an element's colour
// (its composition row's editor + Apply), and the selection bar's colour
// (picker + Close), alpha, size and Reset. Each edit must change what it
// edits (the model), or it counts as a problem.
//
// After each edit, without forcing a frame (the app has to redraw by itself):
//   - the selection is the same atoms, and glows (no editor left open)
//   - names on (Aₓ): one label per drawn atom image, each with its atom's name,
//     anchored on that atom where it is now; off: none
//   - charges on: badges anchored on their atoms where they are now; off: none
//   - the inspector, when open, shows the selected atoms with their names and
//     charges as switched
//   - no console or page errors
// Problems are collected and reported per combination.
'use strict';
const H = require('../harness');

const TIO2 = [
  'data_rutile',
  '_cell_length_a 4.5937', '_cell_length_b 4.5937', '_cell_length_c 2.9587',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  'loop_', '_atom_site_label', '_atom_site_type_symbol',
  '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Ti1 Ti4+ 0 0 0', 'Ti2 Ti4+ 0.5 0.5 0.5',
  'O1 O2- 0.3048 0.3048 0', 'O2 O2- 0.6952 0.6952 0', 'O3 O2- 0.8048 0.1952 0.5', 'O4 O2- 0.1952 0.8048 0.5',
  '',
].join('\n');

const settle = (page, ms = 450) => page.waitForTimeout(ms);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // A fresh rutile for every combination: the coordinate edits move atoms,
  // and kept up across combinations they distort the cell until a Wyckoff
  // lock finds no symmetry left to lock.
  const loadRutile = async () => {
    await page.evaluate(async (t) => {
      const cv = await import('./core/crystal-viewer.js');
      window.__load = cv.loadStructure(t, 'rutile.cif');
    }, TIO2);
    await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')]
      .find((x) => /normal structure/i.test(x.textContent || ''))?.click());
    await page.evaluate(async () => { await window.__load; });
    await settle(page, 800);
  };
  await loadRutile();
  // The Symmetry window (for its Wyckoff switch) and the Structure window, open.
  await page.evaluate(async () => {
    (await import('./ui/panels/PanelManager.js')).openPanel('symmetry');
    (await import('./ui/StructureInfoPanel/General.js')).setStructurePanelOpen(true);
  });
  await settle(page, 1500);

  // ---- settings ----------------------------------------------------------------
  const setCombo = async (c) => {
    const now = await page.evaluate(async () => {
      const { general, fileBrowser } = await import('./state/store.js');
      return {
        wyckoff: fileBrowser.selectedStructure.symmetry?.mode === 'wyckoff',
        linked: general.linkPeriodicCopies !== false,
      };
    });
    if (now.wyckoff !== c.wyckoff) {
      await H.clickById(page, 'getWyckoffBtn');
      await settle(page, 2500);
    }
    if (now.linked !== c.linked) {
      await H.clickById(page, 'linkPeriodicCopiesToggle');
      await settle(page, 600);
    }
    // The switches really are as asked (a combination that silently ran
    // without its Wyckoff lock would test nothing new).
    const got = await page.evaluate(async () => {
      const { general, fileBrowser } = await import('./state/store.js');
      return {
        wyckoff: fileBrowser.selectedStructure.symmetry?.mode === 'wyckoff',
        linked: general.linkPeriodicCopies !== false,
        orbits: fileBrowser.selectedStructure.symmetry?.orbitGroups?.map((g) => `${g.element} ${g.multiplicity}${g.wyckoff}${g.isFixed ? ' fixed' : ''}`) ?? [],
      };
    });
    if (got.wyckoff !== c.wyckoff || got.linked !== c.linked) throw new Error(`combination not set: ${JSON.stringify({ want: c, got })}`);
    if (c.wyckoff && got.orbits.join(', ') !== 'Ti 2a fixed, O 4f') {
      throw new Error(`the lock should be rutile's (Ti 2a fixed, O 4f), got ${got.orbits.join(', ')}`);
    }
    await page.evaluate(async (c) => {
      const t = await import('./ui/AtomLabelsToggle.js');
      t.setAtomLabelsShown(c.labels);
      t.setChargesShown(c.charges);
      const si = await import('./ui/AnalysisPanels/SelectionInspector.js');
      if (!c.inspector) si.removeSelectionInspectorPanel();
    }, c);
    await settle(page);
  };

  // Select one Ti and one O: the first image of each (both copies glow when linked).
  const select = () => page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomsByInstances([s.atomImages[0][0], s.atomImages[2][0]]);
    return [0, 2];
  });

  // ---- invariants ------------------------------------------------------------------
  let errorsSeen = 0;
  const check = async (c, tag, expectedSel) => {
    const st = await page.evaluate(async ({ c }) => {
      const { atomSelection, groups, fileBrowser, general, app } = await import('./state/store.js');
      const { atomLabelSprites, atomLabelTexts } = await import('./render/AtomLabelModule.js');
      const { chargeBadgeAnchors } = await import('./render/ChargeBadgeModule.js');
      const s = fileBrowser.selectedStructure;
      const mesh = groups.atomsMesh;
      const m = mesh.instanceMatrix.array;
      const posOf = (i) => [m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14]];
      const radiusOf = (i) => Math.hypot(m[i * 16], m[i * 16 + 1], m[i * 16 + 2]);
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      const glow = mesh.geometry.attributes.instanceEmissiveIntensity;
      const linked = general.linkPeriodicCopies !== false;
      const sel = atomSelection.selectedAtoms;
      const glowInst = sel.flatMap((a) => (linked ? s.atomImages[a.sourceIndex] : [a.instanceId]));
      const problems = [];
      const unglowing = glowInst.filter((i) => !(glow.getX(i) > 0));
      if (unglowing.length) problems.push(`${unglowing.length}/${glowInst.length} selected instances not glowing`);
      const names = atomLabelTexts(s);
      const labels = atomLabelSprites();
      if (c.labels) {
        if (!labels.length) problems.push('names on, but no labels');
        const wrong = labels.filter((l) => l.text !== names[l.srcIndex]);
        if (wrong.length) problems.push(`${wrong.length} labels with a stale name (e.g. ${wrong[0].text} for ${names[wrong[0].srcIndex]})`);
        const off = labels.filter((l) => dist(l.anchor, posOf(l.instance)) > 1e-3);
        if (off.length) problems.push(`${off.length} labels not on their atom (by ${dist(off[0].anchor, posOf(off[0].instance)).toFixed(3)} Å)`);
        if (labels.length < s.atoms.length) problems.push(`only ${labels.length} labels for ${s.atoms.length} atoms`);
      } else if (labels.length) problems.push(`names off, but ${labels.length} labels`);
      const badges = chargeBadgeAnchors();
      if (c.charges) {
        if (!badges.length) problems.push('charges on, but no badges');
        const off = badges.filter((b) => dist(b.anchor, posOf(b.instance)) > 1e-3);
        if (off.length) problems.push(`${off.length} badges not at their atom (by ${dist(off[0].anchor, posOf(off[0].instance)).toFixed(3)} Å)`);
        const shrunk = badges.filter((b) => !(radiusOf(b.instance) > 0));
        if (shrunk.length) problems.push(`${shrunk.length} badges on hidden atoms`);
      } else if (badges.length) problems.push(`charges off, but ${badges.length} badges`);
      let inspector = null;
      if (c.inspector) {
        const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
        const ins = getSelectionInspectorState();
        if (!ins) problems.push('inspector should be open');
        else {
          const atomLabels = ins.labels.filter((l) => /^atom:/.test(l.key ?? ''));
          const chargeLabels = ins.labels.filter((l) => /^charge:/.test(l.key ?? ''));
          inspector = { atoms: ins.atoms, names: atomLabels.length, charges: chargeLabels.length };
          if (ins.atoms !== sel.length) problems.push(`inspector shows ${ins.atoms} atoms for ${sel.length} selected`);
          if (c.labels && atomLabels.length !== ins.atoms) problems.push(`inspector: ${atomLabels.length} names for ${ins.atoms} atoms`);
          if (!c.labels && atomLabels.length) problems.push('inspector: names while off');
          if (c.charges && chargeLabels.length !== ins.atoms) problems.push(`inspector: ${chargeLabels.length} charges for ${ins.atoms} atoms`);
          if (!c.charges && chargeLabels.length) problems.push('inspector: charges while off');
          const stale = atomLabels.filter((l) => !Object.values(names).includes(l.text));
          if (stale.length) problems.push(`inspector: stale name ${stale[0].text}`);
        }
      }
      void app;
      return { problems, sel: sel.map((a) => a.sourceIndex).sort(), inspector };
    }, { c });
    if (JSON.stringify(st.sel) !== JSON.stringify([...expectedSel].sort())) {
      st.problems.unshift(`selection changed: ${JSON.stringify(st.sel)}, expected ${JSON.stringify(expectedSel)}`);
    }
    const newErrors = errors.slice(errorsSeen);
    errorsSeen = errors.length;
    if (newErrors.length) st.problems.push(`errors: ${newErrors.join(' | ').slice(0, 300)}`);
    return st.problems.map((p) => `${tag}: ${p}`);
  };

  // ---- edits, through the real controls ---------------------------------------------
  // The first row of element `el` in the tab shown (Atoms, or Wyckoff under the lock).
  const rowSel = (el) => `:is(#atomPanel, #wyckoffPanel) .comp-container[data-element="${el}"] .individual-atom-row`;
  const openRow = (el, editor) => page.evaluate(({ sel, el, editor }) => {
    const box = document.querySelector(`:is(#atomPanel, #wyckoffPanel) .comp-container[data-element="${el}"] .individual-atoms`);
    if (!box) return 'no rows container';
    /** @type {any} */ (box)._populateAtomRows?.();
    box.style.display = 'block';
    const row = document.querySelector(sel);
    if (!row) return 'no row';
    const btn = row.querySelector(`.atom-editor-button[data-editor-button="${editor}"]`);
    if (!btn) return 'no editor button';
    if (btn.disabled) return 'disabled';
    btn.click();
    // Opened? (A position fixed by symmetry has a Position button that does
    // nothing — that edit is skipped, not counted as done.)
    const ed = row.querySelector(editor === 'coord' ? '.atom-coord-editor' : '.atom-color-editor');
    if (!ed || ed.style.display === 'none') return 'not opened';
    return 'ok';
  }, { sel: rowSel(el), el, editor });
  // What an edit should change: the row's atom (or the selected atoms) as the
  // model holds it — its own colour, alpha, size, position, per-copy style.
  const modelState = (el, which) => page.evaluate(({ sel, which }) => (async () => {
    const { fileBrowser, atomSelection } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const of = (i) => {
      const a = s.atoms[i];
      return { color: a.userColor ?? null, alpha: a.getOpacity?.(), size: a.getRadiusScale?.(), pos: a.position.map((v) => v.toFixed(5)) };
    };
    // Every atom's colour too, so an element-wide edit counts.
    const styles = JSON.stringify([s.atomImageStyles ?? {}, s.atoms.map((a, i) => String(a.getColor?.(i)))]);
    if (which === 'selection') return JSON.stringify({ atoms: atomSelection.selectedAtoms.map((a) => of(a.sourceIndex)), styles });
    const row = document.querySelector(sel);
    if (!row) return null;
    return JSON.stringify({ atom: of(Number(row.dataset.atomIndex)), styles });
  })(), { sel: rowSel(el), which });
  const inEditor = (el, editorClass, fn, arg) => page.evaluate(({ sel, editorClass, fnSrc, arg }) => {
    const row = document.querySelector(sel);
    const ed = row?.querySelector(editorClass);
    if (!ed) return 'no editor';
    // eslint-disable-next-line no-new-func
    return new Function('ed', 'arg', fnSrc)(ed, arg);
  }, { sel: rowSel(el), editorClass, fnSrc: fn, arg });
  const clickIn = (el, editorClass, text) => inEditor(el, editorClass, `
    const b = [...ed.querySelectorAll('button')].find((x) => x.textContent.trim() === arg);
    if (!b) return 'no ' + arg;
    b.click();
    return 'ok';`, text);

  // The editor's slider in the row labelled `label` (Alpha, Size).
  const slider = (label) => `
    const row = [...ed.querySelectorAll('.si-row')].find((r) => r.querySelector('.si-row-label')?.textContent.trim() === '${label}');
    const r = row?.querySelector('input[type="range"]');
    if (!r) return 'no ${label} slider';
    r.value = arg; r.dispatchEvent(new Event('input'));
    return 'ok';`;
  const edits = [
    ['row colour', async (el) => {
      if (await openRow(el, 'color') !== 'ok') return 'skip';
      await inEditor(el, '.atom-color-editor', `
        const f = ed.querySelectorAll('.cv-colorpicker-input-field');
        const hex = f[f.length - 1];
        hex.value = arg; hex.dispatchEvent(new Event('change'));
        return 'ok';`, '#22aa88');
      return clickIn(el, '.atom-color-editor', 'Apply');
    }],
    ['row colour reset', async (el) => {
      if (await openRow(el, 'color') !== 'ok') return 'skip';
      const r = await clickIn(el, '.atom-color-editor', 'Reset');
      await settle(page, 300);
      const open = await page.evaluate((sel) => document.querySelector(sel)?.querySelector('.atom-color-editor')?.style.display !== 'none', rowSel(el));
      return open ? 'editor left open' : r;
    }],
    ['row alpha', async (el) => {
      if (await openRow(el, 'color') !== 'ok') return 'skip';
      await inEditor(el, '.atom-color-editor', slider('Alpha'), '0.6');
      return clickIn(el, '.atom-color-editor', 'Apply');
    }],
    ['row size', async (el) => {
      if (await openRow(el, 'color') !== 'ok') return 'skip';
      await inEditor(el, '.atom-color-editor', slider('Size'), '1.3');
      return clickIn(el, '.atom-color-editor', 'Apply');
    }],
    ['row coordinates', async (el) => {
      const open = await openRow(el, 'coord');
      if (open !== 'ok') return 'skip';
      await inEditor(el, '.atom-coord-editor', `
        const inputs = [...ed.querySelectorAll('.coord-axis-row input:not([type="range"])')];
        const x = inputs[0];
        x.value = (parseFloat(x.value) + arg).toFixed(6); x.dispatchEvent(new Event('input'));
        return 'ok';`, 0.01);
      return clickIn(el, '.atom-coord-editor', 'Apply');
    }],
    ['element colour', async (el) => {
      // The element's dot in its composition row opens the element editor.
      const opened = await page.evaluate((el) => {
        const c = document.querySelector(`:is(#atomPanel, #wyckoffPanel) .comp-container[data-element="${el}"]`);
        const dot = c?.querySelector('.comp-row .dot');
        if (!dot) return 'no dot';
        dot.click();
        const ed = c.querySelector('.element-color-editor:not(.spin-force-category-editor)');
        return ed && ed.style.display !== 'none' ? 'ok' : 'not opened';
      }, el);
      if (opened !== 'ok') return opened;
      return page.evaluate((el) => {
        const c = document.querySelector(`:is(#atomPanel, #wyckoffPanel) .comp-container[data-element="${el}"]`);
        const ed = c.querySelector('.element-color-editor:not(.spin-force-category-editor)');
        const f = ed.querySelectorAll('.cv-colorpicker-input-field');
        const hex = f[f.length - 1];
        hex.value = el === 'O' ? '#cc3355' : '#5577cc';
        hex.dispatchEvent(new Event('change'));
        const apply = [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply');
        if (!apply) return 'no Apply';
        apply.click();
        // Apply closes the editor (in the re-rendered row).
        const now = document.querySelector(`:is(#atomPanel, #wyckoffPanel) .comp-container[data-element="${el}"] .element-color-editor:not(.spin-force-category-editor)`);
        return now && now.style.display !== 'none' ? 'editor left open' : 'ok';
      }, el);
    }],
    ['selection bar colour', async () => {
      const opened = await page.evaluate(() => {
        const sw = document.querySelector('#selectionActionBar .si-selbar-swatch');
        if (!sw) return 'no swatch';
        sw.click();
        return document.querySelector('.swatch-color-picker') ? 'ok' : 'not opened';
      });
      if (opened !== 'ok') return opened;
      return page.evaluate(() => {
        const panel = document.querySelector('.swatch-color-picker');
        const f = panel.querySelectorAll('.cv-colorpicker-input-field');
        const hex = f[f.length - 1];
        hex.value = '#eeaa22';
        hex.dispatchEvent(new Event('change'));
        const close = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close');
        if (!close) return 'no Close';
        close.click();
        return 'ok';
      });
    }],
    ['selection bar alpha+size', async () => page.evaluate(() => {
      const bar = document.getElementById('selectionActionBar');
      const r = bar ? [...bar.querySelectorAll('.si-row input[type="range"]')] : [];
      if (r.length < 2) return 'skip';
      r[0].value = '0.8'; r[0].dispatchEvent(new Event('input'));
      r[1].value = '1.2'; r[1].dispatchEvent(new Event('input'));
      return 'ok';
    })],
    ['selection bar reset', async () => page.evaluate(() => {
      const b = document.querySelector('#selectionActionBar .si-selbar-reset');
      if (!b) return 'skip';
      b.click();
      return 'ok';
    })],
  ];

  // ---- run every combination -------------------------------------------------------
  const combos = [];
  for (const wyckoff of [false, true]) {
    for (const linked of [true, false]) {
      for (const labels of [false, true]) {
        for (const charges of [false, true]) {
          for (const inspector of [false, true]) combos.push({ wyckoff, linked, labels, charges, inspector });
        }
      }
    }
  }
  const all = [];
  // STRESS_COMBOS=n runs only the first n (a quick sanity run).
  const limit = Number(process.env.STRESS_COMBOS || 0);
  const nameOf = (c) => `${c.wyckoff ? 'wyckoff' : 'plain'}/${c.linked ? 'linked' : 'unlinked'}/names ${c.labels ? 'on' : 'off'}/charges ${c.charges ? 'on' : 'off'}/inspector ${c.inspector ? 'open' : 'closed'}`;
  // STRESS_ONLY=<substring> runs only the combinations whose name contains it.
  const only = process.env.STRESS_ONLY || '';
  const chosen = combos.filter((c) => !only || nameOf(c).includes(only));
  for (const c of limit ? chosen.slice(0, limit) : chosen) {
    const name = nameOf(c);
    await loadRutile();
    await page.evaluate(async () => (await import('./ui/StructureInfoPanel/General.js')).setStructurePanelOpen(true));
    await setCombo(c);
    const sel = await select();
    if (c.inspector) {
      await page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).openSelectionInspector());
      await settle(page, 900);
    }
    await settle(page);
    const problems = [...await check(c, 'after selecting', sel)];
    const skipped = [];
    for (const [label, run] of edits) {
      const onSelection = label.startsWith('selection bar'); // acts on the selection, not on one element
      for (const el of onSelection ? ['selection'] : ['O', 'Ti']) {
        const before = await modelState(el, onSelection ? 'selection' : 'row');
        const r = await run(el);
        if (r === 'skip') { skipped.push(`${label} ${el}`); continue; }
        await settle(page, 500);
        const after = await modelState(el, onSelection ? 'selection' : 'row');
        // A reset of something already at its defaults changes nothing.
        if (before === after && !/reset/.test(label)) problems.push(`${label} (${el}): no effect (${r})`);
        if (r !== 'ok') problems.push(`${label} (${el}): ${r}`);
        problems.push(...await check(c, `${label} (${el})`, sel));
      }
    }
    all.push({ name, problems, skipped });
    H.check(`${name}: every edit keeps the selection, its glow, the names and the charges right`,
      problems.length === 0, JSON.stringify({ problems: problems.slice(0, 8), skipped }));
  }
  const withProblems = all.filter((r) => r.problems.length);
  console.log(`  ${all.length} combinations, ${withProblems.length} with problems`);
  H.check('no console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
