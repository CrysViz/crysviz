// Host command registry (docs/host/commands.js) and its description file
// (docs/host/commands.json), which the Python MCP server reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_HANDLERS, viewDirection } from '../../docs/host/commands.js';

const spec = JSON.parse(readFileSync(new URL('../../docs/host/commands.json', import.meta.url), 'utf8'));

test('commands.json describes exactly the registered handlers', () => {
  assert.deepEqual(spec.commands.map((c) => c.name).sort(), Object.keys(COMMAND_HANDLERS).sort());
});

test('every command has a known tier, a description and an object args schema', () => {
  for (const command of spec.commands) {
    assert.ok(Object.hasOwn(spec.tiers, command.tier), `${command.name} tier`);
    assert.ok(command.description.length > 10, `${command.name} description`);
    assert.equal(command.args.type, 'object', `${command.name} args`);
    assert.equal(command.args.additionalProperties, false, `${command.name} args`);
    for (const required of command.args.required || []) {
      assert.ok(Object.hasOwn(command.args.properties, required), `${command.name}.${required}`);
    }
  }
});

const LATTICE = [[2, 0, 0], [1, 3, 0], [0, 0, 5]];

test('set_view directions: world axes, lattice vectors and [uvw]', () => {
  assert.deepEqual(viewDirection('z', undefined), [0, 0, 1]);
  assert.deepEqual(viewDirection('a', LATTICE), [2, 0, 0]);
  assert.deepEqual(viewDirection('b', LATTICE), [1, 3, 0]);
  assert.deepEqual(viewDirection('c', LATTICE), [0, 0, 5]);
  assert.deepEqual(viewDirection([1, 1, 0], LATTICE), [3, 3, 0]);
  assert.deepEqual(viewDirection([0, 0, -1], LATTICE), [0, 0, -5]);
});

test('set_view rejects bad directions and lattice directions without a lattice', () => {
  const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };
  assert.equal(code(() => viewDirection('d', LATTICE)), 'INVALID_ARGS');
  assert.equal(code(() => viewDirection([1, 0], LATTICE)), 'INVALID_ARGS');
  assert.equal(code(() => viewDirection([1, NaN, 0], LATTICE)), 'INVALID_ARGS');
  assert.equal(code(() => viewDirection([0, 0, 0], LATTICE)), 'INVALID_ARGS');
  assert.equal(code(() => viewDirection('c', undefined)), 'NO_LATTICE');
});

test('get_state lattice parameters and composition', async () => {
  const { latticeParameters, composition } = await import('../../docs/host/commands.js');
  const graphite = [[2.464, 0, 0], [-1.232, 2.133886, 0], [0, 0, 6.711]];
  const p = latticeParameters(graphite);
  assert.ok(Math.abs(p.a - 2.464) < 1e-4 && Math.abs(p.b - 2.464) < 1e-4 && p.c === 6.711);
  assert.ok(Math.abs(p.gamma - 120) < 1e-3 && p.alpha === 90 && p.beta === 90);
  const atom = (element, occupancy = 1) => ({ species: [{ element, occupancy }] });
  assert.deepEqual(composition([atom('C'), atom('C'), atom('C'), atom('C')]), { counts: { C: 4 }, formula: 'C4' });
  assert.deepEqual(composition([atom('Na'), atom('Cl')]), { counts: { Na: 1, Cl: 1 }, formula: 'NaCl' });
});

test('set_view up is made perpendicular to the direction; cartesian arrays pass through', async () => {
  const { screenUp } = await import('../../docs/host/commands.js');
  assert.deepEqual(screenUp([0, 1, 1], [0, 0, 1]), [0, 1, 0]);
  assert.throws(() => screenUp([0, 0, 2], [0, 0, 1]), (e) => e.code === 'INVALID_ARGS');
  assert.deepEqual(viewDirection([0.5, 0.866, 0], LATTICE, { cartesian: true }), [0.5, 0.866, 0]);
  assert.deepEqual(viewDirection('c', LATTICE, { cartesian: true }), [0, 0, 5]);
});

test('get_polyhedra merges periodic images and puts a cage at its corners\' centroid', async () => {
  const { polyhedraSummary } = await import('../../docs/host/commands.js');
  const atom = (element, position) => ({ position, getRepresentativeElement: () => element });
  const structure = {
    lattice: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
    atoms: [atom('Ti', [0.5, 0.5, 0.5]), atom('O', [0.5, 0.5, 0]), atom('O', [0.5, 0, 0.5]), atom('O', [0, 0.5, 0.5])],
    polyhedra: { polyhedra: [
      { type: 'centered', centerIndex: 0, centerElement: 'Ti', vertices: [[2, 2, 0], [2, 2, 4]], vertexSrcList: [1, 1] },
      { type: 'centered', centerIndex: 0, centerElement: 'Ti', vertices: [[6, 2, 0], [6, 2, 4]], vertexSrcList: [1, 1] },
      { type: 'cage', centerIndex: null, vertices: [[2, 2, 0], [2, 0, 2], [0, 2, 2], [2, 2, 4]], vertexSrcList: [1, 2, 3, 1] },
    ] },
  };
  const all = polyhedraSummary(structure, undefined);
  assert.equal(all.length, 2);
  assert.equal(all[0].images, 2);
  assert.deepEqual(all[0].corners, { O: 2 });
  const [cage] = polyhedraSummary(structure, 'cage');
  assert.deepEqual(cage.center, [0.375, 0.375, 0.5]);
  assert.deepEqual(cage.cornerAtoms, [1, 2, 3]);
});

test('get_voids finds the empty perovskite A site of ReO3-type WO3 with its 12 O', async () => {
  const { voidSites } = await import('../../docs/host/commands.js');
  const atom = (element, position) => ({ position, getRepresentativeElement: () => element });
  const structure = {
    lattice: [[3.75, 0, 0], [0, 3.75, 0], [0, 0, 3.75]],
    atoms: [atom('W', [0, 0, 0]), atom('O', [0.5, 0, 0]), atom('O', [0, 0.5, 0]), atom('O', [0, 0, 0.5])],
  };
  const [site] = voidSites(structure, 0.7);
  assert.deepEqual(site.position, [0.5, 0.5, 0.5]);
  assert.ok(Math.abs(site.radius - 3.75 / Math.SQRT2) < 1e-6);
  assert.deepEqual(site.neighbours, { O: 12 });
});
