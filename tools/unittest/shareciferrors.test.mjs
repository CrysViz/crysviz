// Share links carry the errors read from a CIF (docs/io/share/shareCodec.js
// encodeCifErrors/decodeCifErrors): captureState's `cifErrors` record
// (model/cifErrors.js serializeCifErrors) goes into the link as `er` and comes
// back in the same shape, so ShareModule's restoreCifErrors puts it on the same
// atoms. The records here are built by the real CIF reader. Links are
// untrusted: bad blocks are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodeCompact, expandCompact, geometryFingerprint } from '../../docs/io/share/shareCodec.js';
import { cif_to_struct } from '../../docs/io/cif.js';
import { buildCifErrors } from '../../docs/io/cif/cif_errors.js';
import {
  acceptCifErrors, serializeCifErrors, restoreCifErrors, distanceSu, angleSu,
  fracCoordinateSus, cellParameterSus, atomCifSite,
} from '../../docs/model/cifErrors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'share', name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const roundTrip = (state, options) => expandCompact(JSON.parse(JSON.stringify(encodeCompact(state, options))));
const linkFor = (obj) => 'https://crysviz.org/#z='
  + Buffer.concat([Buffer.from([2]), zlib.deflateRawSync(Buffer.from(JSON.stringify(obj)), { level: 9 })]).toString('base64url');

// α-quartz, P3₂21 (as in tools/browsertest/tests/ciferrors.test.js): a = b
// tied, Si on a two-fold axis.
const QUARTZ_CIF = `data_quartz
_symmetry_space_group_name_H-M   'P 32 2 1'
_space_group_IT_number   154
_cell_length_a   4.9160(1)
_cell_length_b   4.9160(1)
_cell_length_c   5.4054(1)
_cell_angle_alpha   90
_cell_angle_beta    90
_cell_angle_gamma   120
loop_
_space_group_symop_operation_xyz
x,y,z
-y,x-y,z+2/3
-x+y,-x,z+1/3
y,x,-z
x-y,-y,-z+1/3
-x,-x+y,-z+2/3
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Si1 Si 0.4697(1) 0 0.66667
O1 O 0.4135(3) 0.2669(3) 0.7858(2)
`;

// I2N3, P-3m1: N1 at (x, 2x, z), whose x and y are one parameter (a
// direction that is not a single coordinate).
const I2N3_CIF = `data_i2n3
_space_group_name_H-M_alt 'P -3 m 1'
_space_group_IT_number 164
loop_
_space_group_symop_operation_xyz
'x, y, z'
'-y, x-y, z'
'-x+y, -x, z'
'y, x, -z'
'x-y, -y, -z'
'-x, -x+y, -z'
'-x, -y, -z'
'y, -x+y, -z'
'x-y, x, -z'
'-y, -x, z'
'-x+y, y, z'
'x, x-y, z'
_cell_length_a 4.7666(7)
_cell_length_b 4.7666(7)
_cell_length_c 5.4639(9)
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 120
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_site_symmetry_order
I001 I 0.666667 0.333333 0.4910(3) 6
I002 I 1.000000 0.000000 0.25519(19) 6
N1 N 1.4937(13) -0.013(3) 0.099(2) 2
`;

/** A structure as the app holds it after "read the errors": what the model
 *  functions read (lattice, atoms with position and cifSite, cifErrors). */
async function readCif(text) {
  const cif = await cif_to_struct(new Blob([text]).stream());
  const errors = buildCifErrors(cif);
  const s = {
    elements: [...cif.species_full],
    lattice: cif.basis.map((row) => row.map(Number)),
    atoms: cif.positions_full.map((p, i) => ({ position: p.map(Number), cifSite: errors.atoms[i] })),
    cifErrors: { cell: errors.cell, sites: errors.sites, pending: true },
  };
  acceptCifErrors(s);
  return s;
}

/** ui/SuperCellModule.js: copies keep their site, toCif maps the new cell's
 *  fractional coordinates to the CIF's. */
function supercellOf(s, [nx, ny, nz]) {
  const atoms = [];
  const elements = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    s.atoms.forEach((a, p) => {
      atoms.push({ position: [(a.position[0] + i) / nx, (a.position[1] + j) / ny, (a.position[2] + k) / nz], cifSite: a.cifSite });
      elements.push(s.elements[p]);
    });
  }
  const n = [nx, ny, nz];
  return {
    elements, atoms, lattice: s.lattice.map((row, a) => row.map((v) => v * n[a])),
    cifErrors: { ...s.cifErrors, toCif: [[nx, 0, 0], [0, ny, 0], [0, 0, nz]] },
  };
}

/** A captureState() snapshot of `s` (settings from a real one). */
function stateOf(s) {
  const state = clone(load('nacl.json').state);
  state.structure = { elements: [...s.elements], lattice: s.lattice.map((r) => [...r]), positions: s.atoms.map((a) => [...a.position]) };
  state.measurements = [];
  const cifErrors = serializeCifErrors(s);
  return cifErrors ? { ...state, cifErrors } : state;
}

