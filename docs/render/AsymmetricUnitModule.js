// AsymmetricUnitModule.js
//
// Draws the real-space asymmetric unit of the detected space group - the
// "irreducible wedge": the smallest part of the cell from which the symmetry
// operations regenerate the whole thing.
//
// The wedge is ALWAYS expressed in the conventional cell, because that is the
// only cell it is defined in. Its inequalities (`x>=0; x<=1/2; ...`, see
// ui/BackendPanel/asuGeometry.js) are fractional coordinates of the
// conventional setting, so the same numbers against a primitive or a rotated
// cell would describe a different, meaningless region. The Symmetry panel
// therefore hands this module moyo's standardized cell rather than whatever
// cell is on screen, and when the two differ the conventional cell box is
// drawn alongside the wedge so it is visible which frame the wedge belongs to.
//
// The panel owns the crystallography and this module owns the geometry: what
// arrives here is a finished polyhedron in fractional coordinates plus the
// lattice to push it through. Nothing here knows about space groups.
//
// Two limitations, both shared with the rest of the overlay modules and
// neither silent:
//   * The raytrace/pathtrace pipelines enumerate the groups they encode
//     (pipeline/raytrace/SceneEncoder.js) and this is not one of them, so a
//     traced frame omits the wedge. The raster pipelines all draw it.
//   * SVG export has the same enumeration, so it omits the wedge too.

import * as THREE from '../external/three/three.module.js';

import { app, groups, fileBrowser, general } from '../state/store.js';
import { disposeGroup } from '../ui/WindowAndSceneControls.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { fracToCartPoint } from '../math/index.js';

/** Face opacity of the wedge hull. Low enough to read the atoms through it. */
const FACE_OPACITY = 0.22;

/** Wedge outline radius in world units (A). Deliberately a shade THICKER than
 *  the cell lines' 0.015 default: at 22% alpha the hull alone barely registers
 *  against a dense structure, and the outline is what carries the shape. */
const EDGE_RADIUS = 0.02;

/** Conventional cell box radius — thinner; it is context, not subject. */
const CELL_RADIUS = 0.01;

/** Opacity of that context box. */
const CELL_OPACITY = 0.5;

/** Fallback if a theme somehow supplies no --asu-color. */
const FALLBACK_COLOR = 0xa05cd6;

/** Per-component lattice agreement below which two cells count as the same. */
const LATTICE_TOL = 1e-6;

// What to draw, or null for nothing. Set by showAsymmetricUnit() and read back
// by every rebuild, so the wedge survives the redraws that structure edits,
// theme switches and camera-driven refreshes trigger.
//
// `structure` is the structure the wedge was computed FOR. Holding the
// reference is what makes staleness detectable: a wedge belongs to one
// structure's space group, and switching structures (or frames) must drop it
// rather than leave a wedge from the previous cell floating in the scene.
let wedge = null;

function resolveColor() {
  const color = general.asuColor;
  return color ? new THREE.Color(color) : new THREE.Color(FALLBACK_COLOR);
}

/** Whether two row-major 3x3 lattices agree component-wise. */
function latticesMatch(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (Math.abs((a[i]?.[j] ?? NaN) - (b[i]?.[j] ?? NaN)) > LATTICE_TOL) return false;
    }
  }
  return true;
}

const UP = new THREE.Vector3(0, 1, 0);

// One line segment as a thin cylinder. Same reason as the cell outline's
// (LatticeModule.createLatticeLines): WebGL ignores LineBasicMaterial.linewidth,
// so a hairline is the only width THREE.Line can ever draw.
function addSegment(group, from, to, radius, material) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  if (!(length > 0)) return;

  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 8),
    material,
  );
  cylinder.position.copy(from).addScaledVector(direction, 0.5);
  cylinder.quaternion.setFromUnitVectors(UP, direction.normalize());
  group.add(cylinder);
}

// The 12 edges of a cell box, in world coordinates.
function addCellBox(group, lattice, radius, material) {
  const corner = (i, j, k) => new THREE.Vector3(
    ...fracToCartPoint([i, j, k], lattice)
  );
  const v = [
    corner(0, 0, 0), corner(1, 0, 0), corner(0, 1, 0), corner(0, 0, 1),
    corner(1, 1, 0), corner(1, 0, 1), corner(0, 1, 1), corner(1, 1, 1),
  ];
  const edges = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4],
    [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7],
  ];
  for (const [a, b] of edges) addSegment(group, v[a], v[b], radius, material);
}

