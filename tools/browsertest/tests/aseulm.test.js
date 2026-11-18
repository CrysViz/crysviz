// Real ASE trajectories (.traj, the binary ULM container) load: io/ulm.js +
// ReadASETrajectoryModule.js. The reader on main only understood an older
// JSON-header layout and rejected every file ASE writes ("No number after
// minus sign" — the "- of Ulm" magic). Fixtures in tests/data/ase were
// written by ASE 3.29 together with the values ASE reports (expected.json):
// multi-frame files must land in the store frame for frame (positions
// fractional and unwrapped, to 1e-12; energy, forces, stress in the app's
// compression-positive convention, magnetic moments as spins), a frame
// without a cell gets a box around the atoms, a composition change is kept,
// and a single frame is an editable structure. Then one file goes through the
// normal loader and plays.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const DIR = path.join(__dirname, 'data', 'ase');
const files = Object.fromEntries(['si', 'water', 'varcomp', 'single']
  .map((k) => [k, fs.readFileSync(path.join(DIR, `${k}.traj`)).toString('base64')]));
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const r = await page.evaluate(async ({ files, expected }) => {
    const { parseASETrajectory } = await import('./io/ReadASETrajectoryModule.js');
    const { TrajectoryContainer } = await import('./model/index.js');
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const maxDiff = (a, b) => {
      const x = Array.from(a).flat(Infinity), y = Array.from(b).flat(Infinity);
      if (x.length !== y.length) return Infinity;
      return x.reduce((m, v, i) => Math.max(m, Math.abs(v - y[i])), 0);
    };
    const out = {};
    for (const name of ['si', 'water', 'varcomp']) {
      const c = parseASETrajectory(bytes(files[name]), `${name}.traj`);
      const res = { trajectory: c instanceof TrajectoryContainer, frames: c.store?.frameCount, problems: [] };
      expected[name].forEach((e, f) => {
        const ph = c.store.getFramePhysics(f);
        if (ph.elements.join() !== e.symbols.join()) res.problems.push(`f${f} elements ${ph.elements}`);
        const dl = maxDiff(ph.lattice, e.lattice);
        const dp = maxDiff(ph.positions, e.frac);
        if (!(dl < 1e-12)) res.problems.push(`f${f} lattice ${dl}`);
        if (!(dp < 1e-12)) res.problems.push(`f${f} positions ${dp}`);
        if (e.forces) { const d = maxDiff(ph.forces, e.forces); if (!(d < 1e-12)) res.problems.push(`f${f} forces ${d}`); } else if (ph.forces) res.problems.push(`f${f} unexpected forces`);
        if (e.energy != null && ph.energy !== e.energy) res.problems.push(`f${f} energy ${ph.energy}`);
        if (e.stress) {
          // ASE: tension-positive Voigt [xx yy zz yz xz xy]; app: compression-positive 3x3.
          const [xx, yy, zz, yz, xz, xy] = e.stress;
          const want = [[-xx, -xy, -xz], [-xy, -yy, -yz], [-xz, -yz, -zz]];
          const d = maxDiff(ph.stress, want);
          if (!(d < 1e-15)) res.problems.push(`f${f} stress ${d}`);
        }
        if (e.magmoms) {
          const want = e.magmoms.flatMap((m) => [0, 0, m]);
          if (!(maxDiff(ph.spinVectors, want) < 1e-12)) res.problems.push(`f${f} spins`);
        }
      });
      res.sharedElements = c.store.frameCount > 1
        && c.store.getFramePhysics(0).elements === c.store.getFramePhysics(1).elements;
      res.outsideCell = name === 'si' ? Math.max(...Array.from(c.store.getFramePhysics(2).positions)) : null;
      out[name] = res;
    }
    const single = parseASETrajectory(bytes(files.single), 'single.traj');
    const s = single.structures?.[0];
    const e = expected.single[0];
    out.single = {
      trajectory: single instanceof TrajectoryContainer,
      positions: maxDiff(s.atoms.map((a) => a.position), e.frac),
      forces: maxDiff(s.forces.map((x) => x.vector), e.forces),
      energy: s.energy,
      ids: s.atoms.every((a) => typeof a.uuid === 'string' && a.uuid.length > 0),
    };

    // End to end: the normal loader, then play it.
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const before = structureShip.container.length;
    await cv.loadStructure(bytes(files.si), 'si.traj');
    while (structureShip.container.length === before) await new Promise((res) => setTimeout(res, 100));
    const c = structureShip.container[structureShip.container.length - 1];
    for (let f = 0; f < c.frameCount; f++) showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
    out.loaded = { frames: c.frameCount, shownAtoms: fileBrowser.selectedStructure.atoms.length, energy: fileBrowser.selectedStructure.energy };
    return out;
  }, { files, expected });

  H.check('ASE Si trajectory: 3 frames, every value as ASE wrote it', r.si.trajectory && r.si.frames === 3 && r.si.problems.length === 0, JSON.stringify(r.si));
  H.check('positions stay unwrapped (an atom moved outside the cell keeps its fractional > 1)', r.si.outsideCell > 1, JSON.stringify(r.si.outsideCell));
  H.check('fixed-composition frames share one elements array', r.si.sharedElements, JSON.stringify(r.si));
  H.check('a molecule without a cell gets a box around it', r.water.trajectory && r.water.problems.length === 0, JSON.stringify(r.water));
  H.check('a composition change between frames is kept', r.varcomp.trajectory && r.varcomp.problems.length === 0 && !r.varcomp.sharedElements, JSON.stringify(r.varcomp));
  H.check('a single frame is an editable structure with registered atom ids',
    !r.single.trajectory && r.single.positions < 1e-12 && r.single.forces < 1e-12 && r.single.energy === -3.7 && r.single.ids, JSON.stringify(r.single));
  H.check('an ASE trajectory loads through the normal loader and plays', r.loaded.frames === 3 && r.loaded.shownAtoms === 8 && r.loaded.energy === expected.si[2].energy,
    JSON.stringify(r.loaded));
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
