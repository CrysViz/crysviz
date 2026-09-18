// A failed structure load surfaces the general "could not be loaded" warning
// modal (LoadErrorModal), fired from the single catch in loadStructure so it
// covers every format. Uses a .cell with fractional positions but no lattice —
// which the reader rejects — as the broken input.
'use strict';
const H = require('../harness');

// POSITIONS_FRAC with no LATTICE block: fractional coords are meaningless
// without a cell, so the CASTEP reader rejects it.
const BROKEN = [
  '%BLOCK POSITIONS_FRAC',
  '  Na 0.0 0.0 0.0',
  '%ENDBLOCK POSITIONS_FRAC',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // a good structure is present first

  const res = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    let threw = false;
    try { await cv.loadStructure(text, 'broken.cell'); } catch { threw = true; }
    const modal = document.getElementById('loadErrorModal');
    const msg = document.getElementById('loadErrorMessage');
    const detail = document.getElementById('loadErrorDetail');
    return {
      threw,
      modalVisible: !!modal && !modal.hidden,
      msg: msg ? msg.textContent : '',
      detail: detail ? detail.textContent : '',
      detailShown: detail ? !detail.hidden : false,
    };
  }, BROKEN);

  H.check('load rejected', res.threw, JSON.stringify(res.threw));
  H.check('warning modal is shown', res.modalVisible, JSON.stringify(res));
  H.check('modal names the file', /broken\.cell/.test(res.msg), res.msg);
  H.check('modal shows the technical reason', res.detailShown && /lattice/i.test(res.detail), res.detail);

  // OK dismisses it.
  const closed = await page.evaluate(() => {
    document.getElementById('loadErrorOk').click();
    return document.getElementById('loadErrorModal').hidden;
  });
  H.check('OK closes the modal', closed === true, String(closed));

  // The only captured console error should be the intentional load failure —
  // nothing else broke while showing the modal.
  const unexpected = errors.filter((e) => !/broken\.cell|lattice|No atoms|structure/i.test(e));
  H.check('no unexpected console/page errors', unexpected.length === 0, unexpected[0] || '');
  await H.finish(browser);
})().catch(H.crash);
