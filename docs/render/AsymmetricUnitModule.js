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
// symmetrises to the conventional cell before asking for a wedge, so the two
// are normally the same frame; the conventional cell box below is the fallback
// for when they are not.
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
import { containsFractional, CONTAINS_TOLERANCE } from '../ui/BackendPanel/asuGeometry.js';
import { getCutPlaneMaskSign } from '../model/Plane.js';
import { MAX_CUT_PLANES } from './MaterialStyles.js';
import { fracToCartPoint, invert3x3, transpose3x3 } from '../math/index.js';
import { setAsuHighlightRefresh } from './asuHighlightHook.js';

/** Fired when the module drops a wedge by itself, so the panel can re-sync. */
export const ASU_DROPPED_EVENT = 'crysviz:asu-dropped';

/** Wedge face opacity when `general.asuOpacity` is unset or nonsense. */
const DEFAULT_OPACITY = 0.22;

/** Wedge outline radius in world units (A). Deliberately a shade THICKER than
 *  the cell lines' 0.015 default: at low alpha the hull barely registers
 *  against a dense structure, and the outline is what carries the shape. */
const EDGE_RADIUS = 0.02;

/** Conventional cell box radius — thinner; it is context, not subject. */
const CELL_RADIUS = 0.01;

/** Opacity of that context box. */
const CELL_OPACITY = 0.5;

/** Halo shell radius as a multiple of the atom's own drawn radius. */
const HALO_SCALE = 1.22;

/** Halo opacity. Near-opaque: it is a ring, not a veil. */
const HALO_OPACITY = 0.85;

/** Atoms drawn fainter than this (focus regions, per-atom alpha) get no ring. */
const HALO_MIN_ATOM_OPACITY = 0.5;

/** Fallback if a theme somehow supplies no --asu-color. */
const FALLBACK_COLOR = '#a05cd6';

/** Per-component lattice agreement below which two cells count as the same. */
const LATTICE_TOL = 1e-6;

// What to draw, or null for nothing. Set by showAsymmetricUnit() and read back
// by every rebuild, so the wedge survives the redraws that structure edits,
// theme switches and camera-driven refreshes trigger.
//
// `structure` is the structure the wedge was computed FOR, and `cell` its
// lattice at that moment. Switching structures drops the wedge. Trajectory
// frames, EOS points and lattice edits reuse the same object, so a changed
// `cell` is what catches those (see reconcileCell).
let wedge = null;

// The hull, kept to hand so a slider drag can retint or re-alpha it without
// rebuilding any geometry.
let hullMesh = null;

// Atom highlight state. Off by default and never computed while off — see
// updateAsuAtomHighlight.
let highlightAtoms = false;
let inWedgeAtoms = 0;
let inWedgeInstances = 0;

// Reusable "have I already counted this source atom" flags, so counting
// distinct atoms across periodic images costs no allocation per frame.
let seenSource = new Uint8Array(0);

function colorValue() {
  return general.asuColor || FALLBACK_COLOR;
}

function opacityValue() {
  const value = Number(general.asuOpacity);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_OPACITY;
}

/**
 * Whether two row-major 3x3 lattices agree component-wise.
 *
 * Exported because the panel has to ask the same question before it draws:
 * a conventional cell that is not the cell on screen means the structure
 * needs symmetrising first (see MoyoWASM.js), and both sides of that decision
 * must use one tolerance.
 *
 * @param {number[][]} a
 * @param {number[][]} b
 * @returns {boolean}
 */
export function latticesMatch(a, b) {
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
  const color = new THREE.Color(colorValue());
  const opacity = opacityValue();

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
    opacity,
    // A wedge on a cell face is coplanar with atoms and bonds sitting exactly
    // on that face, and DoubleSide keeps the inward faces blending too — the
    // camera is inside the wedge as often as not.
    side: THREE.DoubleSide,
    roughness: 0.55,
    metalness: 0,
  });
  hullMesh = new THREE.Mesh(geometry, faceMaterial);
  // Never set transparency flags here: intent is declared, and the active
  // pipeline decides the flags (utils/TransparencyPolicy.js).
  applyTransparency(faceMaterial, { kind: 'asuFace', opacity, mesh: hullMesh });
  group.add(hullMesh);

  // --- outline ------------------------------------------------------------
  // The hull alone is ambiguous at low alpha; the outline is what makes the
  // wedge's shape readable, and it is what survives the opacity slider going
  // to zero.
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
  // The panel symmetrises first, so this is a fallback rather than the normal
  // path: without it a wedge drawn against some other cell would look
  // misplaced instead of merely elsewhere.
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
 * @param {Array<{normal: number[], offset: number}>} options.halfSpaces the
 *   same wedge as inequalities, used to test whether an atom is inside it
 * @param {number[][]} options.lattice row-major conventional lattice, the one
 *   the polyhedron's fractional coordinates are expressed in
 * @param {object} options.structure the structure this wedge was computed for;
 *   the wedge is dropped once that is no longer the selected structure
 */
