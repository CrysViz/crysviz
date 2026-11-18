// Structure Info rows of a mixed site (CompositionRow.js): one dot per species,
// then the "(Fe,K,Ni,Ta)" label. With four dots the label used to run under
// the Spin/Force button: the grid gave the left column its one-line width and
// left the right column 31px, so the right-aligned button hung over the label.
// Now the right column keeps its wrapped width, the toggle has its own slot,
// the dots stay on one line after it, and with more than three species the
// label sits on its own line under the dots (wrapping at commas, balanced).
'use strict';
const H = require('../harness');

async function rowFor(page, species) {
  await page.evaluate(async (species) => {
    const { fileBrowser } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    const i = s.atoms.findIndex((a, k) => s.elements[k] === 'Ba');
    s.atoms[i].species = species.map((el) => ({ element: el, occupancy: 1 / species.length, color: null }));
    cv.updateVisualization({ reRenderAtoms: true, reRenderComposition: true });
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
  }, species);
  await page.waitForTimeout(600);
  return page.evaluate((label) => {
    const row = [...document.querySelectorAll('#atomPanel .comp-row')]
      .find((r) => r.querySelector('.comp-row-name')?.textContent === label);
    if (!row) return null;
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left, r: b.right, t: b.top, b: b.bottom };
    };
    const dots = [...row.querySelectorAll('.comp-mixed-dot')].map(box);
    return {
      name: box(row.querySelector('.comp-row-name')),
      toggle: box(row.querySelector('.comp-left > *')),
      button: box(row.querySelector('.spin-force-category-button')),
      count: box(row.querySelector('.comp-count-label')),
      dots,
      text: row.querySelector('.comp-row-name').textContent,
    };
  }, `(${[...species].sort().join(',')})`);
}

const overlaps = (x, y) => x.l < y.r && y.l < x.r && x.t < y.b && y.t < x.b;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  for (const species of [['Fe', 'K', 'Ni', 'Ta'], ['Fe', 'K', 'Ni', 'Ta', 'Mn', 'Co']]) {
    const n = species.length;
    const m = await rowFor(page, species);
    H.check(`${n} species: the row exists with the plain label`, !!m && m.text === `(${[...species].sort().join(',')})`, JSON.stringify(m?.text));
    if (!m) continue;
    H.check(`${n} species: the label stays clear of Spin/Force and the count`,
      !overlaps(m.name, m.button) && !overlaps(m.name, m.count), JSON.stringify({ name: m.name, button: m.button, count: m.count }));
    H.check(`${n} species: all ${n} dots on one line`,
      m.dots.length === n && m.dots.every((d) => Math.abs(d.t - m.dots[0].t) < 1), JSON.stringify(m.dots.map((d) => d.t)));
    H.check(`${n} species: the label sits under the dots and starts after the toggle`,
      m.name.t >= Math.max(...m.dots.map((d) => d.b)) - 1 && m.name.l >= m.toggle.r, JSON.stringify({ name: m.name, toggle: m.toggle }));
  }

  // Three two-letter species (a reported case): the label no longer fits
  // beside the dots and must move under them, clear of Spin/Force.
  const three = await rowFor(page, ['Hf', 'Ta', 'Zr']);
  H.check('3 two-letter species: label under the dots, clear of Spin/Force and the count',
    !!three && !overlaps(three.name, three.button) && !overlaps(three.name, three.count)
      && three.name.l >= three.toggle.r,
    JSON.stringify(three && { name: three.name, button: three.button, count: three.count }));

  // Two species: the label stays beside the dots when it fits.
  const two = await rowFor(page, ['Fe', 'K']);
  H.check('2 species: the label is not forced under the dots',
    !!two && two.name.t < Math.max(...two.dots.map((d) => d.b)), JSON.stringify(two && { name: two.name, dots: two.dots }));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
