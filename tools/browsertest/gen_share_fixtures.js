// Regenerates the share-codec fixtures and the fresh-boot settings baseline.
// Not a test (no .test.js suffix, so `make browsertest` never runs it):
//   tools/browsertest/run.sh gen_share_fixtures.js
// Writes tools/unittest/fixtures/share/*.json. Each fixture is
// { state: captureState(), supercell: structure.supercell|null }.
// baseline.json is the settings part of captureState() of a freshly booted
// app, which is what docs/io/share/shareBaselines.js freezes as baseline 1.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const OUT = path.join(__dirname, '..', 'unittest', 'fixtures', 'share');
const ROOT = path.join(__dirname, '..', '..');

async function capture(page) {
  return page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const sc = fileBrowser.selectedStructure?.supercell;
    const supercell = sc && sc.nx ? { nx: sc.nx, ny: sc.ny, nz: sc.nz } : null;
    return { state: captureState(), supercell };
  });
}

async function load(page, text, name) {
  await page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, name);
  }, { text, name });
  await page.waitForTimeout(2500);
}

function write(name, data) {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data));
  console.log(`  [fixture] ${name}: ${data.state ? data.state.structure.positions.length + ' atoms' : 'baseline'}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { browser, page, errors } = await H.launchApp();

  // Fresh boot: the default structure the app loads on its own.
  const boot = await capture(page);
  const { colors, display, style } = boot.state;
  fs.writeFileSync(path.join(OUT, 'baseline.json'), JSON.stringify({ colors, display, style }, null, 1));
  write('boot', boot);

  const defaults = ['defaultPOSCAR2', 'defaultPOSCAR3', 'defaultPOSCAR4', 'defaultPOSCAR5'];
  for (const d of defaults) {
    await page.evaluate(async (d) => {
      const cv = await import('./core/crystal-viewer.js');
      const m = await import('./defaults/structure_defaults.js');
      await cv.loadStructure(m[d], d);
    }, d);
    await page.waitForTimeout(2500);
    write(`default-${d.replace('defaultPOSCAR', 'poscar')}`, await capture(page));
  }

  const nacl = `NaCl
1.0
 5.64 0 0
 0 5.64 0
 0 0 5.64
Na Cl
4 4
Direct
0 0 0
0 0.5 0.5
0.5 0 0.5
0.5 0.5 0
0.5 0 0
0 0.5 0
0 0 0.5
0.5 0.5 0.5`;
  await load(page, nacl, 'NaCl');
  write('nacl', await capture(page));

  // Styled state, set through the real model/store APIs and formats.
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const m = await import('./defaults/structure_defaults.js');
    await cv.loadStructure(m.defaultPOSCAR, 'YBCO-styled');
  });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { general, fileBrowser, app } = await import('./state/store.js');
    const { addDistanceMeasurement, addAngleMeasurement } = await import('./render/MeasurementModule.js');
    const s = fileBrowser.selectedStructure;
    for (const i of [0, 1, 2]) s.atoms[i].color = 0xff0000;
    s.atoms[5].color = 0x00ff00;
    s.atoms[7].setOpacity(0.4); s.atoms[8].setOpacity(0.4);
    s.atoms[3].setRadiusScale(1.5);
    // Present pairs only; general.bondLengths also still holds the boot
    // structure's pairs, which the codec must filter out.
    general.bondLengths['Cu-O'] = { min: 0.2, max: 2.75 };
    general.bondVisibility['Ba-O'] = false;
    general.renderStyle = 'cel';
    general.atomSize = 0.8;
    general.showPolyhedra = true;
    const w = s.periodic.visibleWrapped;
    const proxy = (i) => ({ position: new THREE.Vector3(...w.cart[i]),
      userData: { atomIndex: w.srcIndex ? w.srcIndex[i] : i, element: w.elements[i], instanceId: i, wrappedFrac: w.frac?.[i] ? [...w.frac[i]] : null } });
    addDistanceMeasurement(proxy(0), proxy(4));
    addAngleMeasurement(proxy(1), proxy(4), proxy(6));
    app.camera.position.set(9, -7, 12);
    app.camera.up.set(0.1, 0.9, 0.3).normalize();
    app.camera.lookAt(app.controls.target);
    app.camera.updateMatrixWorld();
  });
  write('ybco-styled', await capture(page));

  // 2x2x2 supercell with per-atom colours on image atoms.
  await load(page, nacl, 'NaCl-super');
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { fileBrowser } = await import('./state/store.js');
    createSupercell(2, 2, 2);
    const s = fileBrowser.selectedStructure;
    s.atoms[0].color = 0x123456; s.atoms[13].color = 0x654321; s.atoms[40].color = 0x123456;
  });
  await page.waitForTimeout(2500);
  write('nacl-supercell-222', await capture(page));

  const big = path.join(ROOT, 'wav_data', 'CONTCAR');
  if (fs.existsSync(big)) {
    await load(page, fs.readFileSync(big, 'utf8'), 'SiCN');
    await page.waitForTimeout(6000);
    write('sicn-575', await capture(page));
  } else {
    console.log('  [skip] wav_data/CONTCAR missing; large fixture not regenerated');
  }

  console.log('  errors:', errors.length ? errors.slice(0, 3).join(' | ') : 'none');
  await browser.close();
  process.exit(0);
})().catch(H.crash);