export function showAsymmetricUnit({ polyhedron, halfSpaces, lattice, structure }) {
  // Fractional bounding box, used to bound the lattice-translation search in
  // updateAsuAtomHighlight. Cheap to keep, and it makes that search exact
  // rather than a guessed +/-1 shell.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const vertex of polyhedron.vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (vertex[axis] < lo[axis]) lo[axis] = vertex[axis];
      if (vertex[axis] > hi[axis]) hi[axis] = vertex[axis];
    }
  }

  wedge = {
    polyhedron,
    halfSpaces,
    lo,
    hi,
    lattice: lattice.map((row) => [...row]),
    structure,
    cell: structure?.lattice?.map((row) => [...row]) ?? null,
    // Answered once, at the moment the user asked for the wedge, against the
    // cell that was on screen then.
    showCellBox: !latticesMatch(lattice, structure?.lattice),
  };
  updateAsymmetricUnit();
}

// The Wyckoff editor strains the cell without breaking the symmetry, so the
// fractional wedge follows the new lattice there. Any other cell change
// (variable-cell frame, supercell, vacuum, transform) invalidates it.
function reconcileCell() {
  const lattice = wedge?.structure?.lattice;
  if (!wedge || latticesMatch(wedge.cell, lattice)) return;
  if (!wedge.showCellBox && wedge.structure.symmetry?.mode === 'wyckoff') {
    wedge.lattice = lattice.map((row) => [...row]);
    wedge.cell = lattice.map((row) => [...row]);
  } else {
    wedge = null;
  }
}

/** Rebuild the wedge only if its cell has changed. Cheap enough per frame. */
export function refreshAsymmetricUnitIfStale() {
  if (wedge && !latticesMatch(wedge.cell, wedge.structure?.lattice)) updateAsymmetricUnit();
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
 * Re-apply colour and opacity to what is already drawn, without rebuilding any
 * geometry. This is the path a colour-picker change or an opacity-slider drag
 * takes: the shape has not moved, only its paint, and a drag emits a change
 * per pixel of travel.
 */
export function refreshAsuAppearance() {
  const color = colorValue();
  if (groups.asuGroup) {
    groups.asuGroup.traverse((object) => {
      if (object.material?.color) object.material.color.set(color);
    });
  }
  if (hullMesh) {
    const opacity = opacityValue();
    hullMesh.material.opacity = opacity;
    applyTransparency(hullMesh.material, { kind: 'asuFace', opacity, mesh: hullMesh });
  }
  if (groups.asuHaloMesh) groups.asuHaloMesh.material.color.set(color);
}

// ---------------------------------------------------------------------------
// Atoms inside the wedge
// ---------------------------------------------------------------------------

/** Turn the in-wedge atom highlight on or off. */
export function setAsuAtomHighlight(on) {
  highlightAtoms = !!on;
  updateAsuAtomHighlight();
}

/** Whether the in-wedge atom highlight is on. */
export function isAsuAtomHighlightOn() {
  return highlightAtoms;
}

/**
 * How many atoms the last highlight pass found inside the wedge.
 * `atoms` counts distinct atoms, `instances` counts the drawn copies of them
 * (an atom on a cell face is drawn several times, once per periodic image).
 */
export function asuAtomsInside() {
  return { atoms: inWedgeAtoms, instances: inWedgeInstances };
}

function clearHalo() {
  inWedgeAtoms = 0;
  inWedgeInstances = 0;
  const mesh = groups.asuHaloMesh;
  if (!mesh) return;
  app?.scene?.remove(mesh);
  mesh.geometry?.dispose();
  mesh.material?.dispose();
  groups.asuHaloMesh = null;
}

// Reused across frames and only reallocated when it has to grow: MD playback
// refreshes the highlight every frame, and a fresh InstancedMesh per frame
// would be a fresh Float32Array per frame.
function ensureHalo(capacity) {
  const existing = groups.asuHaloMesh;
  if (existing && existing.userData.capacity >= capacity) {
    existing.material.color.set(colorValue());
    return existing;
  }
  clearHalo();

  const material = new THREE.MeshBasicMaterial({
    color: colorValue(),
    // BackSide culls the near half of the shell, leaving the far half — which
    // the atom itself hides except around its silhouette. What is left reads
    // as a ring around the atom rather than a bag over it, and it stays
    // legible whatever colour the atom is.
    side: THREE.BackSide,
    opacity: HALO_OPACITY,
  });
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 16, 12), material, capacity
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.userData.capacity = capacity;
  // `count` is rewritten every pass and the instances move with the atoms, so
  // a bounding sphere computed once would be wrong immediately.
  mesh.frustumCulled = false;
  applyTransparency(material, { kind: 'asuFace', opacity: HALO_OPACITY, mesh });

  groups.asuHaloMesh = mesh;
  app.scene.add(mesh);
  return mesh;
}