/** What the recipient's app does with an expanded link: the structure from
 *  its positions, then restoreCifErrors. */
function opened(state) {
  const s = {
    elements: state.structure.elements,
    lattice: state.structure.lattice,
    atoms: state.structure.positions.map((p) => ({ position: [...p], cifSite: null })),
    cifErrors: null,
  };
  return { s, restored: state.cifErrors ? restoreCifErrors(s, state.cifErrors) : false };
}

const close = (a, b) => (a == null || b == null ? a === b : Math.abs(a - b) <= 1e-4 * Math.max(Math.abs(b), 1e-6));

/** Every atom's site and rotation, and the s.u.s the app shows, agree. */
function assertSameErrors(got, want) {
  assert.equal(got.atoms.length, want.atoms.length);
  got.atoms.forEach((atom, i) => {
    const ref = want.atoms[i].cifSite;
    assert.equal(atom.cifSite?.site, ref?.site, `atom ${i} site`);
    assert.deepEqual(atom.cifSite?.R, ref?.R, `atom ${i} rotation`);
    assert.ok(atomCifSite(got, i), `atom ${i} is still where the CIF put it`);
    fracCoordinateSus(got, i).forEach((v, k) => assert.ok(close(v, fracCoordinateSus(want, i)[k]), `atom ${i} s.u. ${k}`));
  });
  cellParameterSus(got).forEach((v, k) => assert.ok(close(v, cellParameterSus(want)[k]), `cell s.u. ${k}`));
  const at = (s, i) => ({ atomIndex: i, frac: s.atoms[i].position });
  const n = got.atoms.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const k = (i + 2) % n;
    const d = [distanceSu(got, at(got, i), at(got, j)), distanceSu(want, at(want, i), at(want, j))];
    assert.ok(d[1] > 0 && close(d[0], d[1]), `distance ${i}-${j}: ${d}`);
    const g = [angleSu(got, at(got, i), at(got, j), at(got, k)), angleSu(want, at(want, i), at(want, j), at(want, k))];
    assert.ok(close(g[0], g[1]), `angle ${i}-${j}-${k}: ${g}`);
  }
}

for (const [name, text] of [['quartz', QUARTZ_CIF], ['I2N3', I2N3_CIF]]) {
  test(`${name}: the errors travel with the link and come back on the same atoms`, async () => {
    const s = await readCif(text);
    const state = stateOf(s);
    const obj = encodeCompact(state);
    assert.ok(obj.er, 'the link carries them');
    const out = expandCompact(JSON.parse(JSON.stringify(obj)));
    assert.equal(out.cifErrors.atoms.length, s.atoms.length);
    assert.deepEqual(out.cifErrors.atoms, state.cifErrors.atoms, 'per atom: site, rotation');
    assert.deepEqual(out.cifErrors.rotations, state.cifErrors.rotations);
    assert.deepEqual(out.cifErrors.cell.values, state.cifErrors.cell.values, 'the file\'s cell, exactly');
    const { s: back, restored } = opened(out);
    assert.ok(restored);
    assertSameErrors(back, s);
  });
}

test('no errors, no bytes: a link without them is unchanged, and an older link opens without them', () => {
  const { state } = load('nacl.json');
  const plain = encodeCompact(clone(state));
  assert.equal(plain.er, undefined);
  assert.equal(JSON.stringify(encodeCompact({ ...clone(state), cifErrors: null })), JSON.stringify(plain));
  assert.equal(roundTrip(clone(state)).cifErrors, undefined);
});

test('the cost of the errors in a link (copy-link characters)', async () => {
  const s = await readCif(QUARTZ_CIF);
  const state = stateOf(s);
  const withErrors = linkFor(encodeCompact(state)).length;
  const without = linkFor(encodeCompact({ ...state, cifErrors: null })).length;
  // Measured when the block landed: 319 -> 479 characters.
  assert.ok(withErrors - without <= 176, `quartz: ${without} -> ${withErrors} characters`);
});

test('a supercell link writes the base cell\'s errors once, and every copy gets them back', async () => {
  const s = supercellOf(await readCif(QUARTZ_CIF), [3, 3, 3]);
  const state = stateOf(s);
  const supercell = { nx: 3, ny: 3, nz: 3 };
  const obj = encodeCompact(state, { supercell });
  assert.deepEqual(obj.s.x, [3, 3, 3]);
  assert.equal(obj.er.a.length, 9, 'the base cell\'s atoms only');
  assert.equal(obj.er.T.length, 9);
  const out = expandCompact(JSON.parse(JSON.stringify(obj)));
  assert.deepEqual(out.cifErrors.atoms, state.cifErrors.atoms);
  assert.deepEqual(out.cifErrors.toCif, [[3, 0, 0], [0, 3, 0], [0, 0, 3]]);
  const { s: back, restored } = opened(out);
  assert.ok(restored);
  assertSameErrors(back, s);
  const unit = stateOf(await readCif(QUARTZ_CIF));
  const cost = (st, options) => linkFor(encodeCompact(st, options)).length - linkFor(encodeCompact({ ...st, cifErrors: null }, options)).length;
  assert.ok(cost(state, { supercell }) <= cost(unit) + 30, 'the errors do not grow with the multipliers');

  // An atom without an error (moved, say) breaks the tiling of the errors:
  // the full list, still on the same atoms.
  const moved = clone(state);
  moved.cifErrors.atoms[40] = null;
  const full = encodeCompact(moved, { supercell });
  assert.deepEqual(full.s.x, [3, 3, 3]);
  assert.equal(full.er.a.length, s.atoms.length);
  assert.deepEqual(expandCompact(JSON.parse(JSON.stringify(full))).cifErrors.atoms, moved.cifErrors.atoms);
});

