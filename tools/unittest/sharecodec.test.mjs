// Unit tests for the compact share-link codec (docs/io/share/shareCodec.js).
// Run: make unittest   (or: node --test tools/unittest/)
//
// Fixtures are real captureState() snapshots written by
// tools/browsertest/gen_share_fixtures.js; regenerate them there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  encodeCompact, expandCompact, compactReference, geometryFingerprint, POSITION_TOLERANCE_A,
} from '../../docs/io/share/shareCodec.js';
import {
  BASELINES, LATEST_BASELINE_ID, SETTING_KEYS, STRUCTURE_DERIVED_KEYS,
} from '../../docs/io/share/shareBaselines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'share');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const fixtureNames = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'baseline.json').sort();
const clone = (o) => JSON.parse(JSON.stringify(o));

/** The copy-link form: 1 envelope header byte (codec 2) + deflate-raw(JSON), base64url. */
function linkFor(obj) {
  const body = zlib.deflateRawSync(Buffer.from(JSON.stringify(obj)), { level: 9 });
  return 'https://crysviz.org/#z=' + Buffer.concat([Buffer.from([2]), body]).toString('base64url');
}

/** Encode, go through JSON as a link would, expand. */
function roundTrip(state, options) {
  return expandCompact(JSON.parse(JSON.stringify(encodeCompact(state, options))));
}

const round6 = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v);
function normalized(v) {
  if (Array.isArray(v)) return v.map(normalized);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, normalized(x)]));
  return round6(v);
}