/**
 * Ring the atoms that belong to the wedge.
 *
 * Membership is tested MODULO LATTICE TRANSLATION, and that is not a detail:
 * 205 of the 527 tabulated settings have an asymmetric unit that reaches
 * outside the [0,1) box atoms are wrapped into — Fd-3m's origin-choice-2
 * wedge is entirely at y <= 0, for one — so a literal "is this atom's drawn
 * position inside the polyhedron" test would highlight nothing at all for
 * nearly half of all structures. A lattice translation is a symmetry of the
 * crystal, so an atom at y = 0.875 is the same atom as one at y = -0.125, and
 * asking whether ANY of its lattice images lands in the wedge is the question
 * that means something: it identifies the symmetry-independent atoms.
 *
 * The halo is drawn on the atom itself, never on the image that satisfied the
 * test — a ring around an atom says something, a ring around empty space does
 * not.
 *
 * Called from updateVisualization (structure edits, frame changes) and from
 * FastFrameModule (MD/relax playback, which bypasses updateVisualization) so
 * the highlight tracks atoms as they move. Both call it unconditionally: when
 * the toggle is off this returns at the first line, which is the point of
 * having a toggle at all.
 *
 * The work when it IS on is one matrix-vector product per drawn instance plus
 * a handful of dot products per candidate translation — the bounding box keeps
 * that to a couple of translations per axis, and a point-in-wedge test is a
 * question for the inequalities rather than for the mesh, so a cell with
 * thousands of atoms costs well under a millisecond.
 */
