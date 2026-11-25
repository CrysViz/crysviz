// The errors read from a CIF travel in a share link: the real link path, from
// the Share dialog's URL to a fresh page opening it — the #z= link, its QR
// form (#q=), a password-protected link, and a supercell's link with Show CIF
// Errors off. ciferrors.test.js hands captureState() straight to
// applySharedState(), which skips the compact codec; the codec used to drop
// the errors (docs/io/share/shareCodec.js encodeCifErrors).
'use strict';
const H = require('../harness');

// P-1 in a 5 Å cubic cell (as in ciferrors.test.js): C1 0.1234 from the
// inversion centre, so C1 and its inversion image are 1.234 Å apart.
const PM1_CIF = [
  'data_pm1',
  "_symmetry_space_group_name_H-M   'P -1'",
  '_space_group_IT_number   2',
  '_cell_length_a   5.000(2)',
  '_cell_length_b   5.000(2)',
  '_cell_length_c   5.000(2)',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   90',
  'loop_',
  '_space_group_symop_operation_xyz',
  '  x,y,z',
  '  -x,-y,-z',
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'C1 C 0.6234(5) 0.5 0.5',
  'H1 H 0.80(1) 0.65(1) 0.5',
  '',
].join('\n');
// C1 to its inversion image: d = 2(x − ½)a, σ² = (2aσx)² + (2(x − ½)σa)².
const CC_SU = Math.hypot(2 * 5 * 0.0005, 2 * (0.6234 - 0.5) * 0.002);
const CC_LABEL = '1.234(5) Å';
const ANGLE_LABEL = '140(2)°';

/** The structure on screen: each atom's element, position and CIF site, the
 *  measurement labels, the Show CIF Errors switch, and the s.u. of C1–C1' in
 *  every copy of the cell along a. */
const SUMMARY = async () => {
  const { fileBrowser, measurements, general } = await import('./state/store.js');
  const ce = await import('./model/cifErrors.js');
  const s = fileBrowser.selectedStructure;
  const n = s.cifErrors?.toCif?.[0]?.[0] ?? 1;
  const find = (x) => s.atoms.findIndex((a) => Math.abs(a.position[0] - x) < 1e-4 && Math.abs(a.position[1] - 0.5) < 1e-4);
  const pairs = [];
  for (let k = 0; k < n; k++) {
    const i = find((k + 0.6234) / n), j = find((k + 0.3766) / n);
    pairs.push(i < 0 || j < 0 ? null
      : ce.distanceSu(s, { atomIndex: i, frac: s.atoms[i].position }, { atomIndex: j, frac: s.atoms[j].position }));
  }
  return {
    read: ce.hasCifErrors(s),
    atoms: s.atoms.map((a, i) => [s.elements[i], ...a.position.map((v) => v.toFixed(4)),
      a.cifSite ? s.cifErrors.sites[a.cifSite.site].label : null, a.cifSite ? a.cifSite.R.flat().join('') : null].join(' ')),
    labels: measurements.measureLabels.map((l) => l.userData.labelText),
    showErrors: general.showCifErrors,
    toggle: document.getElementById('showCifErrorsToggle')?.checked ?? null,
    pairs,
  };
};

async function summary(page) {
  return page.evaluate(async (fn) => (new Function(`return ${fn}`)())(), SUMMARY.toString());
}

/** Share the current view; returns the copy link and what its payload carries. */
async function share(page, password = null) {
  const plain = await page.evaluate(async () => {
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    return document.getElementById('shareLinkUrl').value;
  });
  let url = plain;
  if (password) {
    await page.fill('#shareLinkPassword', password);
    await page.waitForFunction((p) => document.getElementById('shareLinkUrl').value !== p, plain, { timeout: 30000 });
    url = await page.evaluate(() => document.getElementById('shareLinkUrl').value);
  }
  const payload = await page.evaluate(async ({ plain }) => {
    const env = await import('./io/share/shareEnvelope.js');
    const opened = await env.openEnvelope(env.b64URLToBytes(plain.split('#z=')[1]));
    const obj = JSON.parse(new TextDecoder().decode(opened.json));
    document.getElementById('shareLinkClose').click();
    return { er: obj.er ?? null, supercell: obj.s?.x ?? null, showErrors: obj.o?.ce };
  }, { plain });
  return { url, plain, ...payload };
}

/** Open `url` in the page as a recipient would (via about:blank: a link that
 *  differs only in the fragment would not reload). */
async function open(page, url, password = null) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load' });
  if (password) {
    await page.waitForSelector('#sharePasswordModal:not([hidden])', { timeout: 40000 });
    await page.fill('#sharePwInput', password);
    await page.click('#sharePwOpen');
  }
  return H.waitFor(page, async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    return general.sharedStructureLoaded === true && (fileBrowser.selectedStructure?.atoms?.length ?? 0) > 0;
  }, { timeout: 60000, interval: 1000 });
}

