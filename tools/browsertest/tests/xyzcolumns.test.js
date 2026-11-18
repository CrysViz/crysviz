// io/ReadeXYZModule.js parses into per-frame typed columns and packs a
// multi-frame file straight into the trajectory store (no Structure / Atom /
// Force / Spin per frame). It must read every file exactly as the per-atom
// object parser it replaced did. The old parser is kept here, frozen, as the
// reference: both read the same texts and the stores are compared value for
// value (positions bit for bit). The one intended difference: a trajectory
// without force / spin columns now stores none instead of zeros.
'use strict';
const H = require('../harness');

const FILES = {
  forces: [
    '3', 'Lattice="5.1 0.2 0 0 4.9 0.1 0.3 0 5.3" Properties=species:S:1:pos:R:3:forces:R:3 energy=-3.2',
    'Si 0.1 0.2 0.3 0.01 -0.02 0.03', 'O 1.234567890123 2.5 -0.7 1 2 3', 'Si 6.0 -1.0 2.2 0 0 0',
    '3', 'Lattice="5.1 0.2 0 0 4.9 0.1 0.3 0 5.3" Properties=species:S:1:pos:R:3:forces:R:3',
    'Si 0.11 0.21 0.31 0.011 -0.021 0.031', 'O 1.3 2.4 -0.6 1.1 2.1 3.1', 'Si 5.9 -0.9 2.3 0.5 0.5 0.5',
  ].join('\n'),
  spins: [
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3:forces:R:3:spin:R:3',
    'Fe 0 0 0 0.1 0.2 0.3 0 0 2.2', 'Fe 2 2 2 -0.1 -0.2 -0.3 0 0 -2.2',
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3:forces:R:3:spin:R:3',
    'Fe 0.1 0 0 0.1 0.2 0.3 0.1 0 2.1', 'Fe 2.1 2 2 -0.1 -0.2 -0.3 0 0.1 -2.1',
  ].join('\n'),
  plainNoLattice: [
    '3', 'water', 'O 0.0 0.0 0.0', 'H 0.757 0.586 0.0', 'H -0.757 0.586 0.0',
    '3', 'water 2', 'O 0.01 0.0 0.0', 'H 0.767 0.596 0.0', 'H -0.747 0.576 0.01',
  ].join('\n'),
  mixedCrlfTabs: [
    '2', 'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3',
    '  Na\t0.5   0.5 0.5  ', 'Cl 3.0\t3.0 3.0',
    '3', 'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3',
    'Na 0.6 0.5 0.5', 'Cl 3.1 3.0 3.0', 'Cl -1e-3 7.5 1.5e0',
  ].join('\r\n') + '\r\n',
  single: [
    '2', 'Lattice="3 0 0 0 3 0 0 0 3" Properties=species:S:1:pos:R:3:forces:R:3',
    'Cu 0 0 0 0.5 0 0', 'Cu 1.5 1.5 1.5 0 -0.5 0',
  ].join('\n'),
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // Which files have force (7+) / spin (10+) columns on their atom lines.
  const COLUMNS = { forces: [true, false], spins: [true, true], plainNoLattice: [false, false], mixedCrlfTabs: [false, false] };
  const res = await page.evaluate(async ({ files, columns }) => {
    const { parseXYZFile } = await import('./io/ReadeXYZModule.js');
    const { Structure, Atom, Force, Spin, TrajectoryContainer } = await import('./model/index.js');
    const { transpose3x3, multiplyMatVec, invert3x3 } = await import('./math/backend-js.js');

    // ---- the replaced parser (frozen reference) ----
    function isExtXYZ(content) {
      const lines = content.split(/\r?\n/);
      if (lines.length < 2) return false;
      return lines[1].includes('Lattice=') || lines[1].includes('Properties=');
    }
    const com = (atoms) => { let x = 0, y = 0, z = 0; atoms.forEach((a) => { x += a.position[0]; y += a.position[1]; z += a.position[2]; }); return [x / atoms.length, y / atoms.length, z / atoms.length]; };
    const maxMagOf = (atoms) => { let m = 0; atoms.forEach((a) => { const [x, y, z] = a.position; m = Math.max(m, Math.abs(x), Math.abs(y), Math.abs(z)); }); return m; };
    const box = (m) => { const s = 2 * (m + 2); return [[s, 0, 0], [0, s, 0], [0, 0, s]]; };
    const toFrac = (cart, lattice) => { const inv = invert3x3(transpose3x3(lattice), 1e-14); return cart.map((v) => multiplyMatVec(inv, v).map((x) => ((x % 1) + 1) % 1)); };
    function oldParse(content) {
      const lines = content.split(/\r?\n/);
      const frames = [];
      let i = 0;
      const ext = isExtXYZ(content);
      while (i < lines.length) {
        const natoms = parseInt(lines[i], 10);
        if (isNaN(natoms) || natoms <= 0) break;
        const comment = lines[i + 1] || '';
        const frame = { atoms: [], forces: [], spins: [], lattice: null };
        if (ext) {
          const m = comment.match(/Lattice="([^"]+)"/);
          if (m) { const v = m[1].split(/\s+/).map(parseFloat); frame.lattice = [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)]; }
        }
        for (let j = 0; j < natoms; j++) {
          const parts = lines[i + 2 + j].trim().split(/\s+/);
          frame.atoms.push({ element: parts[0], position: [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])] });
          frame.forces.push(parts.length >= 7 ? [parseFloat(parts[4]), parseFloat(parts[5]), parseFloat(parts[6])] : [0, 0, 0]);
          frame.spins.push(parts.length >= 10 ? [parseFloat(parts[7]), parseFloat(parts[8]), parseFloat(parts[9])] : [0, 0, 0]);
        }
        if (!frame.lattice) {
          const c = com(frame.atoms); const mm = maxMagOf(frame.atoms); const b = box(mm);
          frame.atoms.forEach((a) => { const [x, y, z] = a.position; a.position = [x - c[0] + b[0][0] / 2, y - c[1] + b[1][1] / 2, z - c[2] + b[2][2] / 2]; });
          frame.lattice = b;
          const fr = toFrac(frame.atoms.map((a) => a.position), b);
          if (!fr.every((p) => p.every((v) => v >= 0 && v <= 1))) frame.lattice = box(mm * 2);
        }
        frames.push(frame);
        i += 2 + natoms;
      }
      const structures = frames.map((frame) => {
        const elements = frame.atoms.map((a) => a.element);
        const frac = toFrac(frame.atoms.map((a) => a.position), frame.lattice);
        return new Structure({
          elements, uniqueElements: [...new Set(elements)], lattice: frame.lattice,
          atoms: frame.atoms.map((a, k) => new Atom({ element: a.element, position: frac[k] })),
          forces: frame.forces.map((v) => new Force({ vector: v, scaling: 1.0 })),
          spins: frame.spins.map((v) => new Spin({ vector: v, scaling: 1.0 })),
        });
      });
      return structures.length > 1 ? TrajectoryContainer.fromStructures('ref', structures) : structures[0];
    }

    const same = (a, b) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));
    const out = {};
    for (const [name, text] of Object.entries(files)) {
      const ref = oldParse(text);
      const got = await parseXYZFile(text, `${name}.xyz`);
      const r = { problems: [] };
      if (ref instanceof TrajectoryContainer) {
        r.kind = got instanceof TrajectoryContainer ? 'trajectory' : 'NOT a trajectory';
        r.frames = got.store.frameCount;
        if (got.store.frameCount !== ref.store.frameCount) r.problems.push('frame count');
        for (let f = 0; f < ref.store.frameCount; f++) {
          const a = ref.store.getFramePhysics(f), b = got.store.getFramePhysics(f);
          if (!same(a.elements, b.elements)) r.problems.push(`f${f} elements`);
          if (!same(a.lattice.flat(), b.lattice.flat())) r.problems.push(`f${f} lattice`);
          if (!same(a.positions, b.positions)) r.problems.push(`f${f} positions`);
          const [hasForces, hasSpins] = columns[name];
          if (hasForces) { if (!b.forces || !same(a.forces, b.forces)) r.problems.push(`f${f} forces`); } else if (b.forces !== null) r.problems.push(`f${f} forces should be absent`);
          if (hasSpins) {
            if (!b.spinVectors || !same(a.spinVectors, b.spinVectors) || !same(a.spinRaw, b.spinRaw)) r.problems.push(`f${f} spins`);
          } else if (b.spinVectors !== null) r.problems.push(`f${f} spins should be absent`);
          if (a.energy !== b.energy || a.stress !== b.stress) r.problems.push(`f${f} energy/stress`);
          if (!same(a.spinFrame.fileSaxis, b.spinFrame.fileSaxis)) r.problems.push(`f${f} spinFrame`);
        }
        if (got._frameStyles.size !== ref._frameStyles.size) r.problems.push('style records');
        r.sharedElements = got.store.getFramePhysics(0).elements === got.store.getFramePhysics(got.store.frameCount - 1).elements;
      } else {
        const s = got.structures[0];
        r.kind = got instanceof TrajectoryContainer ? 'trajectory?!' : 'structure';
        if (!same(ref.elements, s.elements)) r.problems.push('elements');
        if (!same(ref.lattice.flat(), s.lattice.flat())) r.problems.push('lattice');
        if (!same(ref.atoms.flatMap((a) => a.position), s.atoms.flatMap((a) => a.position))) r.problems.push('positions');
        if (!same(ref.forces.flatMap((x) => x.vector), s.forces.flatMap((x) => x.vector))) r.problems.push('forces');
        if (!same(ref.spins.flatMap((x) => x.vector), s.spins.flatMap((x) => x.vector))) r.problems.push('spins');
        r.registeredIds = s.atoms.every((a) => typeof a.uuid === 'string' && a.uuid.length > 0);
      }
      out[name] = r;
    }
    return out;
  }, { files: FILES, columns: COLUMNS });

  for (const [name, r] of Object.entries(res)) {
    const expectKind = name === 'single' ? 'structure' : 'trajectory';
    H.check(`${name}: read exactly as before (${r.kind}${r.frames ? `, ${r.frames} frames` : ''})`,
      r.kind === expectKind && r.problems.length === 0, JSON.stringify(r));
  }
  H.check('fixed-composition frames share one elements array', res.forces.sharedElements && res.spins.sharedElements,
    JSON.stringify({ forces: res.forces.sharedElements, spins: res.spins.sharedElements }));
  H.check('mixed composition keeps each frame\'s own species', res.mixedCrlfTabs.problems.length === 0 && res.mixedCrlfTabs.sharedElements === false,
    JSON.stringify(res.mixedCrlfTabs));
  H.check('a single-frame file stays an editable structure with registered atom ids', res.single.registeredIds === true,
    JSON.stringify(res.single));
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
