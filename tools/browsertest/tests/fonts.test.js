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
    const unicodeRangeContains = (unicodeRange, codepoint) => String(unicodeRange || '')
      .split(',')
      .some((part) => {
        const [startText, endText] = part.trim().replace(/^U\+/i, '').split('-');
        const start = Number.parseInt(startText, 16);
        const end = endText ? Number.parseInt(endText, 16) : start;
        return Number.isFinite(start) && Number.isFinite(end) && codepoint >= start && codepoint <= end;
      });
    const sansFaces = faces.filter((face) => familyName(face) === 'CrysViz Sans');
    const mathFaces = faces.filter((face) => familyName(face) === 'CrysViz Sans Math');
    const moonText = '\u{1F313}\uFE0E';
    const subsetRequests = [
      ['latin', "400 12px 'CrysViz Sans'", 'A'],
      ['latin-ext', "400 12px 'CrysViz Sans'", 'ł'],
      ['greek', "400 12px 'CrysViz Sans'", 'α'],
      ['greek-ext', "400 12px 'CrysViz Sans'", 'ἀ'],
      ['cyrillic', "400 12px 'CrysViz Sans'", 'я'],
      ['cyrillic-ext', "400 12px 'CrysViz Sans'", 'ѻ'],
      ['subsuper', "400 12px 'CrysViz Sans'", '₀'],
      ['symbols2', "400 12px 'CrysViz Sans'", '☰'],
      ['symbols1-extras-info', "400 12px 'CrysViz Sans'", 'ⓘ'],
      ['symbols1-extras-fullscreen', "400 12px 'CrysViz Sans'", '⛶'],
      ['emoji-extras', "400 12px 'CrysViz Sans'", moonText],
      ['subsuper-non-breaking-hyphen', "400 12px 'CrysViz Sans'", '\u2011'],
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
      'noto-sans-subsuper-wght-normal.woff2': '8d50798ea150d4b050e168d7726cb3e6df9714b685dd9c8083e16afac5de843d',
      'noto-sans-symbols2-400-normal.woff2': '9c07d511848c274b5430c75bf98d1f2582680ef5f967947bfbdd06b75ca177c2',
      'noto-sans-symbols1-extras-wght-normal.woff2': 'c4f46bc995694f86472b9dfc037632f2be5c7f90a17b09e1faafe83e091e95ed',
      'noto-emoji-extras-wght-normal.woff2': '1c3669eaded5308ac7ccffd9d8ee4e200c8f10a379ec4de484ddeffed85da781',
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

    const expectedNames = Object.keys(expectedHashes).sort();
    const fetchedNames = fetches.map(({ name }) => name);
    const fetchedNameSet = [...new Set(fetchedNames)].sort();
    const filenamesMatch = fontUrls.length === 11
      && fetchedNames.length === 11
      && fetchedNameSet.length === 11
      && JSON.stringify(fetchedNameSet) === JSON.stringify(expectedNames);

    const fileIconRequests = [
      ['folder', '📁', 0x1F4C1],
      ['open-folder', '📂', 0x1F4C2],
      ['inbox', '📥', 0x1F4E5],
    ];
    const fileIconCoverage = await Promise.all(fileIconRequests.map(async ([name, glyph, codepoint]) => {
      const loaded = await document.fonts.load("12px 'CrysViz Sans'", glyph);
      const loadedClaims = loaded
        .filter((face) => familyName(face) === 'CrysViz Sans' && unicodeRangeContains(face.unicodeRange, codepoint))
        .map((face) => face.unicodeRange);
      const allClaims = sansFaces
        .filter((face) => unicodeRangeContains(face.unicodeRange, codepoint))
        .map((face) => face.unicodeRange);
      return { name, loadedCount: loaded.length, loadedClaims, allClaims };
    }));

    await document.fonts.load("16px 'CrysViz Sans'", moonText);
    const moonCanvas = document.createElement('canvas');
    moonCanvas.width = 64;
    moonCanvas.height = 32;
    const moonContext = moonCanvas.getContext('2d');
    moonContext.font = "16px 'CrysViz Sans'";
    moonContext.fillStyle = '#ff0000';
    moonContext.fillText(moonText, 2, 20);
    const moonPixels = moonContext.getImageData(0, 0, moonCanvas.width, moonCanvas.height).data;
    let moonInkedPixels = 0;
    let moonNonFillPixels = 0;
    for (let index = 0; index < moonPixels.length; index += 4) {
      const [red, green, blue, alpha] = moonPixels.slice(index, index + 4);
      if (alpha > 8) {
        moonInkedPixels += 1;
        if (red < 240 || green > 15 || blue > 15) moonNonFillPixels += 1;
      }
    }

    return {
      sansCount: sansFaces.length,
      mathCount: mathFaces.length,
      faceStatuses: faces.map((face) => ({ family: face.family, status: face.status })),
      subsetLoads,
      fetches,
      filenamesMatch,
      expectedNames,
      fetchedNames,
      fileIconCoverage,
      moonCanvas: { inkedPixels: moonInkedPixels, nonFillPixels: moonNonFillPixels },
      hashesMatch: filenamesMatch && fetches.every(({ name, hash }) => expectedHashes[name] === hash),
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      uploadButtonFontFamily: getComputedStyle(document.getElementById('uploadButton')).fontFamily,
    };
  });

  H.check('CrysViz Sans has ten bundled faces', fontState.sansCount === 10, fontState.sansCount);
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
    'fetched font filenames match the expected set exactly once',
    fontState.filenamesMatch,
    JSON.stringify({ expected: fontState.expectedNames, fetched: fontState.fetchedNames }),
  );
  H.check(
    'each bundled woff2 fetch succeeds',
    fontState.fetches.length === 11
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
  H.check(
    'buttons start with the CrysViz Sans family',
    fontState.uploadButtonFontFamily.startsWith('"CrysViz Sans"'),
    fontState.uploadButtonFontFamily,
  );
  H.check(
    'file icons have no CrysViz Sans unicode-range claims',
    fontState.fileIconCoverage.every(({ loadedClaims, allClaims }) => loadedClaims.length === 0 && allClaims.length === 0),
    JSON.stringify(fontState.fileIconCoverage),
  );
  H.check(
    'moon glyph pixels use the requested fill color',
    fontState.moonCanvas.inkedPixels > 0 && fontState.moonCanvas.nonFillPixels === 0,
    JSON.stringify(fontState.moonCanvas),
  );
  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