export function updateAsuAtomHighlight() {
  if (highlightAtoms) refreshAsymmetricUnitIfStale();
  if (!highlightAtoms || !isAsymmetricUnitVisible()) {
    clearHalo();
    return;
  }

  const structure = fileBrowser.selectedStructure;
  // The array the renderer itself draws from, so every drawn copy is covered
  // and each is ringed where it stands.
  const cart = structure?.periodic?.visibleWrapped?.cart;
  const atomsMesh = groups.atomsMesh;
  if (!cart?.length || !atomsMesh || atomsMesh.visible === false || !app?.scene) {
    clearHalo();
    return;
  }

  const [m0, m1, m2] = invert3x3(transpose3x3(wedge.lattice));
  const source = atomsMesh.instanceMatrix.array;
  const opacity = atomsMesh.geometry?.attributes?.instanceOpacity;
  const immune = atomsMesh.geometry?.attributes?.instanceCutPlaneImmune;
  const cutPlanes = activeCutPlanes();
  const srcIndex = structure.periodic.visibleWrapped.srcIndex;
  const mesh = ensureHalo(cart.length);
  const target = mesh.instanceMatrix.array;

  const atomCount = structure.atoms?.length ?? 0;
  if (seenSource.length < atomCount) seenSource = new Uint8Array(atomCount);
  else seenSource.fill(0, 0, atomCount);

  let drawn = 0;
  let distinct = 0;

  const { lo, hi, halfSpaces } = wedge;

  for (let i = 0; i < cart.length; i += 1) {
    const point = cart[i];
    if (opacity && opacity.getX(i) < HALO_MIN_ATOM_OPACITY) continue;
    if (cutPlanes.length && !(immune?.getX(i) >= 0.5) && isCutAway(point, cutPlanes)) continue;
    const frac = [
      m0[0] * point[0] + m0[1] * point[1] + m0[2] * point[2],
      m1[0] * point[0] + m1[1] * point[1] + m1[2] * point[2],
      m2[0] * point[0] + m2[1] * point[1] + m2[2] * point[2],
    ];

    // Only the translations that could possibly land this atom in the wedge:
    // t must satisfy lo <= frac + t <= hi on every axis.
    //
    // Widened by the tolerance containsFractional itself allows, and that is
    // load-bearing rather than defensive. An atom on a special position sits
    // exactly ON a wedge boundary — that is what makes the position special —
    // so lo - frac lands exactly on an integer, where a float a hair either
    // side of it sends Math.ceil to the neighbouring one and drops the only
    // translation that would have matched. Silently, and for exactly the
    // atoms that matter most.
    let inside = false;
    const txEnd = Math.floor(hi[0] - frac[0] + CONTAINS_TOLERANCE);
    const tyEnd = Math.floor(hi[1] - frac[1] + CONTAINS_TOLERANCE);
    const tzEnd = Math.floor(hi[2] - frac[2] + CONTAINS_TOLERANCE);
    for (let tx = Math.ceil(lo[0] - frac[0] - CONTAINS_TOLERANCE); tx <= txEnd && !inside; tx += 1) {
      for (let ty = Math.ceil(lo[1] - frac[1] - CONTAINS_TOLERANCE); ty <= tyEnd && !inside; ty += 1) {
        for (let tz = Math.ceil(lo[2] - frac[2] - CONTAINS_TOLERANCE); tz <= tzEnd && !inside; tz += 1) {
          inside = containsFractional(
            halfSpaces, frac[0] + tx, frac[1] + ty, frac[2] + tz
          );
        }
      }
    }
    if (!inside) continue;

    // The atom's own drawn radius, straight off its instance matrix, so a halo
    // tracks the size slider and any per-atom scaling for free. Zero means the
    // element is hidden — AtomsFracUpdateModule zero-scales those — and there
    // is nothing there to ring.
    const radius = source[i * 16];
    if (!(radius > 0)) continue;

    const offset = drawn * 16;
    // Pure scale + translation. Every other slot of a fresh InstancedMesh's
    // matrix array is already zero and nothing here ever writes one, so the
    // six touched below are the whole matrix.
    target[offset] = radius * HALO_SCALE;
    target[offset + 5] = radius * HALO_SCALE;
    target[offset + 10] = radius * HALO_SCALE;
    target[offset + 12] = point[0];
    target[offset + 13] = point[1];
    target[offset + 14] = point[2];
    target[offset + 15] = 1;
    drawn += 1;

    const src = srcIndex ? srcIndex[i] : i;
    if (src < atomCount && !seenSource[src]) {
      seenSource[src] = 1;
      distinct += 1;
    }
  }

  mesh.count = drawn;
  mesh.visible = drawn > 0;
  mesh.instanceMatrix.needsUpdate = true;
  inWedgeInstances = drawn;
  inWedgeAtoms = distinct;
}

// Same test the atom shader uses to discard a cut-away atom, so a ring never
// outlives the atom it surrounds.
function activeCutPlanes() {
  const planes = [];
  const enabled = (general.atomCutPlanes || []).filter((plane) => plane?.enabled);
  for (const plane of enabled.slice(0, MAX_CUT_PLANES)) {
    const sign = getCutPlaneMaskSign(plane.side);
    if (!sign) continue;
    const n = [Number(plane.x) || 0, Number(plane.y) || 0, Number(plane.z) || 0];
    const length = Math.hypot(n[0], n[1], n[2]);
    planes.push({
      n: length < 1e-8 ? [1, 0, 0] : n.map((v) => v / length),
      r: Number(plane.r) || 0,
      sign,
    });
  }
  return planes;
}

function isCutAway(point, planes) {
  return planes.some(({ n, r, sign }) =>
    (point[0] * n[0] + point[1] * n[1] + point[2] * n[2] - r) * sign > 0);
}

setAsuHighlightRefresh(updateAsuAtomHighlight);

/**
 * Rebuild the wedge group from the stored state. Called from
 * updateVisualization (so the wedge survives every redraw) and on theme change
 * (so it picks up a new --asu-color).
 */
export function updateAsymmetricUnit() {
  disposeGroup(groups.asuGroup);
  groups.asuGroup = null;
  hullMesh = null;

  // A wedge describes one structure's space group in one cell. Once the
  // selection has moved on it is not "out of date", it is wrong — so it goes,
  // rather than being redrawn against a cell it was never computed for.
  const hadWedge = !!wedge;
  if (wedge && wedge.structure !== fileBrowser.selectedStructure) wedge = null;
  reconcileCell();
  if (hadWedge && !wedge) document.dispatchEvent(new CustomEvent(ASU_DROPPED_EVENT));
  if (!wedge || !app?.scene) {
    clearHalo();
    return;
  }

  groups.asuGroup = buildWedgeGroup();
  app.scene.add(groups.asuGroup);
  updateAsuAtomHighlight();
}