function buildWedgeGroup() {
  const { polyhedron, lattice, showCellBox } = wedge;
  const group = new THREE.Group();
  const color = resolveColor();

  // Fractional -> Cartesian happens once, here. Everything upstream
  // (asuGeometry.js) works in fractional coordinates on purpose.
  const cart = polyhedron.vertices.map((v) => fracToCartPoint(v, lattice));

  // --- hull ---------------------------------------------------------------
  const positions = new Float32Array(polyhedron.triangles.length * 9);
  let at = 0;
  for (const triangle of polyhedron.triangles) {
    for (const index of triangle) {
      positions[at] = cart[index][0];
      positions[at + 1] = cart[index][1];
      positions[at + 2] = cart[index][2];
      at += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // The triangles are wound outward (asuGeometry.js orders every face loop
  // counter-clockwise as seen from outside), so per-face normals come out
  // pointing the right way and the hull shades as a solid.
  geometry.computeVertexNormals();

  const faceMaterial = new THREE.MeshStandardMaterial({
    color,
    opacity: FACE_OPACITY,
    // A wedge on a cell face is coplanar with atoms and bonds sitting exactly
    // on that face, and DoubleSide keeps the inward faces blending too — the
    // camera is inside the wedge as often as not.
    side: THREE.DoubleSide,
    roughness: 0.55,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, faceMaterial);
  // Never set transparency flags here: intent is declared, and the active
  // pipeline decides the flags (utils/TransparencyPolicy.js).
  applyTransparency(faceMaterial, { kind: 'asuFace', opacity: FACE_OPACITY, mesh });
  group.add(mesh);

  // --- outline ------------------------------------------------------------
  // The hull alone is ambiguous at 22% alpha; the outline is what makes the
  // wedge's shape readable, and it is the part that survives a screenshot.
  const edgeMaterial = new THREE.MeshBasicMaterial({ color });
  applyTransparency(edgeMaterial, { kind: 'asuEdge', opacity: 1 });
  for (const [a, b] of polyhedron.edges) {
    addSegment(
      group,
      new THREE.Vector3(...cart[a]),
      new THREE.Vector3(...cart[b]),
      EDGE_RADIUS,
      edgeMaterial,
    );
  }

  // --- conventional cell, when it is not the cell on screen ---------------
  // Without this the wedge would be a shape floating in a cell it does not
  // belong to, with nothing on screen to say so.
  if (showCellBox) {
    const cellMaterial = new THREE.MeshBasicMaterial({
      color,
      opacity: CELL_OPACITY,
    });
    applyTransparency(cellMaterial, { kind: 'asuEdge', opacity: CELL_OPACITY });
    addCellBox(group, lattice, CELL_RADIUS, cellMaterial);
  }

  return group;
}

/**
 * Draw the wedge. Replaces whatever was drawn before.
 *
 * @param {object} options
 * @param {{vertices: number[][], triangles: number[][], edges: number[][]}}
 *   options.polyhedron wedge in fractional coordinates (asuGeometry.js)
 * @param {number[][]} options.lattice row-major conventional lattice, the one
 *   the polyhedron's fractional coordinates are expressed in
 * @param {object} options.structure the structure this wedge was computed for;
 *   the wedge is dropped once that is no longer the selected structure
 */
export function showAsymmetricUnit({ polyhedron, lattice, structure }) {
  wedge = {
    polyhedron,
    lattice: lattice.map((row) => [...row]),
    structure,
    // Answered once, at the moment the user asked for the wedge, against the
    // cell that was on screen then.
    showCellBox: !latticesMatch(lattice, structure?.lattice),
  };
  updateAsymmetricUnit();
}

/** Stop drawing the wedge. */
export function hideAsymmetricUnit() {
  wedge = null;
  updateAsymmetricUnit();
}

/** Whether a wedge is currently drawn for the selected structure. */
export function isAsymmetricUnitVisible() {
  return !!wedge && wedge.structure === fileBrowser.selectedStructure;
}

/**
 * Whether the drawn wedge needed its own conventional cell box — i.e. the
 * conventional cell is not the cell on screen. The panel says so in words.
 */
export function asymmetricUnitNeedsCellBox() {
  return !!wedge?.showCellBox;
}

/**
 * Rebuild the wedge group from the stored state. Called from
 * updateVisualization (so the wedge survives every redraw) and on theme change
 * (so it picks up a new --asu-color).
 */
export function updateAsymmetricUnit() {
  disposeGroup(groups.asuGroup);
  groups.asuGroup = null;

  // A wedge describes one structure's space group in one cell. Once the
  // selection has moved on it is not "out of date", it is wrong — so it goes,
  // rather than being redrawn against a cell it was never computed for.
  if (wedge && wedge.structure !== fileBrowser.selectedStructure) wedge = null;
  if (!wedge || !app?.scene) return;

  groups.asuGroup = buildWedgeGroup();
  app.scene.add(groups.asuGroup);
}
