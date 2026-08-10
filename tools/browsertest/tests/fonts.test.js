// Self-hosted CrysViz Sans faces are available to CSS and canvas text,
// including every bundled unicode subset and the separately bundled math face.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts];
    const familyName = (face) => face.family.replace(/^['"]|['"]$/g, '');
    const sansFaces = faces.filter((face) => familyName(face) === 'CrysViz Sans');
    const mathFaces = faces.filter((face) => familyName(face) === 'CrysViz Sans Math');
    const subsetRequests = [
      ['latin', "400 12px 'CrysViz Sans'", 'A'],
      ['latin-ext', "400 12px 'CrysViz Sans'", 'ł'],
      ['greek', "400 12px 'CrysViz Sans'", 'α'],
      ['greek-ext', "400 12px 'CrysViz Sans'", 'ἀ'],
      ['cyrillic', "400 12px 'CrysViz Sans'", 'я'],
      ['cyrillic-ext', "400 12px 'CrysViz Sans'", 'ѻ'],
      ['subsuper', "400 12px 'CrysViz Sans'", '₀'],
      ['math', "400 12px 'CrysViz Sans Math'", '∫'],
    ];
    const subsetLoads = await Promise.all(subsetRequests.map(async ([name, descriptor, glyph]) => {
      const loaded = await document.fonts.load(descriptor, glyph);
      return { name, count: loaded.length, statuses: loaded.map((face) => face.status) };
    }));

    const cssUrl = new URL('./styles/fonts.css', location.href);
    const cssText = await (await fetch(cssUrl)).text();
    const fontUrls = [...cssText.matchAll(/url\(([^)]+\.woff2)\)/g)]
      .map((match) => new URL(match[1], cssUrl).href);
    // Hashes pin the cmap-verified binaries; recompute + update when fonts are intentionally upgraded (see docs/fonts/README.md).
    const expectedHashes = {
      'noto-sans-latin-wght-normal.woff2': '51ca196f49a33e79e7870ff88ebd2829a3f627a51e7d690986618f0e7ad2b52d',
      'noto-sans-latin-ext-wght-normal.woff2': '6d5a79315528df191b9d86f97b0c4272a8b588fcb166773fe6588ac795de0613',
      'noto-sans-greek-wght-normal.woff2': '7f655207c2f6c140c327d6bd263bccc7a11833084f4fb0c51d9a24b7cd753651',
      'noto-sans-greek-ext-wght-normal.woff2': '790b255c10c32e0b10bdcd961abad098c9697b7ffbabc1b09aca0b17af3201fd',
      'noto-sans-cyrillic-wght-normal.woff2': '6ab64433de6077ca5ad31b05420450ce986a616a4ea47b6ad16f3217055dafc3',
      'noto-sans-cyrillic-ext-wght-normal.woff2': '82ff72b28e6610f2c62de49d0f295c160a157b2718fa814bb6c512ebfdebb31d',
      'noto-sans-subsuper-wght-normal.woff2': '63339f90d3c0016190e29fcdf40250a6f940cca886a63c96c46effb22dc818de',
      'noto-sans-math-400-normal.woff2': 'c39a9444f95747345dcbde1032ec0ea2af1db63dccf53a31b38a957bdcf4a01f',
    };
    const fetches = await Promise.all(fontUrls.map(async (url) => {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const name = url.split('/').pop();
      return { name, url, status: response.status, bytes: buffer.byteLength, hash };
    }));

    return {
      sansCount: sansFaces.length,
      mathCount: mathFaces.length,
      faceStatuses: faces.map((face) => ({ family: face.family, status: face.status })),
      subsetLoads,
      fetches,
      hashesMatch: fontUrls.length === 8 && fetches.every(({ name, hash }) => expectedHashes[name] === hash),
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
    };
  });

  H.check('CrysViz Sans has seven bundled faces', fontState.sansCount === 7, fontState.sansCount);
  H.check('CrysViz Sans Math has one bundled face', fontState.mathCount === 1, fontState.mathCount);
  H.check(
    'all enumerated CrysViz faces are loaded',
    fontState.faceStatuses.every(({ status }) => status === 'loaded'),
    JSON.stringify(fontState.faceStatuses),
  );
  H.check(
    'each subset glyph load returns a loaded face',
    fontState.subsetLoads.every(({ count, statuses }) => count > 0 && statuses.every((status) => status === 'loaded')),
    JSON.stringify(fontState.subsetLoads),
  );
  H.check(
    'each bundled woff2 fetch succeeds',
    fontState.fetches.length === 8
      && fontState.hashesMatch
      && fontState.fetches.every(({ name, status, bytes, hash }) => (
        name && status === 200 && bytes > 1000 && hash
      )),
    JSON.stringify(fontState.fetches),
  );
  H.check(
    'body starts with the CrysViz Sans family',
    fontState.bodyFontFamily.startsWith('"CrysViz Sans"'),
    fontState.bodyFontFamily,
  );
  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
