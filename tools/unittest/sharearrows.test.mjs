// Share links carry the force and spin arrows of the shared structure and the
// colour bars' layout (docs/io/share/shareCodec.js encodeArrows/decodeArrows,
// shareBaselines.js baseline 5). Links are untrusted: bad arrow blocks are
// refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCompact, expandCompact } from '../../docs/io/share/shareCodec.js';
import { BASELINES, LATEST_BASELINE_ID } from '../../docs/io/share/shareBaselines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'share', name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const roundTrip = (state, options) => expandCompact(JSON.parse(JSON.stringify(encodeCompact(state, options))));

function withArrows() {
  const { state } = load('nacl.json');
  const s = clone(state);
  const n = s.structure.positions.length;
  s.structure.forces = s.structure.positions.map((_, i) => ({ vector: [0.0123456 * (i + 1), -1.5, 3e-4], scaling: 1 }));
  s.structure.forces[1].hidden = true;
  s.structure.forces[2].color = '#ff0000';
  s.structure.spins = s.structure.positions.map((_, i) => ({ vector: [0, 0, i % 2 ? 2.5 : -2.5], scaling: 1, atomIndex: i, element: s.structure.elements[i] }));
  return { s, n };
}

test('forces and spins round-trip with the structure, compactly', () => {
  const { s, n } = withArrows();
  const obj = encodeCompact(s);
  assert.equal(obj.fv.v.length, 3 * n);
  assert.equal(obj.fv.s, 1, 'the shared scaling once');
  assert.deepEqual(obj.fv.x, { 1: { h: 1 }, 2: { c: '#ff0000' } }, 'only the arrows with extras');
  assert.equal(obj.nv.x, undefined, 'a spin on its own atom carries no index');
  const out = expandCompact(JSON.parse(JSON.stringify(obj))).structure;
  assert.equal(out.forces.length, n);
  assert.deepEqual(out.forces[0].vector, [0.012346, -1.5, 0.0003], '5 significant digits');
  assert.equal(out.forces[0].scaling, 1);
  assert.equal(out.forces[1].hidden, true);
  assert.equal(out.forces[2].color, '#ff0000');
  assert.deepEqual(out.spins[1].vector, [0, 0, 2.5]);
  assert.equal(out.spins[1].atomIndex, undefined);
});

test('a manually placed spin keeps its atom; no arrows, no block', () => {
  const { state } = load('nacl.json');
  const s = clone(state);
  s.structure.spins = [{ vector: [1, 0, 0], atomIndex: 3 }];
  const obj = encodeCompact(s);
  assert.deepEqual(obj.nv.x, { 0: { i: 3 } });
  assert.equal(expandCompact(JSON.parse(JSON.stringify(obj))).structure.spins[0].atomIndex, 3);
  assert.equal(encodeCompact(clone(state)).fv, undefined);
  assert.equal(roundTrip(clone(state)).structure.forces, undefined);
});

test('forces of a supercell link line up with the tiled atoms', () => {
  const { state, supercell } = load('nacl-supercell-222.json');
  const s = clone(state);
  const n = s.structure.positions.length;
  s.structure.forces = s.structure.positions.map((_, i) => ({ vector: [i, 0, 0] }));
  const out = roundTrip(s, { supercell });
  assert.equal(out.structure.positions.length, n);
  assert.deepEqual(out.structure.forces.map((f) => f.vector[0]), s.structure.forces.map((f) => f.vector[0]));
});

test('bad arrow blocks are refused', () => {
  const { s } = withArrows();
  const good = JSON.parse(JSON.stringify(encodeCompact(s)));
  const bad = [
    (o) => { o.fv.v.push(1, 2, 3); }, // more arrows than atoms
    (o) => { o.fv.v[0] = 'x'; },
    (o) => { o.fv.v.pop(); }, // not a multiple of 3
    (o) => { o.fv.x = { 999: { h: 1 } }; },
    (o) => { o.fv.x = { 0: { c: 'javascript:alert(1)' } }; },
    (o) => { o.nv.x = { 0: { i: 1e9 } }; },
    (o) => { o.fv = [1, 2, 3]; },
  ];
  for (const breakIt of bad) {
    const o = clone(good);
    breakIt(o);
    assert.throws(() => expandCompact(o), /Share link/, String(breakIt));
  }
});

test('colour-bar settings go through the short keys; the defaults write nothing', () => {
  const { state } = load('nacl.json');
  const s = clone(state);
  assert.equal(LATEST_BASELINE_ID, 5);
  for (const [k, v] of Object.entries(BASELINES[5].display)) if (/ColorBar|LegendText|colorBarSize|Color(Min|Max|Scale|Map)$/.test(k)) s.display[k] = v;
  assert.equal(encodeCompact(s).o, undefined, 'baseline values are not written');
  Object.assign(s.display, {
    forceColorBarOrientation: 'vertical', forceColorBarFlipSide: true, forceLegendText: 'F<sub>x</sub> (eV/Å)',
    forceColorBarFloating: true, forceColorBarFloatAt: { x: 24, y: 310, r: 1, b: 0 }, forceColorBarLocked: true,
    colorBarSize: 420, bondColorMin: 1.4, bondColorMax: 2.2, bondColorScale: 'log', bondColorMap: 'viridis',
  });
  const obj = encodeCompact(s);
  assert.deepEqual(Object.keys(obj.o).sort(), ['b0', 'b7', 'b8', 'b9', 'bz', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  const d = expandCompact(JSON.parse(JSON.stringify(obj))).display;
  assert.equal(d.forceColorBarOrientation, 'vertical');
  assert.equal(d.forceLegendText, 'F<sub>x</sub> (eV/Å)');
  assert.deepEqual(d.forceColorBarFloatAt, { x: 24, y: 310, r: 1, b: 0 });
  assert.equal(d.forceColorBarLocked, true);
  assert.equal(d.colorBarSize, 420);
  assert.equal(d.bondColorScale, 'log');
  assert.equal(d.spinColorBarOrientation, 'horizontal', 'others from the baseline');
  const broken = clone(obj);
  broken.o.f5 = { x: 'left' };
  assert.throws(() => expandCompact(broken), /Share link/, 'a non-numeric floating position is refused');
});

test('an older link (baseline 4, made before these settings) still expands', () => {
  const { state } = load('nacl.json');
  const old = clone(state);
  for (const sect of ['colors', 'display', 'style']) {
    for (const k of Object.keys(old[sect] ?? {})) if (!(k in BASELINES[4][sect]) && k in BASELINES[5][sect]) delete old[sect][k];
  }
  const obj = encodeCompact(old, { baselineId: 4 });
  const d = expandCompact(JSON.parse(JSON.stringify(obj))).display;
  assert.equal(d.forceColorBarOrientation, undefined, 'absent: the recipient keeps its own');
});

test('a link never carries planes or the Planes bar, not even through X', () => {
  const { state } = load('nacl.json');
  const obj = encodeCompact(clone(state));
  obj.X = { 'display.planes': [{ params: { type: 'hkl', h: 1, k: 0, l: 0 } }], 'display.planeColorBarOrientation': 'vertical' };
  const d = expandCompact(JSON.parse(JSON.stringify(obj))).display;
  assert.equal(d.planes, undefined);
  assert.equal(d.planeColorBarOrientation, undefined);
});
