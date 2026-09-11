// Paste Text recognises OPTIMADE structure URLs and Alexandria IDs, fetches
// JSON:API structure data, and feeds a converted structure through the normal
// loader. Network responses are mocked so this regression test is deterministic.
'use strict';
const H = require('../harness');

const optimadePayload = {
  data: {
    type: 'structures',
    id: 'agm000999956',
    attributes: {
      chemical_formula_reduced: 'Si',
      lattice_vectors: [[5, 0, 0], [0, 5, 0], [0, 0, 5]],
      cartesian_site_positions: [[0, 0, 0], [2.5, 2.5, 2.5]],
      species_at_sites: ['Si', 'Si'],
      species: [{ name: 'Si', chemical_symbols: ['Si'], concentration: [1] }],
    },
  },
  meta: { api_version: '1.1.0', data_returned: 1 },
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const inputCopy = await page.evaluate(() => {
    document.getElementById('pasteTextButton').click();
    return document.getElementById('structureText').getAttribute('placeholder');
  });
  H.check('paste prompt advertises supported remote inputs',
    inputCopy.includes('OPTIMADE') && inputCopy.includes('Alexandria') && !inputCopy.includes('Materials Project'),
    inputCopy);
  await page.click('#cancelTextButton');

  const normalizedIds = await page.evaluate(async () => {
    const { normalizeAlexandriaId } = await import('./io/OptimadeModule.js');
    return [
      normalizeAlexandriaId('agm000999956'),
      normalizeAlexandriaId('AGM-999956'),
      normalizeAlexandriaId('agm_999956'),
      normalizeAlexandriaId('mp-149'),
    ];
  });
  H.check('Alexandria ID spellings canonicalize and MP IDs do not',
    JSON.stringify(normalizedIds) === JSON.stringify([
      'agm000999956', 'agm000999956', 'agm000999956', null,
    ]), JSON.stringify(normalizedIds));

  const requested = [];
  await page.route('https://provider.example/**', async (route) => {
    requested.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.api+json',
      body: JSON.stringify(optimadePayload),
    });
  });
  await page.route('https://alexandria.icams.rub.de/**', async (route) => {
    requested.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.api+json',
      body: JSON.stringify(optimadePayload),
    });
  });

  async function paste(value, expectedRows) {
    await page.click('#pasteTextButton');
    await page.fill('#structureText', value);
    await page.click('#loadTextButton');
    await page.evaluate((count) => { window.__expectedOptimadeRows = count; }, expectedRows);
    return H.waitFor(page, async () => {
      const { fileBrowser } = await import('./state/store.js');
      if (fileBrowser.fileData.length !== window.__expectedOptimadeRows) return null;
      return {
        name: fileBrowser.fileData.at(-1).name,
        atomCount: fileBrowser.selectedStructure?.atoms?.length,
        elements: fileBrowser.selectedStructure?.elements,
        positions: fileBrowser.selectedStructure?.atoms?.map((atom) => atom.position),
      };
    }, { timeout: 10000, interval: 100 });
  }

  const fromUrl = await paste('https://provider.example/v1/structures/example-1', 2);
  H.check('OPTIMADE URL is fetched', requested[0] === 'https://provider.example/v1/structures/example-1', requested[0]);
  H.check('OPTIMADE URL loads two Si sites', fromUrl?.atomCount === 2 && fromUrl.elements.every(x => x === 'Si'), JSON.stringify(fromUrl));
  H.check('Cartesian sites become fractional sites', fromUrl?.positions[1].every(x => Math.abs(x - 0.5) < 1e-10), JSON.stringify(fromUrl?.positions));

  const fromId = await paste('agm-999956', 3);
  H.check('Alexandria ID is canonicalized in request', requested[1]?.endsWith('/agm000999956'), requested[1]);
  H.check('Alexandria ID loads through normal parser', fromId?.name === 'agm000999956.poscar' && fromId.atomCount === 2, JSON.stringify(fromId));

  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).includes('blocked.example')
      ? Promise.reject(new TypeError('NetworkError when attempting to fetch resource.'))
      : nativeFetch(input, init);
  });
  await page.click('#pasteTextButton');
  await page.fill('#structureText', 'https://blocked.example/v1/structures/example-2');
  await page.click('#loadTextButton');
  const laptopDialog = await H.waitFor(page, () => {
    const dialog = document.getElementById('optimadeWarningDialog');
    if (!dialog?.open) return null;
    const rect = dialog.getBoundingClientRect();
    return {
      text: dialog.textContent.replace(/\s+/g, ' ').trim(),
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    };
  }, { timeout: 2000, interval: 50 });
  H.check('blocked OPTIMADE request shows centered warning dialog',
    laptopDialog?.text.includes("provider's CORS policy blocks browser access")
      && Math.abs(laptopDialog.centerX - 700) < 2
      && Math.abs(laptopDialog.centerY - 450) < 2,
    JSON.stringify(laptopDialog));
  await page.waitForTimeout(5100);
  H.check('warning dialog closes itself after five seconds',
    await page.evaluate(() => !document.getElementById('optimadeWarningDialog').open));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.getElementById('pasteTextButton').click());
  await page.fill('#structureText', 'https://blocked.example/v1/structures/example-3');
  await page.click('#loadTextButton');
  const phoneDialog = await H.waitFor(page, () => {
    const dialog = document.getElementById('optimadeWarningDialog');
    if (!dialog?.open) return null;
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 };
  }, { timeout: 2000, interval: 50 });
  H.check('warning dialog fits and centers on a phone',
    phoneDialog?.left >= 15 && phoneDialog.right <= 375
      && Math.abs(phoneDialog.centerY - 422) < 2,
    JSON.stringify(phoneDialog));
  await page.click('#optimadeWarningClose');
  H.check('OK closes the warning immediately',
    await page.evaluate(() => !document.getElementById('optimadeWarningDialog').open));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
