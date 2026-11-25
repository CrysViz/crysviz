// Files window ▸ ≡ ▸ Average Structure: one new structure whose fractional
// positions and cell are the mean over every frame of the checked rows
// (model/averageFrames.js, ui/FileBrowswerPanel.js).
//
//   - the item follows Make Trajectory and is greyed out, with the reason as
//     its tooltip, for fewer than two frames and for frames whose atoms differ
//     (count, or species order)
//   - one checked trajectory row averages its frames; an atom that crosses a
//     cell face between frames is averaged at its nearest image of the first
//     frame (a plain mean would put it in the middle of the cell)
//   - two single-structure rows average too, cells included
//   - the name prompt offers "Average Structure"; the new row is appended,
//     selected, one frame, and the source rows are unchecked
//   - frames where an atom moves more than 0.1 of a cell axis from its first
//     position bring up a warning first (ui/AverageMovesModal.js), listing
//     those atoms worst first with the move in Å and as a fraction of the
//     axis, and where it happens; a click shows the atom (its row at that
//     frame, the atom glowing); Cancel and Escape make nothing and put the
//     view back; Average anyway goes on to the name prompt. Quiet frames
//     (the cases above) go straight to the name prompt.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const xyz = (cell, atoms) => [
  String(atoms.length),
  `Lattice="${cell}" Properties=species:S:1:pos:R:3`,
  ...atoms.map((a) => a.join(' ')),
];
const cubic = (a) => `${a} 0.0 0.0 0.0 ${a} 0.0 0.0 0.0 ${a}`;

// Three frames in a 4 Å cube. Na leaves through x = 1 and comes back at
// x ≈ 0 (fractional 0.98 -> 0.01 -> 0.03, mean 1.00667 = 0.00667), and
// through z = 0 the other way (0 -> 0 -> 0.99, mean 0.99667). The first Cl
// wobbles about the cell centre, the second does not move.
const TRAJ = [
  ...xyz(cubic(4.0), [['Na', 3.92, 2.0, 0.0], ['Cl', 2.0, 2.0, 2.0], ['Cl', 1.0, 1.0, 1.0]]),
  ...xyz(cubic(4.0), [['Na', 0.04, 2.0, 0.0], ['Cl', 2.2, 2.0, 2.0], ['Cl', 1.0, 1.0, 1.0]]),
  ...xyz(cubic(4.0), [['Na', 0.12, 2.0, 3.96], ['Cl', 1.8, 2.2, 2.0], ['Cl', 1.0, 1.0, 1.0]]),
].join('\n');
const TRAJ_MEAN = [[0.02 / 3, 0.5, 1 - 0.01 / 3], [0.5, 0.55 / 3 + 1 / 3, 0.5], [0.25, 0.25, 0.25]];

// Two single structures with different cells (4.0 and 4.4 Å): Na at
// fractional 0.05 and 0.95 — 0.1 apart through the face — averages to 0.
const CELL_A = xyz(cubic(4.0), [['Na', 0.2, 2.0, 2.0], ['Cl', 2.0, 0.2, 2.0]]).join('\n');
const CELL_B = xyz(cubic(4.4), [['Na', 4.18, 2.2, 2.2], ['Cl', 2.2, 0.22, 2.2]]).join('\n');
const AB_MEAN = [[0, 0.5, 0.5], [0.5, 0.05, 0.5]];
// The same atoms as CELL_A in the other order.
const SWAPPED = xyz(cubic(4.0), [['Cl', 2.0, 0.2, 2.0], ['Na', 0.2, 2.0, 2.0]]).join('\n');
// Na hops 0.3 of a (1.2 Å) in frame 2, the second Cl 0.15 of b (0.6 Å) in
// frame 3, the first Cl stays: two atoms over the 0.1 threshold, Na first.
const HOP = [
  ...xyz(cubic(4.0), [['Na', 0.4, 1.0, 1.0], ['Cl', 2.0, 2.0, 2.0], ['Cl', 1.0, 1.0, 3.0]]),
  ...xyz(cubic(4.0), [['Na', 1.6, 1.0, 1.0], ['Cl', 2.0, 2.0, 2.0], ['Cl', 1.0, 1.0, 3.0]]),
  ...xyz(cubic(4.0), [['Na', 0.6, 1.0, 1.0], ['Cl', 2.0, 2.0, 2.0], ['Cl', 1.0, 1.6, 3.0]]),
].join('\n');
const HOP_MEAN = [[0.65 / 3, 0.25, 0.25], [0.5, 0.5, 0.5], [0.25, 0.3, 0.75]];

