// The hide/restore feature made every instance-indexed consumer read
// periodic.visibleWrapped, but only rebuildAtoms and the render fast path
// re-derived it. The MD/relax full path recomputed periodic.wrapped and then
// rendered from a stale .visibleWrapped, so atoms never moved on screen while
// the rest of the UI reacted normally. Assert the rendered instance matrices
// actually track a viewer state apply.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);

  const res = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { applyMDStateToViewer } = await import('./atomistic/MD.js');
    const { applyFrameFast } = await import('./render/FastFrameModule.js');
    const s = fileBrowser.selectedStructure;

    // instance translations (offsets 12/13/14 of each 4x4)
    const readTrans = () => {
      const m = groups.atomsMesh;
      if (!m) return null;
      const a = m.instanceMatrix.array;
      const out = [];
      for (let i = 0; i < m.count; i++) out.push([a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14]]);
      return out;
    };

    const L = s.lattice;
    const cart = s.atoms.map((at) => {
      const f = at.position;
      return [0, 1, 2].map((k) => f[0] * L[0][k] + f[1] * L[1][k] + f[2] * L[2][k]);
    });

    const before = readTrans();
    applyMDStateToViewer(
      { lattice: L.map((r) => [...r]), positions: cart.map((r) => [r[0] + 0.3, r[1], r[2]]) },
      s,
      {},
    );
    const after = readTrans();

    // Instance count may legitimately change (an atom crossing a cell face
    // changes the periodic-image set), so compare over the overlap.
    let maxDelta = 0;
    const overlap = Math.min(before?.length ?? 0, after?.length ?? 0);
    for (let i = 0; i < overlap; i++) {
      for (let k = 0; k < 3; k++) maxDelta = Math.max(maxDelta, Math.abs(after[i][k] - before[i][k]));
    }

    // Decisive check: the mesh is exactly what the (re-derived) wrapping says.
    const vis = s.periodic.visibleWrapped;
    let meshMatchesWrapped = !!after && after.length === vis.cart.length;
    for (let i = 0; meshMatchesWrapped && i < after.length; i++) {
      for (let k = 0; k < 3; k++) {
        if (Math.abs(after[i][k] - vis.cart[i][k]) > 1e-4) { meshMatchesWrapped = false; break; }
      }
    }

    // With the mesh and the wrapping back in sync, the fast path must engage
    // again on the next frame instead of falling back to a full rebuild forever.
    const fastPathEngages = applyFrameFast(s);

    return { maxDelta, meshMatchesWrapped, fastPathEngages, count: after?.length ?? -1 };
  });

  H.check('atom instances move on an MD state apply', res.maxDelta > 0.1, JSON.stringify(res));
  H.check('mesh instance count/positions match visibleWrapped', res.meshMatchesWrapped, JSON.stringify(res));
  H.check('render fast path engages after a full-path frame', res.fastPathEngages, JSON.stringify(res));
  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
