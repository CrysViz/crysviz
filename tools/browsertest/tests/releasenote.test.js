// Release note (docs/ui/ReleaseNote.js):
//   - "New: Search everything" shows on each visit, beside the sidebar's
//     search field, naming the shortcut
//   - Close hides it for this visit only: it is back after a reload
//   - Try it opens the search; opening the search with Ctrl+F closes the card
//   - "Don't show this again" is saved on closing and keeps it away after a
//     reload; an older dismissed note does not hide it, a later one does
'use strict';
const H = require('../harness');

async function note(page) {
  return page.evaluate(() => {
    const c = document.getElementById('releaseNote');
    const r = c?.getBoundingClientRect();
    const t = document.getElementById('featureSearchButton')?.getBoundingClientRect();
    return {
      open: !!c && !c.hidden,
      anchored: !!c && c.classList.contains('release-note-anchored'),
      beside: !!(r && t) && r.left >= t.right && Math.abs(r.top - t.top) < 80,
      text: (c?.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  });
}

async function reload(page) {
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(4000); // init + the card's settle delay
}

async function prefs(page) {
  return page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    const fs = await import('./ui/FeatureSearch.js');
    return { seen: pm.getPanelPref('releaseNoteSeen'), search: fs.isFeatureSearchOpen() };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // The harness dismisses every note for the rest of the suite.
  await page.evaluate(async () => {
    (await import('./ui/panels/PanelManager.js')).setPanelPref('releaseNoteSeen', '');
  });
  await reload(page);

  let n = await note(page);
  H.check('shown on a visit', n.open, JSON.stringify(n));
  H.check('...beside the sidebar search field', n.anchored && n.beside, JSON.stringify(n));
  H.check('...naming the search and its shortcut', /Search everything/.test(n.text) && /Ctrl\+F|⌘F/.test(n.text), n.text);

  await page.click('#releaseNoteClose');
  H.check('Close hides it', !(await note(page)).open);
  await reload(page);
  H.check('...for this visit only', (await note(page)).open);

  await page.click('#releaseNoteTry');
  await page.waitForTimeout(200);
  let p = await prefs(page);
  H.check('Try it opens the search and hides the card', p.search && !(await note(page)).open, JSON.stringify(p));
  H.check('...and saves nothing without the tick', p.seen === '', JSON.stringify(p));
  await page.keyboard.press('Escape');

  await reload(page);
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(800);
  p = await prefs(page);
  H.check('opening the search with Ctrl+F closes the card', p.search && !(await note(page)).open, JSON.stringify(p));
  await page.keyboard.press('Escape');

  await reload(page);
  await page.check('#releaseNoteDontShow');
  await page.click('#releaseNoteClose');
  p = await prefs(page);
  H.check('"Don\'t show this again" is saved on closing', /^\d{4}-\d{2}-\d{2}-/.test(p.seen), JSON.stringify(p));
  await reload(page);
  H.check('...and keeps the card away after a reload', !(await note(page)).open);

  const order = await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    const rn = await import('./ui/ReleaseNote.js');
    pm.setPanelPref('releaseNoteSeen', '2000-01-01-older');
    const older = rn.isReleaseNoteDismissed();
    pm.setPanelPref('releaseNoteSeen', '9999-12-31-later');
    const later = rn.isReleaseNoteDismissed();
    return { older, later };
  });
  H.check('an older dismissed note does not hide it, a later one does', !order.older && order.later, JSON.stringify(order));

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