function assertClose(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (tol ${tol})`);
}

function assertStructureClose(decoded, original) {
  assert.deepEqual(decoded.elements, original.elements, 'elements');
  decoded.lattice.flat().forEach((v, i) => assertClose(v, original.lattice.flat()[i], 5e-7, `lattice[${i}]`));
  const lengths = original.lattice.map((r) => Math.hypot(...r));
  decoded.positions.forEach((p, i) => p.forEach((v, a) => {
    let d = v - original.positions[i][a];
    d -= Math.round(d); // readPOSCAR wraps anyway; a whole-cell shift is the same site
    assert.ok(Math.abs(d) * lengths[a] <= POSITION_TOLERANCE_A * (1 + 1e-9),
      `atom ${i} axis ${a}: error ${Math.abs(d) * lengths[a]} Å`);
  }));
}

/** Link lengths recorded when the codec landed (characters, copy-link form). */
const SIZE_BUDGETS = {
  'boot.json': 465,
  'default-poscar2.json': 297,
  'default-poscar3.json': 538,
  'default-poscar4.json': 465,
  'default-poscar5.json': 193,
  'nacl-supercell-222.json': 329,
  'nacl.json': 246,
  'sicn-575.json': 3705,
  'ybco-styled.json': 499,
};

for (const name of fixtureNames) {
  test(`round trip: ${name}`, () => {
    const { state, supercell } = load(name);
    const out = roundTrip(state, { supercell });

    assert.equal(out.version, '2.16');
    assertStructureClose(out.structure, state.structure);

    const species = [...new Set(state.structure.elements)];
    const present = (k) => {
      const pair = /^(.+)-(.+)$/.exec(k);
      return species.includes(k) || (pair && species.includes(pair[1]) && species.includes(pair[2]));
    };

    // Settings: every non-derived key comes back (rounded to 6 significant digits).
    for (const sect of ['colors', 'display', 'style']) {
      for (const [key, value] of Object.entries(state[sect])) {
        if (value === undefined || STRUCTURE_DERIVED_KEYS.includes(`${sect}.${key}`)) continue;
        assert.deepEqual(normalized(out[sect][key]), normalized(value), `${sect}.${key}`);
      }
    }

    // Species tables, filtered to the species present.
    for (const el of species) assert.equal(out.colors.elementColors[el], state.colors.elementColors[el], `element colour ${el}`);
    const expectedPairs = Object.keys(state.display.bondLengths).filter(present).sort();
    assert.deepEqual(Object.keys(out.display.bondLengths).sort(), expectedPairs, 'bond pairs');
    for (const p of expectedPairs) {
      assertClose(out.display.bondLengths[p].max, state.display.bondLengths[p].max, 1e-5, `${p} max`);
      assertClose(out.display.bondLengths[p].min, state.display.bondLengths[p].min, 1e-5, `${p} min`);
      assert.equal(out.display.bondVisibility[p], state.display.bondVisibility[p] !== false, `${p} visibility`);
    }

    // Per-atom maps.
    for (const k of ['atomColors', 'atomOpacities', 'atomRadiusScales']) {
      assert.deepEqual(normalized(out.colors[k]), normalized(state.colors[k]), k);
    }

    // Measurements: same atoms, same periodic images. Refs whose element no
    // longer matches their atom are stale leftovers of an earlier structure
    // (the loader cannot resolve them) and are dropped by the encoder.
    const live = state.measurements.filter((m) => ['atom1Ref', 'atom2Ref', 'atom3Ref']
      .every((k) => !m[k] || m[k].element === state.structure.elements[m[k].atomIndex]));
    assert.equal(out.measurements.length, live.length, 'measurement count');
    out.measurements.forEach((m, i) => {
      const src = live[i];
      assert.equal(m.type, src.type);
      for (const k of ['atom1Ref', 'atom2Ref', 'atom3Ref']) {
        if (!src[k]) continue;
        assert.equal(m[k].atomIndex, src[k].atomIndex, `${k} index`);
        assert.equal(m[k].element, src[k].element, `${k} element`);
        assert.deepEqual(m[k].imageOffset, src[k].imageOffset, `${k} offset`);
        m[k].lastResolvedFrac.forEach((v, a) => assertClose(v, src[k].lastResolvedFrac[a], 1e-4, `${k} frac`));
      }
    });

    // Camera: position rebuilt from quaternion + target + distance.
    const c = state.camera;
    c.position.forEach((v, a) => assertClose(out.camera.position[a], v, 0.01, `camera position ${a}`));
    c.target.forEach((v, a) => assertClose(out.camera.target[a], v, 5e-4, `camera target ${a}`));
    c.up.forEach((v, a) => assertClose(out.camera.up[a], v, 5e-4, `camera up ${a}`));
    c.quaternion.forEach((v, a) => assertClose(out.camera.quaternion[a], v, 1e-4, `camera quaternion ${a}`));
    assert.equal(out.camera.orthographic, c.orthographic);
    if (c.orthographic) assertClose(out.camera.frustumSize, c.frustumSize, 1e-4, 'frustum');
    assertClose(out.camera.zoom, c.zoom, 1e-4, 'zoom');
  });

  test(`size budget: ${name}`, () => {
    const { state, supercell } = load(name);
    const length = linkFor(encodeCompact(state, { supercell })).length;
    const budget = SIZE_BUDGETS[name];
    assert.ok(budget, `no size budget recorded for ${name} (measured ${length})`);
    assert.ok(length <= budget * 1.1, `${name}: link is ${length} characters, budget ${budget} (+10%)`);
  });
}

test('every captured setting has a short key or is structure-derived', () => {
  const known = new Set([...SETTING_KEYS.map(([p]) => p), ...STRUCTURE_DERIVED_KEYS]);
  for (const name of fixtureNames) {
    const { state } = load(name);
    for (const sect of ['colors', 'display', 'style']) {
      for (const key of Object.keys(state[sect])) assert.ok(known.has(`${sect}.${key}`), `${sect}.${key} has no short key`);
    }
  }
});

test('short keys are unique and baseline 1 matches the recorded fresh-boot snapshot', () => {
  const shorts = SETTING_KEYS.map(([, s]) => s);
  assert.equal(new Set(shorts).size, shorts.length, 'duplicate short key');
  const boot = load('baseline.json');
  const base = BASELINES[LATEST_BASELINE_ID];
  for (const [p] of SETTING_KEYS) {
    const [sect, key] = p.split('.');
    assert.deepEqual(base[sect][key], boot[sect][key], `${p} differs from fixtures/share/baseline.json`);
  }
  assert.ok(Object.isFrozen(BASELINES[1].display), 'baselines must be frozen');
});

test('a plain structure writes no settings and filters foreign bond pairs', () => {
  const { state } = load('nacl.json');
  const s = clone(state);
  s.display.bondLengths['Ba-Cu'] = { min: 0, max: 3 };
  s.display.bondVisibility['Ba-Cu'] = false;
  s.display.atomVisibility = { Ba: false, Na: false };
  s.display.bondCutImmunity = { 'Cu-O': true, 'Cl-Na': true };
  const obj = encodeCompact(s);
  assert.equal(obj.o, undefined, 'no settings differ from the baseline');
  assert.ok(obj.bl.every(([p]) => !p.includes('Ba') && !p.includes('Cu')), 'foreign pairs removed');
  assert.equal(obj.bh, undefined);
  assert.deepEqual(obj.av, { Na: false });
  assert.deepEqual(obj.ci, { 'Cl-Na': true });
});

test('a changed setting is written and recipients get baseline values for the rest', () => {
  const { state } = load('nacl.json');
  const s = clone(state);
  s.style.renderStyle = 'cel';
  s.display.atomSize = 0.55;
  const obj = encodeCompact(s);
  assert.deepEqual(obj.o, { rs: 'cel', as: 0.55 });
  const out = expandCompact(obj);
  assert.equal(out.style.renderStyle, 'cel');
  assert.equal(out.display.atomSize, 0.55);
  assert.equal(out.style.depthPeelLayers, BASELINES[1].style.depthPeelLayers);
});

test('a setting without a short key survives through X', () => {
  const s = clone(load('nacl.json').state);
  s.display.someFutureSetting = 42;
  const obj = encodeCompact(s);
  assert.deepEqual(obj.X, { 'display.someFutureSetting': 42 });
  assert.equal(expandCompact(obj).display.someFutureSetting, 42);
});

test('per-atom maps group by value with index ranges', () => {
  const s = clone(load('nacl-supercell-222.json').state);
  s.colors.atomColors = {};
  for (let i = 0; i <= 9; i++) s.colors.atomColors[i] = 0xff0000;
  s.colors.atomColors[22] = 0xff0000;
  s.colors.atomColors[20] = 0x0000ff;
  s.colors.atomColors[30] = '#00ff00';
  s.colors.atomColors[31] = '#00ff00';
  const obj = encodeCompact(s);
  assert.deepEqual(obj.ac, [[0xff0000, [[0, 9], 22]], [0x0000ff, [20]], ['#00ff00', [30, 31]]]);
  assert.deepEqual(expandCompact(obj).colors.atomColors, s.colors.atomColors);
});

test('supercell: base cell plus multipliers, verified by re-expansion', () => {
  const { state, supercell } = load('nacl-supercell-222.json');
  assert.deepEqual(supercell, { nx: 2, ny: 2, nz: 2 });
  const obj = encodeCompact(state, { supercell });
  assert.deepEqual(obj.s.x, [2, 2, 2]);
  assert.equal(obj.s.p[0].length, state.structure.positions.length / 8);
  const out = expandCompact(obj);
  assertStructureClose(out.structure, state.structure);
  assert.deepEqual(out.colors.atomColors, state.colors.atomColors, 'per-atom colours keep supercell indices');

  // Link size must not grow with the multipliers.
  const plain = load('nacl.json');
  assert.ok(linkFor(obj).length < linkFor(encodeCompact(plain.state)).length + 150);
});

test('supercell: an edited image atom falls back to the full atom list', () => {
  const { state, supercell } = load('nacl-supercell-222.json');
  const moved = clone(state);
  moved.structure.positions[40][0] += 0.01;
  const obj = encodeCompact(moved, { supercell });
  assert.equal(obj.s.x, undefined);
  assert.equal(obj.s.p[0].length, moved.structure.positions.length);
  assertStructureClose(expandCompact(obj).structure, moved.structure);

  const relabelled = clone(state);
  relabelled.structure.elements[40] = 'K';
  assert.equal(encodeCompact(relabelled, { supercell }).s.x, undefined);
  assert.equal(encodeCompact(state, { supercell: { nx: 3, ny: 1, nz: 1 } }).s.x, undefined, 'wrong multipliers');
});

test('camera: a camera not looking at its target keeps its explicit position', () => {
  const s = clone(load('nacl.json').state);
  s.camera.position = [s.camera.position[0] + 3, s.camera.position[1], s.camera.position[2]];
  const obj = encodeCompact(s);
  assert.equal(obj.c.length, 18);
  const out = expandCompact(obj);
  s.camera.position.forEach((v, a) => assertClose(out.camera.position[a], v, 1e-3, 'explicit position'));
});

test('camera: default zoom, pan and up are trimmed', () => {
  const s = clone(load('nacl.json').state);
  s.camera.up = [0, 1, 0];
  s.camera.zoom = 1;
  s.camera.pan = [0, 0];
  const obj = encodeCompact(s);
  assert.equal(obj.c.length, 9);
  const out = expandCompact(obj);
  assert.deepEqual(out.camera.up, [0, 1, 0]);
  assert.equal(out.camera.zoom, 1);
  assert.deepEqual(out.camera.pan, [0, 0]);
});

test('database reference: link carries the reference instead of coordinates', () => {
  const { state } = load('ybco-styled.json');
  const fingerprint = geometryFingerprint(state.structure);
  const reference = { kind: 'alexandria', id: 'agm002153387', fingerprint };
  const obj = encodeCompact(state, { reference });
  assert.deepEqual(obj.r, { a: 'agm002153387', k: fingerprint });
  assert.equal(obj.s, undefined);
  assert.deepEqual(compactReference(obj), { kind: 'alexandria', id: 'agm002153387', fingerprint, supercell: null });
  assert.ok(linkFor(obj).length < linkFor(encodeCompact(state)).length, 'reference link is shorter than the embedded one');
  const plain = load('nacl.json').state;
  const plainRef = encodeCompact(plain, { reference: { kind: 'alexandria', id: 'agm002153387', fingerprint: geometryFingerprint(plain.structure) } });
  assert.ok(linkFor(plainRef).length <= 260, `plain reference link is ${linkFor(plainRef).length} characters`);

  assert.throws(() => expandCompact(obj), /needs the referenced database structure/);
  const out = expandCompact(JSON.parse(JSON.stringify(obj)), { referenceStructure: state.structure });
  assert.equal(out.shareWarnings, undefined);
  assert.deepEqual(out.colors.atomColors, state.colors.atomColors);
  assert.equal(out.measurements.length, state.measurements.length);

  // The database entry changed: structure kept, per-atom styling dropped, warning set.
  const changed = clone(state.structure);
  changed.positions[0][2] += 0.01;
  const stale = expandCompact(obj, { referenceStructure: changed });
  assert.equal(stale.shareWarnings.length, 1);
  assert.deepEqual(stale.colors.atomColors, {});
  assert.deepEqual(stale.measurements, []);
});

test('database reference: an edited structure embeds its coordinates', () => {
  const { state } = load('ybco-styled.json');
  const reference = { kind: 'optimade', url: 'https://example.org/v1/structures/x', fingerprint: geometryFingerprint(state.structure) };
  const edited = clone(state);
  edited.structure.positions[2][0] += 0.02;
  const obj = encodeCompact(edited, { reference });
  assert.equal(obj.r, undefined);
  assert.ok(Array.isArray(obj.s.p));
});

test('database reference: a supercell of an unchanged structure is reference plus multipliers', () => {
  const { state, supercell } = load('nacl-supercell-222.json');
  const base = expandCompact(encodeCompact(state, { supercell })).structure;
  const count = base.positions.length / 8;
  const baseCell = {
    elements: base.elements.slice(0, count),
    positions: state.structure.positions.slice(0, count).map((p) => p.map((v) => v * 2)),
    lattice: state.structure.lattice.map((r) => r.map((v) => v / 2)),
  };
  const reference = { kind: 'optimade', url: 'https://optimade.example/v1/structures/nacl', fingerprint: geometryFingerprint(baseCell) };
  const obj = encodeCompact(state, { supercell, reference });
  assert.deepEqual(obj.s, { x: [2, 2, 2] });
  assert.equal(obj.r.u, reference.url);
  const out = expandCompact(obj, { referenceStructure: baseCell });
  assertStructureClose(out.structure, state.structure);
});

test('geometry fingerprint is stable, wrap-invariant and pinned', () => {
  const { structure } = load('nacl.json').state;
  const fp = geometryFingerprint(structure);
  assert.equal(geometryFingerprint(clone(structure)), fp);
  const wrapped = clone(structure);
  wrapped.positions[3][1] += 1;
  assert.equal(geometryFingerprint(wrapped), fp, 'whole-cell shift');
  const nudged = clone(structure);
  nudged.positions[3][1] += 1e-9;
  assert.equal(geometryFingerprint(nudged), fp, 'below link precision');
  const moved = clone(structure);
  moved.positions[3][1] += 1e-3;
  assert.notEqual(geometryFingerprint(moved), fp);
  // Links store this value: changing the algorithm breaks every reference link.
  assert.equal(fp, PINNED_NACL_FINGERPRINT);
});

const PINNED_NACL_FINGERPRINT = geometryFingerprint({
  elements: ['Na', 'Na', 'Na', 'Na', 'Cl', 'Cl', 'Cl', 'Cl'],
  lattice: [[5.64, 0, 0], [0, 5.64, 0], [0, 0, 5.64]],
  positions: [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0], [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0.5, 0.5]],
});
test('geometry fingerprint pin value', () => {
  assert.equal(PINNED_NACL_FINGERPRINT, 'md9ya0');
});

test('malformed links are rejected with a clear error', () => {
  const good = encodeCompact(load('nacl.json').state);
  const bad = (mutate, pattern) => {
    const obj = clone(good);
    mutate(obj);
    assert.throws(() => expandCompact(obj), pattern);
  };
  assert.throws(() => expandCompact(null), /not an object/);
  bad((o) => { o.v = 4; }, /unsupported format version/);
  bad((o) => { o.b = 99; }, /newer version/);
  bad((o) => { delete o.s; }, /missing structure/);
  bad((o) => { o.s.p[0].pop(); }, /bad positions/);
  bad((o) => { o.s.l[0] = 'x'; }, /bad lattice/);
  bad((o) => { o.s.e[0][1] = 300000; }, /too many atoms/);
  bad((o) => { o.s.x = [20, 20, 20]; }, /supercell too large/);
  bad((o) => { o.ac = [[0xff0000, [99]]]; }, /index out of range/);
  bad((o) => { o.ac = [['red', [0]]]; }, /bad atom colours value/);
  bad((o) => { o.ao = [[3, [0]]]; }, /bad atom opacities value/);
  bad((o) => { o.ec = [1]; }, /bad element colours/);
  bad((o) => { o.c = [1, 2]; }, /bad camera/);
  bad((o) => { o.m = [['d', [0, 0, 0, 0], [50, 0, 0, 0]]]; }, /bad measurement atom/);
  bad((o) => { o.o = { as: 'huge' }; }, /bad value for display.atomSize/);
  bad((o) => { o.r = { z: 1 }; }, /unrecognised database reference/);
});

test('unknown keys are ignored and unsafe keys cannot pollute prototypes', () => {
  const obj = clone(encodeCompact(load('nacl.json').state));
  obj.zz = { future: true };
  obj.o = { '??': 5, as: 0.5 };
  obj.av = JSON.parse('{"__proto__": {"polluted": true}, "Na": false}');
  const out = expandCompact(obj);
  assert.equal(out.display.atomSize, 0.5);
  assert.deepEqual(out.display.atomVisibility, { Na: false });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(out.display.atomVisibility), Object.prototype);
});
