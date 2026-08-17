'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const result = await page.evaluate(async () => {
    const { downloadBlob } = await import('./ui/SavePanel.js');
    const revoked = [];
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let objectUrl = null;
    URL.revokeObjectURL = (url) => revoked.push(url);
    HTMLAnchorElement.prototype.click = function () {
      objectUrl = this.href;
    };

    let fetchOk = false;
    let content = '';
    try {
      downloadBlob('t.png', new Blob(['x']));
      const response = await fetch(objectUrl);
      content = await response.text();
      fetchOk = response.ok;
    } finally {
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }
    return { revokedCount: revoked.length, fetchOk, content };
  });

  H.check('downloadBlob does not revoke synchronously', result.revokedCount === 0,
    JSON.stringify(result));
  H.check('downloadBlob leaves the object URL resolvable',
    result.fetchOk && result.content === 'x', JSON.stringify(result));
  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