const sameSu = (v) => v != null && Math.abs(v - CC_SU) < 1e-6;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // The QR encoder comes from a CDN (ui/ShareLinkModal.js); a stub keeps the
  // run off the network. The QR's own URL (#q=) is rebuilt below.
  await page.route((url) => url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('nayuki-qr-code-generator'),
    (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default null;' }));

  // --- The CIF, its errors read, two measurements ---------------------------
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    window.__cifLoad = cv.loadStructure(text, 'pm1.cif');
  }, PM1_CIF);
  // The modal is built on first use: wait for it to exist, not just "not hidden".
  await page.waitForFunction(() => {
    const m = document.getElementById('cifSymmetryModal');
    return !!m && !m.hidden;
  }, null, { timeout: 30000 });
  await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors'));
    if (!box.checked) box.click();
    [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')]
      .find((b) => /Load as a normal structure/.test(b.textContent || '')).click();
  });
  await page.evaluate(async () => { await window.__cifLoad; });
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { fileBrowser } = await import('./state/store.js');
    const { addDistanceMeasurement, addAngleMeasurement, clearAllMeasurements } = await import('./render/MeasurementModule.js');
    clearAllMeasurements();
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const find = (x, y) => {
      const i = w.frac.findIndex((f) => Math.abs(f[0] - x) < 1e-3 && Math.abs(f[1] - y) < 1e-3 && Math.abs(f[2] - 0.5) < 1e-3);
      return { position: new THREE.Vector3(...w.cart[i]),
        userData: { atomIndex: w.srcIndex ? w.srcIndex[i] : i, element: w.elements[i], wrappedFrac: [...w.frac[i]] } };
    };
    const c1 = find(0.6234, 0.5), c2 = find(0.3766, 0.5), h1 = find(0.8, 0.65);
    addDistanceMeasurement(c1, c2);
    addAngleMeasurement(h1, c1, c2);
  });
  const before = await summary(page);
  H.check('the CIF is read with its errors and the measurements show them',
    before.read && before.atoms.length === 4 && before.atoms.every((a) => !/null/.test(a))
      && before.labels[0] === CC_LABEL && before.labels[1] === ANGLE_LABEL, JSON.stringify(before));

  // --- #z= link ---------------------------------------------------------------
  const link = await share(page);
  console.log(`  [info] link ${link.url.length} characters, errors block ${JSON.stringify(link.er).length} characters of JSON`);
  H.check('the link carries the errors', !!link.er && /#z=[A-Za-z0-9_-]+$/.test(link.url), JSON.stringify(link.er));
  await open(page, link.url);
  const fromLink = await summary(page);
  H.check('opening the link brings the errors back on the same atoms',
    fromLink.read && JSON.stringify(fromLink.atoms) === JSON.stringify(before.atoms), JSON.stringify(fromLink.atoms));
  H.check('…and the restored measurements show them', fromLink.labels[0] === CC_LABEL && fromLink.labels[1] === ANGLE_LABEL,
    JSON.stringify(fromLink.labels));

  // --- #q= (the QR code's form of the same envelope) ---------------------------
  const qURL = await page.evaluate(async (url) => {
    const env = await import('./io/share/shareEnvelope.js');
    const [base, z] = url.split('#z=');
    return `${base}#q=${env.bytesToBase32(env.b64URLToBytes(z))}`;
  }, link.url);
  await open(page, qURL);
  const fromQR = await summary(page);
  H.check('the QR link (#q=) brings them back too',
    fromQR.read && JSON.stringify(fromQR.atoms) === JSON.stringify(before.atoms) && fromQR.labels[0] === CC_LABEL,
    JSON.stringify(fromQR));

  // --- a password-protected link ------------------------------------------------
  const locked = await share(page, 'hunter2');
  H.check('the password link is encrypted', locked.url !== locked.plain && /#z=/.test(locked.url), locked.url.slice(0, 60));
  await open(page, locked.url, 'hunter2');
  const fromLocked = await summary(page);
  H.check('the password link brings them back too',
    fromLocked.read && JSON.stringify(fromLocked.atoms) === JSON.stringify(before.atoms) && fromLocked.labels[0] === CC_LABEL,
    JSON.stringify(fromLocked));

  // --- a supercell, with Show CIF Errors off ------------------------------------
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    createSupercell(2, 1, 1);
    document.getElementById('showCifErrorsToggle').click();
  });
  await page.waitForTimeout(300);
  const superBefore = await summary(page);
  H.check('the supercell keeps them in both copies, and the switch is off',
    superBefore.read && superBefore.atoms.length === 8 && superBefore.pairs.every(sameSu) && superBefore.showErrors === false,
    JSON.stringify(superBefore));
  const superLink = await share(page);
  H.check('the supercell link tiles its base cell and lists the base cell\'s errors once',
    JSON.stringify(superLink.supercell) === '[2,1,1]' && superLink.er?.a?.length === 4 && superLink.showErrors === false,
    JSON.stringify({ supercell: superLink.supercell, a: superLink.er?.a, ce: superLink.showErrors }));
  await open(page, superLink.url);
  const fromSuper = await summary(page);
  H.check('opening it brings the errors back on the same atoms of every copy',
    fromSuper.read && JSON.stringify(fromSuper.atoms) === JSON.stringify(superBefore.atoms) && fromSuper.pairs.every(sameSu),
    JSON.stringify(fromSuper));
  H.check('…and Show CIF Errors stays off', fromSuper.showErrors === false && fromSuper.toggle === false,
    JSON.stringify({ showErrors: fromSuper.showErrors, toggle: fromSuper.toggle }));

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