/** Largest |a - b| over two position lists (fractional, compared through the
 *  cell face: 0.9999999 and 0 are the same place). */
function maxDiff(a, b) {
  let m = 0;
  a.forEach((p, i) => p.forEach((x, k) => {
    let d = x - b[i][k];
    d -= Math.round(d);
    m = Math.max(m, Math.abs(d));
  }));
  return m;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async ({ TRAJ, CELL_A, CELL_B, SWAPPED, HOP }) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(TRAJ, 'traj.xyz');
    await cv.loadStructure(CELL_A, 'cellA.xyz');
    await cv.loadStructure(CELL_B, 'cellB.xyz');
    await cv.loadStructure(SWAPPED, 'swapped.xyz');
    await cv.loadStructure(HOP, 'hop.xyz');
  }, { TRAJ, CELL_A, CELL_B, SWAPPED, HOP });
  await page.waitForTimeout(2000);

  const rowNames = () => page.evaluate(() =>
    [...document.querySelectorAll('#objectTable tbody tr .name-inner')].map((n) => n.textContent));
  const names = await rowNames();
  H.check('the trajectory and the three structures are loaded',
    ['traj.xyz', 'cellA.xyz', 'cellB.xyz', 'swapped.xyz', 'hop.xyz'].every((n) => names.includes(n)), JSON.stringify(names));
  const firstRow = names[0];

  /** Check exactly the rows named in `which` (through their checkboxes). */
  const checkRows = (which) => page.evaluate((which) => {
    for (const row of document.querySelectorAll('#objectTable tbody tr')) {
      const cb = /** @type {HTMLInputElement} */ (row.querySelector('input[type="checkbox"]'));
      const want = which.includes(row.querySelector('.name-inner').textContent);
      if (cb.checked !== want) {
        cb.checked = want;
        cb.dispatchEvent(new Event('change'));
      }
    }
  }, which);

  /** Open the ≡ menu, read it, close it again (unless keepOpen). */
  const readMenu = async (keepOpen = false) => {
    await page.click('#combineTrajectoriesButton');
    const m = await page.evaluate(() => {
      const menu = document.querySelector('.cv-panel-menu');
      if (!menu) return null;
      const items = [...menu.querySelectorAll('.cv-panel-menu-item')];
      const avg = items.find((b) => b.textContent === 'Average Structure');
      return {
        labels: items.map((b) => b.textContent),
        disabled: avg ? avg.disabled : null,
        title: avg ? avg.title : null,
      };
    });
    if (!keepOpen) await page.keyboard.press('Escape');
    return m;
  };

  // ---- 1. the item, and when it is greyed out --------------------------------
  let m = await readMenu();
  H.check('Average Structure follows Make Trajectory in the ≡ menu',
    m && JSON.stringify(m.labels) === JSON.stringify(['Deselect', 'Select all', 'Make Trajectory', 'Average Structure']),
    JSON.stringify(m));
  H.check('nothing checked: Average Structure is greyed out and says why',
    m.disabled === true && /Check a trajectory/.test(m.title), JSON.stringify(m));

  await checkRows(['cellA.xyz']);
  m = await readMenu();
  H.check('one single-frame row: greyed out (one frame is nothing to average)',
    m.disabled === true && /Check a trajectory/.test(m.title), JSON.stringify(m));

  await checkRows(['traj.xyz', firstRow]);
  m = await readMenu();
  H.check('frames with different atom counts: greyed out, the tooltip names the counts',
    m.disabled === true && /same atoms in every frame: one has \d+ atoms, another \d+/.test(m.title), JSON.stringify(m));

  await checkRows(['cellA.xyz', 'swapped.xyz']);
  m = await readMenu();
  H.check('the same atoms in another order: greyed out, the tooltip names the atom',
    m.disabled === true && /same order in every frame: atom 1 is Na in one and Cl in another/.test(m.title), JSON.stringify(m));

  // ---- 2. one trajectory row: the mean of its three frames --------------------
  // Show the trajectory first, so the frame it renders through is averaged too.
  await page.evaluate(() => [...document.querySelectorAll('#objectTable tbody tr')]
    .find((r) => r.querySelector('.name-inner').textContent === 'traj.xyz')
    .querySelector('.name-cell').click());
  await page.waitForTimeout(500);
  await checkRows(['traj.xyz']);
  m = await readMenu(true);
  H.check('one checked 3-frame trajectory: enabled, "3 frames" in the tooltip',
    m.disabled === false && /3 frames/.test(m.title), JSON.stringify(m));

  // Screenshot of the open menu with the Files list, for review.
  const clip = await page.evaluate(() => {
    const r1 = document.querySelector('.cv-panel-menu').getBoundingClientRect();
    const r2 = document.getElementById('objectTable').getBoundingClientRect();
    const x = Math.max(0, Math.min(r1.left, r2.left) - 8);
    const y = Math.max(0, Math.min(r1.top, r2.top) - 8);
    return { x, y, width: Math.max(r1.right, r2.right) + 8 - x, height: Math.max(r1.bottom, r2.bottom) + 8 - y };
  });
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'averagestructure-menu.png'), clip });

  const rowsBefore = (await rowNames()).length;
  await page.evaluate(() => [...document.querySelectorAll('.cv-panel-menu .cv-panel-menu-item')]
    .find((b) => b.textContent === 'Average Structure').click());
  await page.waitForSelector('.combine-name-popup-overlay', { timeout: 5000 });
  H.check('quiet frames (moves under 0.1 of an axis): no warning, straight to the name prompt',
    await page.evaluate(() => !document.getElementById('averageMovesModal') || document.getElementById('averageMovesModal').hidden), '');
  const prompt = await page.evaluate(() => ({
    label: document.querySelector('.combine-name-popup-overlay .cv-fb-popup-label')?.textContent,
    value: /** @type {HTMLInputElement} */ (document.querySelector('.combine-name-input'))?.value,
    confirm: document.querySelector('.combine-name-popup-overlay .cv-fb-popup-btn:last-child')?.textContent,
  }));
  H.check('the name prompt offers "Average Structure" for the average of 3 frames',
    prompt.value === 'Average Structure' && prompt.label === 'Name for the average of 3 frames:' && prompt.confirm === 'Average',
    JSON.stringify(prompt));
  await page.click('.combine-name-popup-overlay .cv-fb-popup-btn:last-child');
  await page.waitForTimeout(1500);

  const readResult = () => page.evaluate(async () => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const rows = [...document.querySelectorAll('#objectTable tbody tr')];
    const last = rows[rows.length - 1];
    const container = structureShip.container[rows.length - 1];
    const s = container.structures[0];
    return {
      nRows: rows.length,
      name: last.querySelector('.name-inner').textContent,
      fileName: container.fileName,
      trajCell: last.querySelector('td:nth-child(3)').textContent,
      frames: container.frameCount,
      selected: last.classList.contains('selected') && fileBrowser.selectedStructure === s,
      nChecked: rows.filter((r) => r.querySelector('input[type="checkbox"]').checked).length,
      elements: s.elements,
      positions: s.atoms.map((a) => a.position),
      lattice: s.lattice,
      forces: s.forces.length,
      energy: s.energy,
    };
  });
  let r = await readResult();
  H.check('one row appended, named "Average Structure", one frame, selected',
    r.nRows === rowsBefore + 1 && r.name === 'Average Structure' && r.fileName === 'Average Structure'
      && r.trajCell === '1' && r.frames === 1 && r.selected,
    JSON.stringify({ ...r, positions: undefined }));
  H.check('the source row is unchecked', r.nChecked === 0, `checked=${r.nChecked}`);
  H.check('same atoms in the same order', JSON.stringify(r.elements) === JSON.stringify(['Na', 'Cl', 'Cl']),
    JSON.stringify(r.elements));
  H.check('positions are the mean, Na at its nearest image of frame 1 (x 0.0067, z 0.9967 — not 0.34, 0.33)',
    maxDiff(r.positions, TRAJ_MEAN) < 1e-9, `${JSON.stringify(r.positions)} vs ${JSON.stringify(TRAJ_MEAN)}`);
  H.check('the positions are inside the cell [0, 1)',
    r.positions.every((p) => p.every((x) => x >= 0 && x < 1)), JSON.stringify(r.positions));
  H.check('the constant cell is kept exactly', JSON.stringify(r.lattice) === JSON.stringify([[4, 0, 0], [0, 4, 0], [0, 0, 4]]),
    JSON.stringify(r.lattice));
  H.check('no forces or energy carried over', r.forces === 0 && r.energy === null, `forces=${r.forces} energy=${r.energy}`);
  const source = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const rows = [...document.querySelectorAll('#objectTable tbody tr')];
    const i = rows.findIndex((row) => row.querySelector('.name-inner').textContent === 'traj.xyz');
    const frames = await Promise.resolve(structureShip.container[i].framePhysicsList());
    return frames.map((f) => f.positions[0]);
  });
  H.check('the trajectory row is left as it was (3 frames, Na where the file puts it)',
    maxDiff(source, [[0.98, 0.5, 0], [0.01, 0.5, 0], [0.03, 0.5, 0.99]]) < 1e-12, JSON.stringify(source));

  // ---- 3. two single-structure rows, different cells, a name of our own --------
  await checkRows(['cellA.xyz', 'cellB.xyz']);
  m = await readMenu(true);
  H.check('two checked single structures with the same atoms: enabled',
    m.disabled === false && /2 frames/.test(m.title), JSON.stringify(m));
  await page.evaluate(() => [...document.querySelectorAll('.cv-panel-menu .cv-panel-menu-item')]
    .find((b) => b.textContent === 'Average Structure').click());
  await page.waitForSelector('.combine-name-input', { timeout: 5000 });
  await page.fill('.combine-name-input', 'AB mean');
  await page.press('.combine-name-input', 'Enter');
  await page.waitForTimeout(1500);
  r = await readResult();
  H.check('the typed name is the new row\'s', r.name === 'AB mean' && r.fileName === 'AB mean', r.name);
  H.check('the cell is the mean of 4.0 and 4.4 Å',
    Math.abs(r.lattice[0][0] - 4.2) < 1e-12 && Math.abs(r.lattice[1][1] - 4.2) < 1e-12
      && Math.abs(r.lattice[2][2] - 4.2) < 1e-12 && r.lattice[0][1] === 0,
    JSON.stringify(r.lattice));
  H.check('positions are the mean through the face (Na 0.05 and 0.95 -> 0)',
    maxDiff(r.positions, AB_MEAN) < 1e-9, `${JSON.stringify(r.positions)} vs ${JSON.stringify(AB_MEAN)}`);

  // ---- 4. the average itself renders (atoms in the scene) ---------------------
  const drawn = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
    return { n: wrapped?.elements?.length ?? 0 };
  });
  H.check('the average structure is drawn (periodic images built)', drawn.n >= 2, JSON.stringify(drawn));

  // ---- 5. atoms that move far: the warning ------------------------------------
  /** What the view shows: the selected row, every row's step box, the camera,
   *  and the atoms glowing (as source indices). */
  const viewState = () => page.evaluate(async () => {
    const { fileBrowser, highlightHover, app } = await import('./state/store.js');
    const rows = [...document.querySelectorAll('#objectTable tbody tr')];
    const src = fileBrowser.selectedStructure?.periodic?.visibleWrapped?.srcIndex;
    const glowing = [...new Set((highlightHover.currentlyHighlightedAtomInstances ?? []).map((i) => (src ? src[i] : i)))];
    return {
      row: rows[fileBrowser.selectedRowIndex]?.querySelector('.name-inner').textContent,
      steps: rows.map((r) => r.querySelector('input[type="number"]').value),
      camera: [...app.camera.position.toArray(), ...app.controls.target.toArray()].map((v) => +v.toFixed(6)),
      glowing,
      naX: fileBrowser.selectedStructure?.atoms?.[0]?.position?.[0],
    };
  });
  const readWarning = () => page.evaluate(() => {
    const modal = document.getElementById('averageMovesModal');
    if (!modal || modal.hidden) return null;
    return {
      title: document.getElementById('averageMovesTitle').textContent,
      message: document.getElementById('averageMovesMessage').textContent,
      rows: [...modal.querySelectorAll('.avg-moves-row')].map((r) =>
        [...r.children].map((c) => c.textContent)),
      choices: [...modal.querySelectorAll('.confirm-choice .confirm-choice-label')].map((c) => c.textContent),
      shown: [...modal.querySelectorAll('.avg-moves-row')].map((r) => r.classList.contains('is-shown')),
    };
  });
  const clickAverage = () => page.evaluate(() => [...document.querySelectorAll('.cv-panel-menu .cv-panel-menu-item')]
    .find((b) => b.textContent === 'Average Structure').click());
  const openWarning = async () => {
    await checkRows(['hop.xyz']);
    await readMenu(true);
    await clickAverage();
    await page.waitForSelector('#averageMovesModal:not([hidden])', { timeout: 5000 });
  };

  // Show a different row than the one averaged, so putting the view back shows.
  await page.evaluate(() => [...document.querySelectorAll('#objectTable tbody tr')]
    .find((r) => r.querySelector('.name-inner').textContent === 'cellA.xyz')
    .querySelector('.name-cell').click());
  await page.waitForTimeout(500);
  // An off-centre camera, so Show's recentring and putting it back both show.
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.controls.target.set(0.5, 0.25, 0);
    app.camera.position.set(9, 7, 11);
    app.controls.update();
  });
  // And a selected atom (cellA's Cl), whose glow must come back.
  const selectAtom = (i) => page.evaluate(async (i) => {
    (await import('./ui/SelectAndHighlightModule.js')).selectAtomFromRow(i);
  }, i);
  await selectAtom(1);
  await page.waitForTimeout(500);
  const before = await viewState();
  const rowsBeforeHop = (await rowNames()).length;

  await openWarning();
  let w = await readWarning();
  H.check('far moves: a warning before the name prompt',
    w && w.title === 'Atoms move far between frames'
      && /2 atoms move more than 0\.1 of a cell axis/.test(w.message) && /first of the 3 frames/.test(w.message)
      && !(await page.$('.combine-name-popup-overlay')),
    JSON.stringify(w));
  H.check('the atoms are listed worst first: name, move in Å and of the axis, where',
    w && JSON.stringify(w.rows) === JSON.stringify([
      ['Na1', '1.20 Å · 0.30 of a', 'hop.xyz, frame 2', 'Show'],
      ['Cl2', '0.60 Å · 0.15 of b', 'hop.xyz, frame 3', 'Show'],
    ]), JSON.stringify(w && w.rows));
  H.check('the choices are Average anyway, then Cancel',
    w && JSON.stringify(w.choices) === JSON.stringify(['Average anyway', 'Cancel']), JSON.stringify(w && w.choices));

  // Screenshot of the warning, for review.
  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'averagestructure-warning.png') });

  // Show Na1: its row at frame 2, Na where frame 2 puts it, Na glowing.
  await page.click('.avg-moves-row:nth-child(1)');
  await page.waitForTimeout(800);
  let v = await viewState();
  const hopIndex = (await rowNames()).indexOf('hop.xyz');
  H.check('Show: hop.xyz is shown at frame 2 (Na at x 0.4), the camera centred on it',
    v.row === 'hop.xyz' && v.steps[hopIndex] === '2' && Math.abs(v.naX - 0.4) < 1e-9
      && JSON.stringify(v.camera) !== JSON.stringify(before.camera), JSON.stringify(v));
  const glow = await page.evaluate(async () => {
    const { groups, highlightHover } = await import('./state/store.js');
    const ids = highlightHover.currentlyHighlightedAtomInstances ?? [];
    const intensity = groups.atomsMesh?.geometry?.attributes?.instanceEmissiveIntensity;
    return ids.map((i) => intensity?.getX(i));
  });
  H.check('Show: Na1 glows, as a Structure-window row click makes it, and nothing else',
    JSON.stringify(v.glowing) === '[0]' && glow.length > 0 && glow.every((x) => x === 2),
    JSON.stringify({ glowing: v.glowing, glow }));
  w = await readWarning();
  H.check('the shown atom\'s row is marked', w && w.shown[0] === true && w.shown[1] === false, JSON.stringify(w && w.shown));

  // Show Cl2: frame 3, the second Cl glowing.
  await page.click('.avg-moves-row:nth-child(2)');
  await page.waitForTimeout(800);
  v = await viewState();
  H.check('Show another: hop.xyz at frame 3, Cl2 (atom 3) glowing',
    v.row === 'hop.xyz' && v.steps[hopIndex] === '3' && JSON.stringify(v.glowing) === '[2]', JSON.stringify(v));

  // Cancel: nothing made, the view as it was.
  await page.evaluate(() => [...document.querySelectorAll('#averageMovesModal .confirm-choice')]
    .find((b) => b.textContent.startsWith('Cancel')).click());
  await page.waitForTimeout(1000);
  v = await viewState();
  H.check('Cancel: the warning closes, no name prompt, no new row',
    !(await readWarning()) && !(await page.$('.combine-name-popup-overlay')) && (await rowNames()).length === rowsBeforeHop, '');
  H.check('Cancel: the row, the step boxes and the camera are as before, the selected atom glows again',
    v.row === before.row && JSON.stringify(v.steps) === JSON.stringify(before.steps)
      && JSON.stringify(v.camera) === JSON.stringify(before.camera)
      && JSON.stringify(v.glowing) === JSON.stringify(before.glowing),
    JSON.stringify({ before, after: v }));
  H.check('Cancel: hop.xyz is still checked', await page.evaluate(() => [...document.querySelectorAll('#objectTable tbody tr')]
    .find((r) => r.querySelector('.name-inner').textContent === 'hop.xyz')
    .querySelector('input[type="checkbox"]').checked), '');

  H.check('(before: cellA\'s Cl was selected and glowing)', JSON.stringify(before.glowing) === '[1]', JSON.stringify(before.glowing));

  // Escape cancels too — here with the averaged row itself on show, at its
  // frame 3 with its second atom selected: Show moves it to frame 2, Escape
  // must bring frame 3 and the selection back.
  await page.evaluate(() => [...document.querySelectorAll('#objectTable tbody tr')]
    .find((r) => r.querySelector('.name-inner').textContent === 'hop.xyz')
    .querySelector('.name-cell').click());
  await page.waitForTimeout(500);
  await selectAtom(1);
  await page.waitForTimeout(500);
  const beforeSame = await viewState();
  await openWarning();
  await page.click('.avg-moves-row:nth-child(1)');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  v = await viewState();
  H.check('Escape: closes like Cancel, no new row; same row: frame 3 again, its selected atom glowing',
    !(await readWarning()) && !(await page.$('.combine-name-popup-overlay')) && (await rowNames()).length === rowsBeforeHop
      && v.row === 'hop.xyz' && beforeSame.row === 'hop.xyz'
      && JSON.stringify(v.steps) === JSON.stringify(beforeSame.steps) && Math.abs(v.naX - 0.15) < 1e-9
      && JSON.stringify(v.camera) === JSON.stringify(beforeSame.camera)
      && JSON.stringify(beforeSame.glowing) === '[1]' && JSON.stringify(v.glowing) === '[1]',
    JSON.stringify({ beforeSame, after: v }));

  // Average anyway: the name prompt, then the row as before. The ≡ button
  // keeps the focus when the item is picked (as Safari leaves it after a
  // click): the warning gives it back on closing, which must not take it
  // from the name field that follows.
  await checkRows(['hop.xyz']);
  await readMenu(true);
  await page.evaluate(() => {
    document.getElementById('combineTrajectoriesButton').focus();
    [...document.querySelectorAll('.cv-panel-menu .cv-panel-menu-item')]
      .find((b) => b.textContent === 'Average Structure').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForSelector('#averageMovesModal:not([hidden])', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('#averageMovesModal .confirm-choice')]
    .find((b) => b.textContent.startsWith('Average anyway')).click());
  await page.waitForSelector('.combine-name-popup-overlay', { timeout: 5000 });
  await page.waitForTimeout(300);
  H.check('Average anyway: the warning closes and the name prompt follows',
    !(await readWarning()) && await page.evaluate(() =>
      document.querySelector('.combine-name-popup-overlay .cv-fb-popup-label')?.textContent === 'Name for the average of 3 frames:'), '');
  H.check('Average anyway: the name field has the focus (typing names the row)',
    await page.evaluate(() => document.activeElement?.classList.contains('combine-name-input')),
    await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}.${document.activeElement?.className}`));
  await page.click('.combine-name-popup-overlay .cv-fb-popup-btn:last-child');
  await page.waitForTimeout(1500);
  r = await readResult();
  H.check('Average anyway: one "Average Structure" row with the plain mean (Na x 0.2167, Cl2 y 0.3)',
    r.nRows === rowsBeforeHop + 1 && r.name === 'Average Structure' && r.selected && r.nChecked === 0
      && maxDiff(r.positions, HOP_MEAN) < 1e-9,
    `${JSON.stringify(r.positions)} vs ${JSON.stringify(HOP_MEAN)}`);

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
