// render/bondMatrix.js writes bond half-cylinder instance matrices directly
// instead of through an Object3D + setFromUnitVectors + updateMatrix +
// setMatrixAt round trip (most of the per-frame bond cost at tens of
// thousands of bonds). It must produce the same matrices: compared here
// against three.js itself for random directions, both poles (±y, where
// setFromUnitVectors takes its special branch), a zero direction and the
// hidden (zero-scale) half.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page } = await H.launchApp();
  const r = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { writeBondHalfMatrix, writeBondPairMatrices, writeHiddenBondHalf } = await import('./render/bondMatrix.js');
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const ref = new Float32Array(16);
    const got = new Float32Array(16);
    const got2 = new Float32Array(16);
    const pair = new Float32Array(32);
    let pairDiff = 0;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const cases = [[0, 1, 0], [0, -1, 0], [0, 0, 0], [1e-12, -1, 0], [0, 2.5, 0], [3, 0, 0]];
    for (let k = 0; k < 2000; k++) cases.push([rnd(), rnd(), rnd()]);
    let maxDiff = 0; let worst = null;
    for (const [dx, dy, dz] of cases) {
      const c = [rnd() * 20, rnd() * 20, rnd() * 20];
      const radius = 0.1 + Math.abs(rnd());
      const halfLen = Math.abs(rnd()) * 3;
      dir.set(dx, dy, dz).normalize();
      dummy.position.set(c[0], c[1], c[2]);
      dummy.scale.set(radius, halfLen, radius);
      dummy.quaternion.setFromUnitVectors(up, dir);
      dummy.updateMatrix();
      dummy.matrix.toArray(ref, 0);
      writeBondHalfMatrix(got, 0, c[0], c[1], c[2], dx, dy, dz, radius, halfLen);
      for (let i = 0; i < 16; i++) {
        const d = Math.abs(ref[i] - got[i]);
        if (d > maxDiff) { maxDiff = d; worst = [dx, dy, dz, i, ref[i], got[i]]; }
      }
      // The paired writer: both halves (second centre shifted) from one rotation.
      writeBondPairMatrices(pair, 0, c[0], c[1], c[2], c[0] + 1, c[1] - 2, c[2] + 3, dx, dy, dz, radius, halfLen);
      writeBondHalfMatrix(got2, 0, c[0] + 1, c[1] - 2, c[2] + 3, dx, dy, dz, radius, halfLen);
      for (let i = 0; i < 16; i++) {
        if (pair[i] !== got[i] || pair[16 + i] !== got2[i]) pairDiff++;
      }
    }
    dummy.position.set(0, 0, 0); dummy.scale.set(0, 0, 0); dummy.quaternion.set(0, 0, 0, 1);
    dummy.updateMatrix(); dummy.matrix.toArray(ref, 0);
    got.fill(9); writeHiddenBondHalf(got, 0);
    const hiddenSame = ref.every((v, i) => v === got[i]);
    return { n: cases.length, maxDiff, worst, hiddenSame, pairDiff };
  });
  H.check(`bond half matrices match three.js bit for bit (${r.n} directions incl. ±y and zero)`,
    r.maxDiff === 0, JSON.stringify(r));
  H.check('the hidden half matches the zero-scale dummy matrix', r.hiddenSame, JSON.stringify(r));
  H.check('the paired writer gives exactly the two half matrices', r.pairDiff === 0, JSON.stringify(r));
  await H.finish(browser);
})();
