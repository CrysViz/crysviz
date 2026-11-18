// render/groundDirection.js: which side of the structure the ground lies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../docs/external/three/three.module.js';
import {
  groundNormal, cleanGroundDirection, groundFollowsView, GROUND_DIRECTIONS,
} from '../../docs/render/groundDirection.js';

const near = (v, want, tol = 1e-9) => assert.ok(
  Math.abs(v.x - want[0]) < tol && Math.abs(v.y - want[1]) < tol && Math.abs(v.z - want[2]) < tol,
  `${v.toArray()} ≠ ${want}`);

test('unknown or missing directions are the original below-along-−y', () => {
  assert.equal(cleanGroundDirection(undefined), 'down');
  assert.equal(cleanGroundDirection('sideways'), 'down');
  assert.equal(cleanGroundDirection('-c'), '-c');
  near(groundNormal('down'), [0, 1, 0]);
  near(groundNormal('bogus'), [0, 1, 0]);
  assert.ok(GROUND_DIRECTIONS.every(([v, label]) => typeof v === 'string' && label.length > 0));
});

test('world sides: the normal points from the ground towards the structure', () => {
  near(groundNormal('+y'), [0, -1, 0]);
  near(groundNormal('-x'), [1, 0, 0]);
  near(groundNormal('+x'), [-1, 0, 0]);
  near(groundNormal('-z'), [0, 0, 1]);
  near(groundNormal('+z'), [0, 0, -1]);
});

test('crystal sides lie parallel to the plane of the other two vectors', () => {
  const hex = [[1, 0, 0], [-0.5, Math.sqrt(3) / 2, 0], [0, 0, 2]];
  near(groundNormal('-c', null, hex), [0, 0, 1]);
  near(groundNormal('+c', null, hex), [0, 0, -1]);
  const na = groundNormal('-a', null, hex);
  // perpendicular to b and c, on a's side
  assert.ok(Math.abs(na.dot(new THREE.Vector3(...hex[1]))) < 1e-9 && Math.abs(na.dot(new THREE.Vector3(...hex[2]))) < 1e-9);
  assert.ok(na.dot(new THREE.Vector3(...hex[0])) > 0);
  near(na, [Math.sqrt(3) / 2, 0.5, 0], 1e-9);
  const nb = groundNormal('+b', null, hex);
  assert.ok(nb.dot(new THREE.Vector3(...hex[1])) < 0, '+b: the ground on b\'s far side');
  // a left-handed cell still puts '-c' under c
  near(groundNormal('-c', null, [[1, 0, 0], [0, 1, 0], [0, 0, -3]]), [0, 0, -1]);
  // no usable lattice: the default
  near(groundNormal('-c', null, [[1, 0, 0], [2, 0, 0], [0, 0, 1]]), [0, 1, 0]);
  near(groundNormal('-c', null, null), [0, 1, 0]);
});

test('view sides follow the camera: below = its up, behind = towards it', () => {
  assert.ok(groundFollowsView('view-below') && groundFollowsView('view-behind') && !groundFollowsView('-c'));
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  near(groundNormal('view-below', camera), [0, 1, 0], 1e-6);
  near(groundNormal('view-behind', camera), [0, 0, 1], 1e-6);
  camera.position.set(10, 0, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  near(groundNormal('view-below', camera), [0, 0, 1], 1e-6);
  near(groundNormal('view-behind', camera), [1, 0, 0], 1e-6);
});
