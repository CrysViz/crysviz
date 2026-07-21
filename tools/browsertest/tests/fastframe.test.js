// The MD/relax render fast path (render/FastFrameModule.js) must actually be
// taken, and must place every atom exactly where the full rebuild would.
//
// It used to re-derive the periodic wrapping every frame and bail whenever the
// ghost-image set changed — which, for a thermally moving supercell, was nearly
// every frame (measured: 1 fast frame in 60, so the "fast path" never ran). It
// now moves each instance from its source atom plus that instance's frozen
// integer lattice shift. This test pins both halves of that: it is taken, and
// the positions it writes are the same ones a full recompute produces.
//
// The consumers that read those positions are checked too — measurements read
// periodic.visibleWrapped.cart, and the force arrows are rebuilt from the
// wrapping — because a fast path that silently leaves either stale is worse
// than no fast path at all.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const res = await page.evaluate(async () => {
    const { fileBrowser, general, groups } = await import('./state/store.js');
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { applyFrameFast } = await import('./render/FastFrameModule.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');

    createSupercell(2, 2, 2);
    await new Promise((r) => setTimeout(r, 600));

    const s = fileBrowser.selectedStructure;
    const natoms = s.atoms.length;
    // Force arrows only render when the structure actually carries forces.
    const { Force } = await import('./model/index.js');
    s.forces = s.atoms.map((_, i) => new Force({ vector: [0.1 + i * 1e-4, 0.05, -0.02], scaling: 1 }));
    general.forcesActive = true;
    const lattice = s.lattice;
    const toCart = (f) => [0, 1, 2].map((k) =>
      f[0] * lattice[0][k] + f[1] * lattice[1][k] + f[2] * lattice[2][k]);

    // A thermal-looking kick, including atoms pushed across a cell face — the
    // case that used to force a full rebuild every frame.
    const displace = () => {
      s.atoms.forEach((atom, i) => {
        atom.position = atom.position.map((c, k) => {
          const moved = c + (((i * 7 + k * 13) % 11) - 5) * 0.004;
          return ((moved % 1) + 1) % 1;
        });
      });
    };

    // Several consecutive fast frames: the set stays frozen across all of them,
    // so drift would compound and show up in the comparison below.
    let applied = 0;
    for (let f = 0; f < 5; f += 1) {
      displace();
      if (applyFrameFast(s)) applied += 1;
    }

    const wrapped = s.periodic.wrapped;
    const visible = s.periodic.visibleWrapped;
    const mesh = groups.atomsMesh;

    // 1+2. Every rendered instance — the atoms themselves and the face mirrors
    //      / PBC-bond ghosts interleaved with them — must sit exactly on its
    //      source atom translated by a whole number of cells. That is what
    //      "PBC is respected" means for the rendered images, and it is the
    //      invariant the fast path replays instead of re-deriving.
    let baseErr = 0;
    let imageErr = 0;
    let nonIntegerShift = 0;
    let ghosts = 0;
    for (let i = 0; i < wrapped.srcIndex.length; i += 1) {
      const src = s.atoms[wrapped.srcIndex[i]].position;
      const shift = [0, 1, 2].map((k) => wrapped.frac[i][k] - src[k]);
      shift.forEach((d) => { if (Math.abs(d - Math.round(d)) > 1e-9) nonIntegerShift += 1; });
      const isGhost = shift.some((d) => Math.round(d) !== 0);
      if (isGhost) ghosts += 1;
      const want = toCart([0, 1, 2].map((k) => src[k] + Math.round(shift[k])));
      for (let k = 0; k < 3; k += 1) {
        const err = Math.abs(want[k] - wrapped.cart[i][k]);
        if (isGhost) imageErr = Math.max(imageErr, err);
        else baseErr = Math.max(baseErr, err);
      }
    }

    // 3. The instanced mesh must carry those same positions (translation is at
    //    offsets 12/13/14 of each 4x4).
    let meshErr = 0;
    const arr = mesh.instanceMatrix.array;
    for (let i = 0; i < wrapped.cart.length; i += 1) {
      const o = i * 16;
      meshErr = Math.max(meshErr,
        Math.abs(arr[o + 12] - wrapped.cart[i][0]),
        Math.abs(arr[o + 13] - wrapped.cart[i][1]),
        Math.abs(arr[o + 14] - wrapped.cart[i][2]));
    }

    // 4. Measurements read visibleWrapped.cart — it must track the fast frames.
    let visibleErr = 0;
    for (let i = 0; i < visible.cart.length; i += 1) {
      const src = s.atoms[visible.srcIndex[i]].position;
      const shift = [0, 1, 2].map((k) => Math.round(visible.frac[i][k] - src[k]));
      const want = toCart([0, 1, 2].map((k) => src[k] + shift[k]));
      for (let k = 0; k < 3; k += 1) {
        visibleErr = Math.max(visibleErr, Math.abs(want[k] - visible.cart[i][k]));
      }
    }

    const forcesMesh = !!groups.forcesShaftMesh;

    // 5. Finally: a full rebuild from the same positions must agree with what
    //    the fast path left behind, for the atoms themselves.
    updateVisualization({
      atomsUpdate: true, bondsUpdate: true, reRenderAtoms: true, reRenderBonds: true,
    });
    await new Promise((r) => setTimeout(r, 300));
    const rebuilt = fileBrowser.selectedStructure.periodic.wrapped;
    let rebuildErr = 0;
    for (let i = 0; i < rebuilt.srcIndex.length; i += 1) {
      const src = s.atoms[rebuilt.srcIndex[i]].position;
      const shift = [0, 1, 2].map((k) => Math.round(rebuilt.frac[i][k] - src[k]));
      const want = toCart([0, 1, 2].map((k) => src[k] + shift[k]));
      for (let k = 0; k < 3; k += 1) {
        rebuildErr = Math.max(rebuildErr, Math.abs(want[k] - rebuilt.cart[i][k]));
      }
    }

    return {
      natoms,
      instances: wrapped.cart.length,
      applied,
      baseErr,
      imageErr,
      nonIntegerShift,
      meshErr,
      visibleErr,
      rebuildErr,
      ghosts,
      forcesMesh,
    };
  });

  console.log(`  ${res.natoms} atoms, ${res.instances} rendered instances, `
    + `${res.applied}/5 fast frames applied`);

  H.check('the fast path is actually taken for a moving supercell', res.applied === 5,
    JSON.stringify(res));
  H.check('atoms land exactly on their own position', res.baseErr < 1e-9, String(res.baseErr));
  H.check('periodic images stay a whole cell from their source',
    res.ghosts > 0 && res.imageErr < 1e-9 && res.nonIntegerShift === 0,
    `ghosts=${res.ghosts} err=${res.imageErr} nonInteger=${res.nonIntegerShift}`);
  // instanceMatrix is a Float32Array — ~1e-6 Å on a ~20 Å cell is the storage
  // precision, not staleness (a stale frame is off by the step displacement,
  // ~1e-2 Å, three orders of magnitude larger).
  H.check('the instanced mesh carries those positions', res.meshErr < 1e-4, String(res.meshErr));
  H.check('visibleWrapped (what measurements read) is not stale',
    res.visibleErr < 1e-9, String(res.visibleErr));
  H.check('a full rebuild agrees with the fast frames', res.rebuildErr < 1e-9, String(res.rebuildErr));
  H.check('force arrows are present while forcesActive', res.forcesMesh, '');

  // ---- atoms crossing a cell face must not fling their images a cell away ---
  // MD wraps positions into [0,1) every step. The image shifts are frozen
  // between rebuilds, so without a correction an atom that wraps drags all of
  // its periodic images a whole cell off — seen in the viewer as stray atoms
  // floating outside the box during a run.
  const wrapRes = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { applyFrameFast } = await import('./render/FastFrameModule.js');
    const s = fileBrowser.selectedStructure;

    // Park every atom just inside a face, then step it across.
    s.atoms.forEach((atom) => { atom.position = [0.995, 0.5, 0.5]; });
    applyFrameFast(s);
    const before = groups.atomsMesh.instanceMatrix.array.slice();

    const STEP = 0.01; // crosses 1.0 and wraps to ~0.005
    s.atoms.forEach((atom) => {
      atom.position = [((atom.position[0] + STEP) % 1 + 1) % 1, 0.5, 0.5];
    });
    const applied = applyFrameFast(s);
    const after = groups.atomsMesh.instanceMatrix.array;

    // The cell's shortest edge bounds "a whole cell away".
    const edge = Math.min(...s.lattice.map((r) => Math.hypot(r[0], r[1], r[2])));
    let maxJump = 0;
    for (let i = 0; i < groups.atomsMesh.count; i += 1) {
      const o = i * 16;
      maxJump = Math.max(maxJump, Math.hypot(
        after[o + 12] - before[o + 12],
        after[o + 13] - before[o + 13],
        after[o + 14] - before[o + 14]));
    }
    return { applied, maxJump, edge };
  });

  H.check('the fast path still applies across a wrap', wrapRes.applied === true,
    JSON.stringify(wrapRes));
  H.check('no instance jumps a whole cell when its atom wraps',
    wrapRes.maxJump < wrapRes.edge * 0.5,
    `max jump ${wrapRes.maxJump.toFixed(3)} A vs shortest cell edge ${wrapRes.edge.toFixed(3)} A`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