test('an atom nudged within its s.u. keeps its offset; one moved away has no error', async () => {
  const s = await readCif(QUARTZ_CIF);
  s.atoms[1].position = s.atoms[1].position.map((v, k) => (k === 0 ? v + 0.0001 : v));
  s.atoms[2].position = s.atoms[2].position.map((v, k) => (k === 0 ? v + 0.05 : v));
  const state = stateOf(s);
  assert.equal(state.cifErrors.atoms[1].length, 5, 'the record has the offset');
  assert.equal(state.cifErrors.atoms[2], null, 'and no error for the moved atom');
  const obj = encodeCompact(state);
  assert.equal(obj.er.a[2], 0);
  assert.ok(obj.er.o[1], 'the offset travels');
  const out = expandCompact(JSON.parse(JSON.stringify(obj)));
  assert.deepEqual(out.cifErrors.atoms, state.cifErrors.atoms);
  const { s: back } = opened(out);
  assert.equal(atomCifSite(back, 2), null);
  assert.ok(atomCifSite(back, 1));
  fracCoordinateSus(back, 1).forEach((v, k) => assert.ok(close(v, fracCoordinateSus(s, 1)[k])));
});

test('a database link whose entry changed drops the errors with the other per-atom data', async () => {
  const s = await readCif(QUARTZ_CIF);
  const state = stateOf(s);
  const reference = { kind: 'alexandria', id: 'agm000000000', fingerprint: geometryFingerprint(state.structure) };
  const obj = JSON.parse(JSON.stringify(encodeCompact(state, { reference })));
  assert.ok(obj.r && obj.er);
  assert.ok(expandCompact(obj, { referenceStructure: state.structure }).cifErrors);
  const changed = clone(state.structure);
  changed.positions[0][2] += 0.01;
  assert.equal(expandCompact(obj, { referenceStructure: changed }).cifErrors, undefined);
});

test('a record that would make a block the decoder refuses is left out; the link still opens', async () => {
  const state = stateOf(await readCif(QUARTZ_CIF));
  const broken = [
    (s) => { s.cifErrors.cell.values[0] = NaN; },
    (s) => { s.cifErrors.rotations = null; },
    (s) => { s.cifErrors.atoms[0] = [99, 0]; },
  ];
  for (const breakIt of broken) {
    const s = clone(state);
    breakIt(s);
    const obj = encodeCompact(s);
    assert.equal(obj.er, undefined, String(breakIt));
    assert.equal(expandCompact(JSON.parse(JSON.stringify(obj))).structure.positions.length, 9);
  }
});

test('bad CIF error blocks are refused', async () => {
  const good = JSON.parse(JSON.stringify(encodeCompact(stateOf(await readCif(I2N3_CIF)))));
  const bad = [
    (o) => { o.er = [1, 2]; },
    (o) => { o.er.c.pop(); },
    (o) => { o.er.c[0] = 'x'; },
    (o) => { o.er.c[7] = -1; }, // a negative s.u.
    (o) => { o.er.d = [[1, 0, 0]]; },
    (o) => { o.er.s = []; },
    (o) => { o.er.s[0] = [1, 0, 0, 0, 0, 0, 0]; }, // label not a string
    (o) => { o.er.s[0][0] = 'x'.repeat(1000); },
    (o) => { o.er.s[2][7] = [[0, 0, 1, NaN]]; },
    (o) => { o.er.R[0] = '+0+0'; },
    (o) => { o.er.R[0] = [1, 0, 0]; },
    (o) => { o.er.a.push(1); }, // more entries than atoms
    (o) => { o.er.a[0] = 999; }, // no such site or rotation
    (o) => { o.er.a[0] = 1.5; },
    (o) => { o.er.o = { 99: [0, 0, 0] }; },
    (o) => { o.er.o = { 0: [0, 0] }; },
    (o) => { o.er.T = [1, 0, 0]; },
  ];
  for (const breakIt of bad) {
    const o = clone(good);
    breakIt(o);
    assert.throws(() => expandCompact(o), /Share link/, String(breakIt));
  }
  // Prototype keys cannot sneak in through the offsets.
  const o = clone(good);
  o.er.o = JSON.parse('{"__proto__": [0, 0, 0]}');
  assert.throws(() => expandCompact(o), /Share link/);
});
