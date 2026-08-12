import * as THREE from '../external/three/three.module.js';
import { measurements,app, general, fileBrowser, mode, groups} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import { CSS2DObject } from '../external/three/CSS2DRenderer.js';
import { fracToCart } from '../math/index.js';
import { updateAtoms } from './AtomsFracUpdateModule.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { getBondByInstanceId } from './BondsFracUpdateModule.js';

// Angle measurements used to render green (atom rings all 0x00ff00-ish,
// separate from the dashed legs' own orange) — unified to the same orange as
// the dashed legs so the whole angle measurement (legs, rings, arc) reads as
// one consistent accent color.
const ANGLE_ACCENT = 0xff6600; // default angle accent (general.measureAngleColor overrides at runtime)
// How far outside the vertex atom's own surface the arc sits, as a multiple
// of that atom's radius. The inspector's own mini viewport uses arcR =
// bondSpan * 0.4 (bondSpan being the shortest bond off the centre atom), but
// that reads fine there because the whole view is zoomed to just the one
// atom cluster — reused as-is in the main scene it floated the arc visibly
// away from the atom's surface. Hugging the atom instead (capped by the
// bond-length term below only as a safety ceiling for unusually large atoms)
// keeps the arc read as "this atom's angle", not a stray ring in space.
const ANGLE_ARC_ATOM_FACTOR = 1.92;

/** @type {any} */
let measureLabel = null;

// Shared across every line/marker/label belonging to one measurement (a
// distance is 1 line + 2 markers + 1 label; an angle is 2 lines + 3 markers
// + 1 label) so a single measurement can be found and removed as a unit
// without disturbing any other measurement. Assigned fresh each add — never
// serialized, since addDistanceMeasurement/addAngleMeasurement re-assign one
// on restore anyway (see ShareModule.js).
let nextMeasurementId = 1;

// Disposes one measure item's own geometry plus, for Groups (the dashed-
// cylinder line groups and the atom-ring markers), every child's geometry —
// clearAllMeasurements previously only disposed the top-level item, quietly
// leaking every segment's geometry on each clear.
function disposeMeasureItem(item) {
  item.traverse?.((child) => {
    if (child.geometry) child.geometry.dispose();
  });
  if (item.geometry) item.geometry.dispose();
}

/** Removes just one measurement (all its lines/markers/label) by the shared
 *  measurementId every add function stamps onto them. No-op if the id isn't
 *  found (e.g. already removed). */
export function removeMeasurementById(id) {
  measurements.measureLines = measurements.measureLines.filter((item) => {
    if (item.userData?.measurementId !== id) return true;
    app.scene.remove(item);
    disposeMeasureItem(item);
    return false;
  });
  measurements.measureLabels = measurements.measureLabels.filter((label) => {
    if (label.userData?.measurementId !== id) return true;
    disposeMeasureLabel(label);
    return false;
  });
  resolveLabelPlacement();
}

/** Tear down one value label: the sprite itself (its material, whose texture
 *  is shared/cached so it is NOT disposed here) plus the separate DOM
 *  hotspot that carries its remove button. */
function disposeMeasureLabel(label) {
  app.scene.remove(label);
  label.material?.dispose?.();
  const hotspot = label.userData?.removeHotspot;
  if (hotspot) {
    app.scene.remove(hotspot);
    hotspot.element?.remove?.();
  }
}

// --- Atom markers (the highlight drawn on each measured atom) ---------------
//
// Style, colour and resolution are user-controlled from the Settings window's
// Measurements section (ui/MeasurementSettingsPanel.js).
//
// Sphere resolution: the shell used to be built at 18x14 segments, which is
// visibly faceted — it reads as a low-poly blob rather than a sphere next to
// the real atoms (which are much smoother). Raised to 48x32; these markers
// exist a handful at a time, so the extra triangles are irrelevant here.
const MARKER_SPHERE_SEGMENTS = [48, 32];
const MARKER_SHELL_SCALE = 1.06;   // shell radius, as a multiple of the atom's
const MARKER_RING_SCALE = 1.14;    // ring radius, ditto (sits just outside)

/** The configured marker colour for a measurement type, as a THREE-usable
 *  CSS hex string. */
export function markerColorFor(type) {
  return type === 'angleMarker' || type === 'angle'
    ? (general.measureAngleColor ?? '#ff6600')
    : (general.measureDistanceColor ?? '#ffff00');
}

/** (Re)build a marker group's children for the current style/colour/radius.
 *  Used both when a measurement is created and when the user changes any of
 *  those from Settings, so existing measurements restyle in place. */
function buildMarkerChildren(group, radius, color) {
  for (const child of group.children.slice()) {
    child.geometry?.dispose();
    child.material?.dispose?.();
    group.remove(child);
  }
  const style = general.measureMarkerStyle ?? 'shell';
  if (style === 'none' || !(radius > 0)) return;

  const opacity = general.measureMarkerOpacity ?? 0.32;

  if (style === 'ring') {
    // ONE camera-facing halo ring tracing the atom's silhouette, not a cage of
    // three orthogonal rings. A cage necessarily leaves two of its rings
    // near edge-on, which draw bars straight across the atom's face and read
    // as the ring cutting through the atom — and because those bars sit
    // partly in front of and partly behind the sphere, they also make the
    // depth look wrong. A billboarded annulus sits entirely outside the
    // sphere's silhouette, so it never intersects the atom at all and reads
    // cleanly at any opacity. Kept billboarded by updateMarkerBillboards()
    // once per rendered frame.
    const inner = radius * MARKER_RING_SCALE;
    const outer = inner + Math.max(0.02, radius * 0.13);
    const material = new THREE.MeshBasicMaterial({ color, opacity, side: THREE.DoubleSide });
    applyTransparency(material, { kind: 'measureGhost', opacity });
    const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 64), material);
    ring.userData.billboard = true;
    group.add(ring);
    return;
  }

  const shellMaterial = new THREE.MeshBasicMaterial({ color, opacity });
  applyTransparency(shellMaterial, { kind: 'measureGhost', opacity });
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(radius * MARKER_SHELL_SCALE, MARKER_SPHERE_SEGMENTS[0], MARKER_SPHERE_SEGMENTS[1]),
    shellMaterial));
}

// Per-type line geometry: dash/gap length and cylinder radius. Angle legs are
// slightly thinner than distance lines, as they always have been.
const LINE_SPECS = {
  distance: { dash: 0.16, gap: 0.1, radius: 0.04 },
  angle: { dash: 0.13, gap: 0.085, radius: 0.03 },
};

/** (Re)build a measurement's connecting line into `group`, honouring the
 *  user's line style (dashed/solid), accent colour and opacity. One builder
 *  for both measurement types and for both the initial add and the
 *  atoms-moved rebuild, so the four near-identical copies this file used to
 *  carry can't drift apart. */
function buildMeasureLine(group, start, end, kind, startTrim = 0, endTrim = 0) {
  for (const child of group.children.slice()) {
    child.geometry?.dispose();
    child.material?.dispose?.();
    group.remove(child);
  }
  const spec = LINE_SPECS[kind] ?? LINE_SPECS.distance;
  const fullDistance = start.distanceTo(end);
  if (!(fullDistance > 0)) return;
  // Trim the span back to each atom's surface (and past its highlight marker)
  // instead of running centre-to-centre. A centre-to-centre line is buried
  // inside both spheres — invisible where the atom is opaque, but it shows
  // through the translucent highlight and reads as the line cutting into the
  // atom, which is very obvious once the line is solid rather than dashed.
  const usableStart = Math.min(startTrim, fullDistance * 0.45);
  const usableEnd = Math.min(endTrim, fullDistance * 0.45);
  const distance = fullDistance - usableStart - usableEnd;
  if (!(distance > 0)) return;

  const opacity = general.measureLineOpacity ?? 1;
  const material = new THREE.MeshBasicMaterial({
    color: markerColorFor(kind === 'angle' ? 'angle' : 'distance'),
    opacity,
  });
  // Declare the intent and let the ACTIVE pipeline set the flags — never set
  // transparent/depthWrite here. The default pipeline is depth peeling, which
  // only composites a translucent material correctly once it has been patched
  // into the peel pass, and that patch happens inside applyTransparency.
  // Setting the flags by hand skips it, which is why translucent lines/rings
  // rendered with wrong depth against the rest of the scene.
  applyTransparency(material, { kind: 'measureGhost', opacity });

  const step = new THREE.Vector3().subVectors(end, start).normalize();
  const origin = start.clone().addScaledVector(step, usableStart);
  const addPiece = (length, centreAlong) => {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius, spec.radius, length, 12), material);
    mesh.position.copy(origin).addScaledVector(step, centreAlong);
    mesh.lookAt(end);
    mesh.rotateX(Math.PI / 2);
    group.add(mesh);
  };

  if ((general.measureLineStyle ?? 'dashed') === 'solid') {
    addPiece(distance, distance / 2);
    return;
  }
  const segmentLength = spec.dash + spec.gap;
  const count = Math.floor(distance / segmentLength);
  for (let i = 0; i < count; i++) addPiece(spec.dash, i * segmentLength + spec.dash / 2);
}

// How far along the angle bisector the label sits, as a multiple of the arc's
// own radius — just outside the arc tube, so the label rides its arc rather
// than sitting on the vertex atom. Two angles on the same vertex then have
// naturally different label positions (different bisectors) instead of landing
// on top of each other and needing to be nudged apart.
const ANGLE_LABEL_ARC_FACTOR = 1.12;
// How far a distance label sits off its own line, as a multiple of the label's
// height, measured perpendicular to the line ON SCREEN (so it reads as "beside
// the line" from any camera angle). Keeps the value clear of the dashes
// instead of having them run through the text.
// Value labels are wide and short (a "12.000 Å" pill is roughly 6x wider than
// it is tall), so two of them need a good deal of room before their boxes
// actually clear. Measured on two lines crossing at a shared midpoint: at 1.1
// they still overlapped by ~4px vertically. Only ever applied to labels that
// are actually crowded, so a generous value costs nothing elsewhere.
const DISTANCE_LABEL_OFFSET = 1.7;

/** The fixed world vector an angle label slides along when it has to share its
 *  vertex with another measurement: out to its own arc, along the bisector. */
function angleSeparation(toA, toB, arcRadius) {
  const bisector = toA.clone().normalize().add(toB.clone().normalize());
  // Degenerate at exactly 180 degrees (the legs cancel) — no sensible
  // direction, so no separation rather than a NaN one.
  if (bisector.lengthSq() < 1e-8) return null;
  return bisector.normalize().multiplyScalar(arcRadius * ANGLE_LABEL_ARC_FACTOR);
}

/** The fixed world vector a distance label slides along when it shares its
 *  midpoint with other measurements: sideways off its own line.
 *
 *  Direction is chosen from the OTHER lines in the group, not from a fixed
 *  world axis. Two lines crossing at a shared midpoint span a plane, and
 *  offsetting each one within that plane guarantees they separate. A fixed
 *  world axis does not: two perpendicular lines both end up offset along the
 *  same remaining axis, which is invisible whenever that axis happens to point
 *  at the camera (measured: two crossing lines in the XY plane both offset
 *  along Z, so from a Z-facing view they stayed exactly on top of each other).
 *  Camera-independent either way, so the offset is still static while orbiting. */
function distanceSeparation(label, group) {
  const dir = label.userData?.lineDir;
  if (!dir) return null;
  let perp = null;
  for (const other of group) {
    const otherDir = other === label ? null : other.userData?.lineDir;
    if (!otherDir) continue;
    const planeNormal = new THREE.Vector3().crossVectors(dir, otherDir);
    if (planeNormal.lengthSq() < 1e-6) continue; // parallel — spans no plane
    perp = new THREE.Vector3().crossVectors(planeNormal, dir).normalize();
    break;
  }
  if (!perp) {
    // Nothing in the group to define a plane (e.g. paired with an angle
    // label): fall back to a world axis.
    const axis = Math.abs(dir.y) < 0.9 ? _worldUp : _worldX;
    perp = new THREE.Vector3().crossVectors(dir, axis);
    if (perp.lengthSq() < 1e-8) return null;
    perp.normalize();
  }
  return perp.multiplyScalar(label.userData.separationLength ?? label.scale.y * DISTANCE_LABEL_OFFSET);
}

/** Decide, once per measurement change, where each label actually sits.
 *
 *  A label stays exactly on the point it measures — that is what makes it
 *  readable and, crucially, STATIC while orbiting. The only exception is a
 *  point shared by more than one label (two angles on one vertex atom, two
 *  distances crossing at a common midpoint), which can never separate on its
 *  own; those slide along their stored, camera-independent separation vector.
 *  Coincident labels showing the SAME value collapse to one instead, since two
 *  identical numbers on one atom add nothing.
 *
 *  Deliberately NOT per frame: an offset recomputed against the camera each
 *  frame makes every label drift as the view turns. */
function resolveLabelPlacement() {
  const labels = measurements.measureLabels;
  for (const label of labels) {
    if (!label.userData) continue;
    label.userData.placementOffset = null;
    label.userData.duplicateHidden = false;
  }

  /** @type {{anchor: any, members: any[]}[]} */
  const groups = [];
  for (const label of labels) {
    const anchor = label.userData?.anchor;
    if (!anchor) continue;
    const group = groups.find((g) => g.anchor.distanceTo(anchor) <= LABEL_COINCIDENT_ANCHOR);
    if (group) group.members.push(label);
    else groups.push({ anchor: anchor.clone(), members: [label] });
  }

  for (const group of groups) {
    if (group.members.length < 2) continue; // alone at its point: stays put
    const shown = [];
    for (const label of group.members) {
      if (shown.some((other) => other.userData.labelText === label.userData.labelText)) {
        label.userData.duplicateHidden = true;
        continue;
      }
      shown.push(label);
    }
    if (shown.length < 2) continue; // the duplicates were the only crowding
    for (const label of shown) {
      label.userData.placementOffset = label.userData.separation // angles: their own bisector
        ?? distanceSeparation(label, shown); // distances: within the group's plane
    }
  }
}

/** Stand-off for a connecting line at an atom: the atom's own surface, or its
 *  highlight marker's outer edge when that reaches further. */
function lineStandoff(element) {
  const radius = getAtomRadius(element);
  return Math.max(radius, markerClearance(radius));
}

/** How far out a marker reaches from its atom's centre, in world units — the
 *  clearance an angle label anchored on that atom has to be lifted past so
 *  the marker doesn't slice through the text. */
export function markerClearance(radius) {
  const style = general.measureMarkerStyle ?? 'shell';
  if (style === 'none') return 0;
  if (style === 'ring') return radius * MARKER_RING_SCALE + Math.max(0.02, radius * 0.13);
  return radius * MARKER_SHELL_SCALE;
}

export function createAtomRings(position, radius, innerColor, outerColor, element = null) {
  const shellGroup = new THREE.Group();
  buildMarkerChildren(shellGroup, radius, innerColor);
  shellGroup.position.copy(position);
  shellGroup.userData = {
    isAtomMarker: true,
    markerType: 'shell',
    element,
    accentColor: innerColor,
    outlineColor: outerColor,
  };
  return shellGroup;
}

/** Re-apply every appearance setting (marker style/opacity, accent colours,
 *  line style/opacity, label outline) to the measurements already on screen,
 *  so the Settings controls restyle what's there instead of only affecting
 *  the next measurement. */
export function refreshMeasurementStyling() {
  for (const item of measurements.measureLines) {
    if (item.userData?.type === 'angleArc') item.material?.color?.set(markerColorFor('angle'));
  }
  // Force each label's texture to be rebuilt with the new outline colour —
  // setMeasureLabelText short-circuits when the text is unchanged.
  for (const label of measurements.measureLabels) {
    if (label.userData) label.userData.labelText = null;
  }
  // Rebuilds the lines (via buildMeasureLine), the label textures and, at its
  // end, every atom marker (via updateMeasurementMarkers).
  updateAllMeasurements();
}

/** Points along the minor arc between unit directions d1,d2, radius r from
 *  `center` — draws a partial circle showing which angle is spanned, the
 *  same technique the polyhedron inspector uses between two bond directions
 *  (PolyhedronMiniRenderer.js's arcPoints), just anchored on a real atom in
 *  the main scene instead of the mini viewport's normalized geometry. */
function arcPoints(center, d1, d2, r, segments = 24) {
  const theta = Math.acos(Math.max(-1, Math.min(1, d1.dot(d2))));
  const pts = [];
  // Near 0°, d1≈d2 and there's nothing to arc between. Near 180°, d1≈-d2 —
  // sin(theta) collapses toward 0 and the interpolation weights below blow
  // up, plus the arc's plane is no longer well-defined by these two vectors
  // alone, so skip drawing rather than render a wildly unstable arc.
  if (theta < 1e-4 || theta > Math.PI - 1e-4) return pts;
  const sin = Math.sin(theta);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const w1 = Math.sin((1 - t) * theta) / sin;
    const w2 = Math.sin(t * theta) / sin;
    const dir = d1.clone().multiplyScalar(w1).addScaledVector(d2, w2).normalize();
    pts.push(center.clone().addScaledVector(dir, r));
  }
  return pts;
}

/** The arc marker's geometry, as one continuous tube — deliberately opaque
 *  (a plain MeshBasicMaterial with no `transparent`/depthTest override at
 *  the call site below), matching the dashed legs' own material exactly, so
 *  it depth-composites against real atoms/bonds through the ordinary
 *  front-to-back opaque pass rather than needing any custom occlusion code. */
function buildAngleArcGeometry(center, d1, d2, radius) {
  const pts = arcPoints(center, d1, d2, radius);
  if (pts.length < 2) return new THREE.BufferGeometry();
  const curve = new THREE.CatmullRomCurve3(pts);
  // Same proportion as the polyhedron inspector's arcs (arcTubeRadius =
  // bondSpan * 0.014 there, against an arcR of bondSpan * 0.4 — a 1:28.6
  // ratio; radius * 0.035 here matches that ratio against our own radius).
  // Proportional to the arc's own radius, so the arc keeps its proportions at
  // any atom size. NOTE the coefficient is NOT the place to add width when the
  // arc also moves outward: pushing the arc from 1.3x to 1.6x the atom radius
  // already thickens the tube by the same 23%, so raising the coefficient too
  // compounds it (0.035 -> 0.042 gave ~48% thicker, far past the ~20% wanted).
  // 0.0379 rather than 0.035: the +20% radius bump above already widens the
  // tube by 20% on its own (it is proportional to `radius`), so the
  // coefficient only has to supply the remaining ~8% to land on ~30% thicker
  // overall — see the note in the commit history about compounding these two.
  const tubeRadius = radius * 0.0379;
  return new THREE.TubeGeometry(curve, Math.max(8, pts.length - 1), tubeRadius, 8, false);
}

/** How far out the vertex arc sits: primarily a multiple of the vertex atom's
 *  own radius (ANGLE_ARC_ATOM_FACTOR), so the arc hugs just outside the
 *  atom's surface instead of floating in space. Capped by a fraction of the
 *  shorter measured bond so an unusually large atom's arc still can't reach
 *  as far as the neighboring atom it's measuring toward. */
function vertexArcRadius(vertexRadius, bond1Length, bond2Length) {
  return Math.min(vertexRadius * ANGLE_ARC_ATOM_FACTOR, Math.min(bond1Length, bond2Length) * 0.6);
}

/** Rebuild one angle-arc mesh's geometry from its current atom positions —
 *  called both when atoms actually move (updateAllMeasurements) and when
 *  just the atom-size setting changes (updateMeasurementMarkers), since the
 *  arc's radius tracks both the bond lengths and the vertex atom's radius. */
function refreshAngleArc(item) {
  const atom1 = resolveMeasurementAtom(item.userData.atom1Ref, item.userData.atom1Position);
  const atom2 = resolveMeasurementAtom(item.userData.atom2Ref, item.userData.atom2Position);
  const atom3 = resolveMeasurementAtom(item.userData.atom3Ref, item.userData.atom3Position);
  if (!atom1 || !atom2 || !atom3) return;

  const d1 = atom1.position.clone().sub(atom2.position);
  const d2 = atom3.position.clone().sub(atom2.position);
  const arcRadius = vertexArcRadius(getAtomRadius(atom2.userData.element), d1.length(), d2.length());
  item.geometry.dispose();
  item.geometry = buildAngleArcGeometry(atom2.position, d1.normalize(), d2.normalize(), arcRadius);
}

export function updateMeasurementMarkers() {
  // Rebuild each marker for the current atom size (and current style/colour).
  measurements.measureLines.forEach(item => {
    if (item.userData?.isAtomMarker) {
      buildMarkerChildren(item, getAtomRadius(item.userData.element), markerColorFor(item.userData.type));
    } else if (item.userData && item.userData.type === 'angleArc') {
      refreshAngleArc(item);
    }
  });
}

export function getAtomRadius(element) { // exists also in crystal-viewer. needs to be unified and moved to utilities for further usage
  return (atomicRadii[element] || 1.0) * general.atomSize;
}


export function clearMeasureGraphics(){
  if (measureLabel){ app.scene.remove(measureLabel); measureLabel = null; }
}


export function clearAllMeasurements(){
  // Clear all stored measurements
  measurements.measureLines.forEach(item => {
    app.scene.remove(item);
    disposeMeasureItem(item);
  });
  measurements.measureLabels.forEach(disposeMeasureLabel);
  measurements.measureLines = [];
  measurements.measureLabels = [];
  measurements.selectedAtoms = [];
  clearMeasureGraphics();
}

export function calculateAngle(atom1, atom2, atom3) {
  // Calculate angle between three atoms: atom1-atom2-atom3 (atom2 is vertex)
  const p1 = atom1.position.clone();
  const p2 = atom2.position.clone();
  const p3 = atom3.position.clone();

  const v1 = p1.sub(p2).normalize();
  const v2 = p3.sub(p2).normalize();

  const dotProduct = v1.dot(v2);
  const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
  return angle * (180 / Math.PI); // Convert to degrees
}

function createMeasurementAtomRef(atom) {
  const structure = fileBrowser.selectedStructure;
  const atomIndex = atom?.userData?.atomIndex;
  if (!structure || atomIndex == null || !structure.atoms?.[atomIndex]) return null;

  const baseFrac = structure.atoms[atomIndex].position;
  const wrappedFrac = atom.userData?.wrappedFrac;
  const imageOffset = wrappedFrac
    ? wrappedFrac.map((value, axis) => Math.round(value - baseFrac[axis]))
    : [0, 0, 0];
  const resolvedFrac = baseFrac.map((value, axis) => value + imageOffset[axis]);

  return {
    atomIndex,
    element: atom.userData?.element ?? structure.elements?.[atomIndex] ?? '?',
    imageOffset,
    lastResolvedFrac: resolvedFrac,
  };
}

function cloneMeasurementRef(ref) {
  if (!ref) return null;
  return {
    atomIndex: ref.atomIndex,
    element: ref.element,
    imageOffset: Array.isArray(ref.imageOffset) ? [...ref.imageOffset] : [0, 0, 0],
    lastResolvedFrac: Array.isArray(ref.lastResolvedFrac) ? [...ref.lastResolvedFrac] : null,
  };
}

function buildLegacyMeasurementRef(atomIndex, savedPosition = null) {
  const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
  if (!wrapped || atomIndex == null) return null;

  let bestIndex = -1;
  let bestDistance = Infinity;
  const target = savedPosition?.length ? new THREE.Vector3(...savedPosition) : null;

  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (srcIdx !== atomIndex) continue;

    if (!target) {
      bestIndex = i;
      break;
    }

    const distance = target.distanceTo(new THREE.Vector3(...wrapped.cart[i]));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return null;

  return createMeasurementAtomRef({
    position: new THREE.Vector3(...wrapped.cart[bestIndex]),
    userData: {
      atomIndex,
      element: wrapped.elements?.[bestIndex] ?? fileBrowser.selectedStructure?.elements?.[atomIndex] ?? '?',
      wrappedFrac: wrapped.frac?.[bestIndex] ? [...wrapped.frac[bestIndex]] : null,
    },
  });
}

function ensureMeasurementRef(refOrIndex, savedPosition = null) {
  if (refOrIndex && typeof refOrIndex === 'object' && refOrIndex.atomIndex != null) {
    if (!Array.isArray(refOrIndex.imageOffset)) refOrIndex.imageOffset = [0, 0, 0];
    if (!Array.isArray(refOrIndex.lastResolvedFrac)) {
      const base = fileBrowser.selectedStructure?.atoms?.[refOrIndex.atomIndex]?.position;
      refOrIndex.lastResolvedFrac = base
        ? base.map((value, axis) => value + refOrIndex.imageOffset[axis])
        : null;
    }
    if (!refOrIndex.element) {
      refOrIndex.element = fileBrowser.selectedStructure?.elements?.[refOrIndex.atomIndex] ?? '?';
    }
    return refOrIndex;
  }
  return buildLegacyMeasurementRef(refOrIndex, savedPosition);
}

function resolveMeasurementAtom(refOrIndex, savedPosition = null) {
  const structure = fileBrowser.selectedStructure;
  const ref = ensureMeasurementRef(refOrIndex, savedPosition);
  if (!structure || !ref || !structure.atoms?.[ref.atomIndex]) return null;

  const baseFrac = structure.atoms[ref.atomIndex].position;
  const imageOffset = baseFrac.map((value, axis) => {
    const previous = ref.lastResolvedFrac?.[axis] ?? value + (ref.imageOffset?.[axis] ?? 0);
    return Math.round(previous - value);
  });
  const resolvedFrac = baseFrac.map((value, axis) => value + imageOffset[axis]);
  const cart = fracToCart([resolvedFrac], structure.lattice)[0];

  ref.imageOffset = imageOffset;
  ref.lastResolvedFrac = resolvedFrac;
  ref.element = ref.element ?? structure.elements?.[ref.atomIndex] ?? '?';

  return {
    position: new THREE.Vector3(...cart),
    userData: {
      atomIndex: ref.atomIndex,
      element: ref.element,
      imageOffset: [...imageOffset],
      wrappedFrac: [...resolvedFrac],
      measurementRef: ref,
    },
  };
}

export function serializeMeasurementRef(ref) {
  const normalized = ensureMeasurementRef(ref);
  return normalized ? cloneMeasurementRef(normalized) : null;
}

// --- Measurement value labels, as real depth-tested 3D objects ------------
//
// These used to be CSS2DObjects: HTML divs layered over the WebGL canvas by
// CSS2DRenderer. That is the root cause of every "the label is drawn on top
// of an atom that's in front of it" problem — a DOM overlay is composited
// after WebGL is done and never touches the depth buffer, so it ALWAYS
// paints over the scene no matter what is between it and the camera. The
// only way to hide one was to approximate the depth test in JS (raycasts,
// projected-radius overlap tests, tuned thresholds), and an approximation of
// a per-pixel test always leaves gaps: an atom covering part of the label
// but not the sampled point, an atom slightly off the ray, a threshold right
// at the boundary.
//
// Rendering the value as a THREE.Sprite instead makes the GPU do it exactly:
// the sprite is real geometry in the scene, so the depth buffer clips it
// per-pixel against atoms, bonds and polyhedra — including partial overlap
// (half the label behind a sphere, half still visible), which no JS
// approximation can reproduce. Same technique ChargeBadgeModule.js uses for
// charge badges (depthTest:true, depthWrite:false, transparent), which is
// the rendering this feature was originally asked to match.
// Base on-screen height of a value pill, in world units, before the user's
// Settings multiplier (general.measureLabelScale). Halved from the original
// 0.85 — the sprites read considerably larger than the old CSS2D pills did.
// 0.294 = the old 0.42 at a 0.7 slider setting, which is what the default
// should have been — the Settings slider now reads 1.00 at that size.
const MEASURE_LABEL_WORLD_HEIGHT = 0.294;

/** Current label height in world units: the base size times the user's
 *  Settings slider. */
function measureLabelHeight() {
  return MEASURE_LABEL_WORLD_HEIGHT * (general.measureLabelScale ?? 1);
}
/** @type {Map<string, any>} text+style key -> THREE.CanvasTexture */
const measureLabelTextureCache = new Map();

/** Canvas texture for one label's text, as a rounded pill. Cached by text +
 *  style so repeated values (and per-frame refreshes that don't actually
 *  change the number) don't rebuild a canvas each time. */
function measureLabelTexture(text, { bg, fg, border }) {
  const key = `${text}|${bg}|${fg}|${border}`;
  const cached = measureLabelTextureCache.get(key);
  if (cached) return cached;

  const fontPx = 64;
  const font = `700 ${fontPx}px sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const textWidth = ctx.measureText(text).width;
  const padX = fontPx * 0.34;
  const padY = fontPx * 0.2;
  const stroke = border ? fontPx * 0.11 : 0;
  canvas.width = Math.ceil(textWidth + (padX + stroke) * 2);
  canvas.height = Math.ceil(fontPx + (padY + stroke) * 2);
  // Resizing the canvas resets the 2D context, so re-apply text settings.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const r = canvas.height * 0.3;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(stroke / 2, stroke / 2, canvas.width - stroke, canvas.height - stroke, r);
  ctx.fill();
  if (border) {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = border;
    ctx.stroke();
  }

  ctx.fillStyle = fg;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  measureLabelTextureCache.set(key, texture);
  return texture;
}

/** Point a label sprite at `text`, resizing it to the new text's aspect.
 *  Height is a fixed world height so the pill's on-screen size tracks zoom
 *  exactly like the charge badges do, and width follows the text. */
function setMeasureLabelText(sprite, text, style) {
  const height = measureLabelHeight();
  if (sprite.userData.labelText === text && sprite.userData.labelHeight === height) return;
  sprite.userData.labelText = text;
  sprite.userData.labelHeight = height;
  const texture = measureLabelTexture(text, style);
  sprite.material.map = texture;
  sprite.material.needsUpdate = true;
  const aspect = texture.image.width / texture.image.height;
  sprite.userData.labelAspect = aspect;
  sprite.scale.set(height * aspect, height, 1);
}

/** Re-apply the current size multiplier to every existing label. Called by
 *  the Settings slider — the text is unchanged, only the scale. */
export function refreshMeasureLabelSizes() {
  const height = measureLabelHeight();
  for (const label of measurements.measureLabels) {
    const aspect = label.userData?.labelAspect;
    if (!aspect) continue;
    label.userData.labelHeight = height;
    label.scale.set(height * aspect, height, 1);
  }
}

/** A measurement's value label: a real, depth-tested sprite in the scene.
 *
 *  Deliberately OPAQUE with an alpha cutout (transparent:false + alphaTest)
 *  rather than a blended transparent sprite. The app's active pipeline is
 *  DepthPeelPipeline, which renders the opaque set first (capturing its
 *  depth) and then peels the TRANSPARENT set in separate passes — so a
 *  transparent sprite never depth-tests against the atoms and paints over
 *  them regardless of depthTest, which is exactly the bug this whole change
 *  is meant to kill (verified directly: a blended sprite rendered
 *  pixel-identically with a blocking atom in front of it vs behind it).
 *  Going through the opaque path instead means the depth buffer clips the
 *  label per-pixel like any other solid object, and alphaTest keeps the
 *  pill's rounded corners from rendering as opaque black boxes. */
function makeMeasureLabelSprite(text, style) {
  const sprite = /** @type {any} */ (new THREE.Sprite(new THREE.SpriteMaterial({
    transparent: false, alphaTest: 0.5, depthTest: true, depthWrite: true,
  })));
  setMeasureLabelText(sprite, text, style);
  return sprite;
}

/** Value pills keep a neutral, high-contrast fill and carry the measurement's
 *  accent as an OUTLINE — a fully accent-filled pill was hard to read and hid
 *  the value behind the colour. */
function labelStyleFor(kind) {
  return { bg: '#ffffff', fg: '#111111', border: markerColorFor(kind) };
}


// Small "x" shown only on hover (styles.css) — removes just that one
// measurement. It lives in its own tiny CSS2DObject "hotspot" pinned to the
// label's anchor, because the label itself is now a sprite (WebGL geometry)
// and can't host a DOM child. Being a DOM overlay it can't depth-test, but
// it's a hover-only affordance rather than part of the reading, and
// updateMeasurementLabelVisibility hides it with a single cheap ray when the
// anchor is behind something.
function createRemoveHotspot(measurementId) {
  const div = document.createElement('div');
  div.className = 'measure-remove-hotspot';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'measure-label-remove';
  btn.textContent = '×';
  btn.title = 'Remove this measurement';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeMeasurementById(measurementId);
  });
  div.appendChild(btn);
  return /** @type {any} */ (new CSS2DObject(div));
}

export function addAngleMeasurement(atom1, atom2, atom3) {
  const measurementId = nextMeasurementId++;
  const angle = calculateAngle(atom1, atom2, atom3);
  const atom1Ref = createMeasurementAtomRef(atom1);
  const atom2Ref = createMeasurementAtomRef(atom2);
  const atom3Ref = createMeasurementAtomRef(atom3);

  // Create angle arc visualization
  const p1 = atom1.position.clone();
  const p2 = atom2.position.clone(); // vertex
  const p3 = atom3.position.clone();

  // Connecting legs, drawn by the shared builder (style/colour/opacity all
  // come from the user's Measurements settings).
  const vertexStandoff = lineStandoff(atom2.userData.element);
  const makeLeg = (from, to, farElement) => {
    const g = new THREE.Group();
    buildMeasureLine(g, from, to, 'angle', vertexStandoff, lineStandoff(farElement));
    return g;
  };
  const angleLine1 = makeLeg(p2, p1, atom1.userData.element);
  const angleLine2 = makeLeg(p2, p3, atom3.userData.element);

  // Store atom indices for dynamic updates
  angleLine1.userData = {
    type: 'angle',
    measurementId,
    atom1Ref,
    atom2Ref,
    atom3Ref,
    lineIndex: 1 // first line (vertex to atom1)
  };

  angleLine2.userData = {
    type: 'angle',
    measurementId,
    atom1Ref,
    atom2Ref,
    atom3Ref,
    lineIndex: 2 // second line (vertex to atom3)
  };

  app.scene.add(angleLine1);
  app.scene.add(angleLine2);
  measurements.measureLines.push(angleLine1);
  measurements.measureLines.push(angleLine2);

  // Add markers to all three atoms — same orange accent for all three now
  // (was a brighter green on the vertex vs. the two legs).
  [atom1, atom2, atom3].forEach((atom, index) => {
    const atomRadius = getAtomRadius(atom.userData.element);

    const rings = createAtomRings(atom.position, atomRadius, markerColorFor('angleMarker'), 0x000000, atom.userData.element);
    rings.userData = {
      ...rings.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
      type: 'angleMarker',
      measurementId,
      atomRef: index === 0 ? atom1Ref : (index === 1 ? atom2Ref : atom3Ref),
      atom1Ref,
      atom2Ref,
      atom3Ref
    };
    app.scene.add(rings);
    measurements.measureLines.push(rings);

  });

  // Arc marker around the vertex atom itself, spanning the angle between the
  // two measured bonds — makes it visually obvious WHICH angle at that atom
  // is being reported, rather than just three same-looking atom rings. Sized
  // off the bond lengths (see vertexArcRadius), same as the polyhedron
  // inspector's own arcs, and opaque (see buildAngleArcGeometry) so it
  // depth-composites against real atoms/bonds the same reliable way the
  // dashed legs above do.
  const vertexRadius = getAtomRadius(atom2.userData.element);
  const arcRadius = vertexArcRadius(vertexRadius, p1.distanceTo(p2), p3.distanceTo(p2));
  const arcGeometry = buildAngleArcGeometry(p2, p1.clone().sub(p2).normalize(), p3.clone().sub(p2).normalize(), arcRadius);
  const arcMesh = new THREE.Mesh(arcGeometry, new THREE.MeshBasicMaterial({ color: markerColorFor('angle') }));
  arcMesh.userData = { type: 'angleArc', measurementId, atom1Ref, atom2Ref, atom3Ref };
  app.scene.add(arcMesh);
  measurements.measureLines.push(arcMesh);

  // Angle value label — just the angle itself; the "∠O-Ba-O:" element-name
  // prefix is dropped, since the arc and the three rings already show which
  // atoms the angle is between.
  const label = makeMeasureLabelSprite(`${angle.toFixed(1)}°`, labelStyleFor('angle'));
  label.position.copy(p2);
  label.userData.anchor = p2.clone();
  // Direction/length to slide along IF this label ends up sharing its point
  // with another one (see resolveLabelPlacement). Stored, not applied.
  label.userData.separation = angleSeparation(p1.clone().sub(p2), p3.clone().sub(p2), arcRadius);
  // An angle label sits at its vertex atom's centre, so it must clear that
  // atom's own highlight marker (shell/rings) as well as the atom — otherwise
  // the marker's near hemisphere slices across the text.
  label.userData.anchorClearance = markerClearance(vertexRadius);

  // Store atom indices for dynamic updates (spread, so the sprite's own
  // labelText cache key set by setMeasureLabelText survives).
  label.userData = {
    ...label.userData,
    type: 'angle',
    measurementId,
    atom1Ref,
    atom2Ref,
    atom3Ref,
    // Which atoms this label is allowed to sit "inside" without being
    // treated as self-occluded by the depth-hiding pass below — the label
    // anchors exactly at the vertex atom's own position, so any real bond
    // touching that atom is excluded too (vertexAtomIndex), not just the
    // two measured legs.
    excludeAtomIndices: [atom1Ref?.atomIndex, atom2Ref?.atomIndex, atom3Ref?.atomIndex].filter((i) => i != null),
    vertexAtomIndex: atom2Ref?.atomIndex,
    removeHotspot: createRemoveHotspot(measurementId),
  };
  label.userData.removeHotspot.position.copy(p2);
  label.userData.removeHotspot.userData.measurementId = measurementId;
  app.scene.add(label.userData.removeHotspot);

  app.scene.add(label);
  measurements.measureLabels.push(label);
  resolveLabelPlacement();
}


export function addDistanceMeasurement(atom1, atom2) {
  const measurementId = nextMeasurementId++;
  const atom1Ref = createMeasurementAtomRef(atom1);
  const atom2Ref = createMeasurementAtomRef(atom2);
  // Create thick dashed cylinder for distance measurement (BLUE for distance)
  const pa = atom1.position.clone(), pb = atom2.position.clone();
  const distance = pa.distanceTo(pb);
  const direction = new THREE.Vector3().subVectors(pb, pa);

  const cylinderGroup = new THREE.Group();
  buildMeasureLine(cylinderGroup, pa, pb, 'distance',
    lineStandoff(atom1.userData.element), lineStandoff(atom2.userData.element));

  // Store atom indices for dynamic updates
  cylinderGroup.userData = {
    type: 'distance',
    measurementId,
    atom1Ref,
    atom2Ref
  };

  app.scene.add(cylinderGroup);
  measurements.measureLines.push(cylinderGroup);

  // Create atom-size-aware surface markers

  // Get atom radii for proper scaling
  const atomRadiusA = getAtomRadius(atom1.userData.element);
  const atomRadiusB = getAtomRadius(atom2.userData.element);
  // Add scaling rings to both atoms
  const ringsA = createAtomRings(pa, atomRadiusA, markerColorFor('distanceMarker'), 0x000000, atom1.userData.element);
  ringsA.userData = {
    ...ringsA.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    measurementId,
    atomRef: atom1Ref,
    measurementIndex: measurements.measureLines.length // Reference to the cylinder group
  };
  app.scene.add(ringsA);
  measurements.measureLines.push(ringsA);

  const ringsB = createAtomRings(pb, atomRadiusB, markerColorFor('distanceMarker'), 0x000000, atom2.userData.element);
  ringsB.userData = {
    ...ringsB.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    measurementId,
    atomRef: atom2Ref,
    measurementIndex: measurements.measureLines.length - 1 // Reference to the cylinder group
  };
  app.scene.add(ringsB);
  measurements.measureLines.push(ringsB);

  // Compact black-and-white value pill, as a depth-tested sprite.
  const mid = pa.clone().add(pb).multiplyScalar(0.5);
  const d = pa.distanceTo(pb);
  const label = makeMeasureLabelSprite(`${formatÅ(d)} Å`, labelStyleFor('distance'));
  label.position.copy(mid);
  label.userData.anchor = mid.clone();
  label.userData.anchorClearance = 0; // only its own thin dashed line sits here
  label.userData.lineDir = pb.clone().sub(pa).normalize();
  label.userData.separationLength = label.scale.y * DISTANCE_LABEL_OFFSET;

  // Store atom indices for dynamic updates (spread, so the sprite's own
  // labelText cache key set by setMeasureLabelText survives).
  label.userData = {
    ...label.userData,
    type: 'distance',
    measurementId,
    atom1Ref,
    atom2Ref,
    removeHotspot: createRemoveHotspot(measurementId),
    // Which atoms this label is allowed to sit "inside" without being
    // treated as self-occluded by the depth-hiding pass below.
    excludeAtomIndices: [atom1Ref?.atomIndex, atom2Ref?.atomIndex].filter((i) => i != null),
  };
  label.userData.removeHotspot.position.copy(mid);
  app.scene.add(label.userData.removeHotspot);

  app.scene.add(label);
  measurements.measureLabels.push(label);
  resolveLabelPlacement();
}

export function drawMeasureGraphics(){
  clearMeasureGraphics();

  // Show preview lines/indicators for current selection
  if (mode.measureMode === 'distance' && measurements.selectedAtoms.length === 1) {
    // Show preview for distance measurement (1 atom selected)
    const atom1 = measurements.selectedAtoms[0];
    const div = document.createElement('div');
    div.className = 'measure-label';
    div.style.background = 'rgba(255, 255, 255, 0.8)';
    div.style.border = '2px solid #000000';
    div.style.color = '#000000';
    div.style.fontWeight = '700';
    div.style.fontSize = '12px';
    div.style.padding = '4px 8px';
    div.style.borderRadius = '4px';
    //div.textContent = `${atom1.userData.element} — ? (click 2nd atom)`;
    div.textContent = `choose 2nd atom`;
    measureLabel = new CSS2DObject(div);
    measureLabel.position.copy(atom1.position);
    // Anchored at atom1's own centre, so any real bond touching it is
    // excluded from the depth-hiding pass too, not just hits on the atom.
    measureLabel.userData = {
      excludeAtomIndices: [atom1.userData?.atomIndex].filter((i) => i != null),
      vertexAtomIndex: atom1.userData?.atomIndex,
    };
    app.scene.add(measureLabel);
  } else if (mode.measureMode === 'angle' && measurements.selectedAtoms.length > 0) {
    // Show preview for angle measurement — orange, matching the angle arc
    // and dashed legs. Unlike the finished angle label, this preview still
    // carries guidance text ("select vertex", etc.) since it's transient
    // picking UI, not the completed measurement's own display.
    const div = document.createElement('div');
    div.className = 'measure-label';
    div.style.background = 'rgba(255, 102, 0, 0.85)';
    div.style.border = 'none';
    div.style.color = '#ffffff';
    div.style.fontWeight = '700';
    div.style.fontSize = '10px';
    div.style.padding = '2px 4px';
    div.style.borderRadius = '4px';

    if (measurements.selectedAtoms.length === 1) {
      div.textContent = `${measurements.selectedAtoms[0].userData.element} — ? — ? (select vertex)`;
    } else if (measurements.selectedAtoms.length === 2) {
      div.textContent = `${measurements.selectedAtoms[0].userData.element} — ${measurements.selectedAtoms[1].userData.element} — ? (select 3rd atom)`;
    }

    const anchorAtom = measurements.selectedAtoms[measurements.selectedAtoms.length - 1];
    measureLabel = new CSS2DObject(div);
    measureLabel.position.copy(anchorAtom.position);
    measureLabel.userData = {
      excludeAtomIndices: measurements.selectedAtoms.map((a) => a.userData?.atomIndex).filter((i) => i != null),
      vertexAtomIndex: anchorAtom.userData?.atomIndex,
    };
    app.scene.add(measureLabel);
  }
}

export function clearMeasure(){
  // Reset any measurement atom highlights (clearHighlightAtom just calls
  // updateAtoms(1.0); use it directly to avoid a render→ui dependency).
  if (measurements.selectedAtoms.length) updateAtoms(1.0);
  measurements.selectedAtoms = [];
  clearMeasureGraphics();
}

function formatÅ(x){ return (Math.round(x*1000)/1000).toFixed(3); }


export function updateAllMeasurements() {
  if (!fileBrowser.selectedStructure?.atoms || !fileBrowser.selectedStructure?.lattice) return;

  measurements.measureLines.forEach(measureItem => {
    if (!measureItem.userData) return;

    if (measureItem.userData.type === 'distance') {
      // Update distance measurement
      const atom1 = resolveMeasurementAtom(measureItem.userData.atom1Ref, measureItem.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(measureItem.userData.atom2Ref, measureItem.userData.atom2Position);

      if (atom1 && atom2) {
        buildMeasureLine(measureItem, atom1.position, atom2.position, 'distance',
          lineStandoff(atom1.userData.element), lineStandoff(atom2.userData.element));
      }
    } else if (measureItem.userData.type === 'angle') {
      // Update angle measurement
      const lineIndex = measureItem.userData.lineIndex;

      const atom1 = resolveMeasurementAtom(measureItem.userData.atom1Ref, measureItem.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(measureItem.userData.atom2Ref, measureItem.userData.atom2Position); // vertex
      const atom3 = resolveMeasurementAtom(measureItem.userData.atom3Ref, measureItem.userData.atom3Position);

      if (atom1 && atom2 && atom3) {
        const far = lineIndex === 1 ? atom1 : atom3;
        buildMeasureLine(measureItem, atom2.position, far.position, 'angle',
          lineStandoff(atom2.userData.element), lineStandoff(far.userData.element));
      }
    } else if (measureItem.userData.type === 'distanceMarker') {
      // Update distance marker position
      const atom = resolveMeasurementAtom(measureItem.userData.atomRef, measureItem.userData.atomPosition);

      if (atom) {
        measureItem.position.copy(atom.position);
      }
    } else if (measureItem.userData.type === 'angleMarker') {
      // Update angle marker position
      const atom = resolveMeasurementAtom(measureItem.userData.atomRef, measureItem.userData.atomPosition);

      if (atom) {
        measureItem.position.copy(atom.position);
      }
    } else if (measureItem.userData.type === 'angleArc') {
      refreshAngleArc(measureItem);
    }
  });

  // Update measurement labels (sprite text + position, and the DOM hotspot
  // that carries the remove button along with it).
  measurements.measureLabels.forEach(label => {
    if (label.userData && label.userData.type === 'distance') {
      const atom1 = resolveMeasurementAtom(label.userData.atom1Ref, label.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(label.userData.atom2Ref, label.userData.atom2Position);

      if (atom1 && atom2) {
        const pa = atom1.position.clone();
        const pb = atom2.position.clone();
        const midpoint = pa.clone().add(pb).multiplyScalar(0.5);
        (label.userData.anchor ??= midpoint.clone()).copy(midpoint);
        label.userData.lineDir = pb.clone().sub(pa).normalize();
  label.userData.separationLength = label.scale.y * DISTANCE_LABEL_OFFSET;
        setMeasureLabelText(label, `${formatÅ(pa.distanceTo(pb))} Å`, labelStyleFor('distance'));
      }
    } else if (label.userData && label.userData.type === 'angle') {
      const atom1 = resolveMeasurementAtom(label.userData.atom1Ref, label.userData.atom1Position);
      const atom2 = resolveMeasurementAtom(label.userData.atom2Ref, label.userData.atom2Position); // vertex
      const atom3 = resolveMeasurementAtom(label.userData.atom3Ref, label.userData.atom3Position);
      if (atom1 && atom2 && atom3) {
        const toA = atom1.position.clone().sub(atom2.position);
        const toB = atom3.position.clone().sub(atom2.position);
        const vr = getAtomRadius(atom2.userData.element);
        (label.userData.anchor ??= new THREE.Vector3()).copy(atom2.position);
        label.userData.anchorClearance = markerClearance(vr);
        label.userData.separation = angleSeparation(toA, toB, vertexArcRadius(vr, toA.length(), toB.length()));
        setMeasureLabelText(label, `${calculateAngle(atom1, atom2, atom3).toFixed(1)}°`, labelStyleFor('angle'));
      }
    }
    label.userData?.removeHotspot?.position.copy(label.userData.anchor ?? label.position);
  });

  // Update measurement marker sizes to match current atom sizes
  updateMeasurementMarkers();
  resolveLabelPlacement();
}

// --- Label visibility -------------------------------------------------------
//
// The value labels are THREE.Sprites now (see makeMeasureLabelSprite), so the
// GPU depth-tests them per-pixel against atoms, bonds and polyhedra for free
// — a label behind a sphere is clipped by that sphere exactly, including
// partial overlap. None of the JS occlusion machinery this file used to carry
// (camera raycasts, projected-radius overlap tests, tuned distance/pixel
// thresholds) is needed for that any more, and it is all gone: it only ever
// approximated what the depth buffer does natively, and the gaps in that
// approximation were the source of the labels-on-top-of-atoms bugs.
//
// Two things still need per-frame work, both cheap:
//   * the remove-button hotspot is a DOM overlay (CSS2DObject) and CANNOT
//     depth-test, so it gets one ray to decide whether to show at all;
//   * labels that land on top of EACH OTHER on screen still need
//     decluttering, since depth alone won't separate two labels at similar
//     depth.
const _occlusionRaycaster = new THREE.Raycaster();
const _toLabel = new THREE.Vector3();
const _towardCamera = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _worldX = new THREE.Vector3(1, 0, 0);

/** Pixels-per-world-unit at `distanceFromCamera` — how many screen pixels one
 *  world unit (Å) spans there. Orthographic cameras (this app's default) are
 *  distance-independent, driven by zoom alone; perspective shrinks with
 *  distance. Same math CelOutlinePass.js uses for its outline width. Used to
 *  convert a label sprite's world size into the pixel box its remove button
 *  has to pin itself to. */
function pxPerWorldAt(camera, distanceFromCamera, rendererHeight) {
  if (camera.isOrthographicCamera) {
    return (rendererHeight * camera.zoom) / (camera.top - camera.bottom);
  }
  return rendererHeight / (2 * Math.tan((camera.fov * Math.PI / 180) / 2) * Math.max(distanceFromCamera, 1e-3));
}
// The label sits exactly ON the thing it annotates — a distance label at its
// own dashed line's midpoint, an angle label at its vertex atom's centre — so
// depth-testing it against real geometry means its OWN line/atom z-fights
// through the text. Lift it this far toward the camera before rendering.
// Under an orthographic camera this does not move the label on screen at all
// (translation along the view axis is a pure depth change), so it buys the
// clearance for free; under perspective the shift is negligible at this size.
const LABEL_CAMERA_LIFT = 0.45; // world units (Å)
// Gap, in CSS pixels, required between two labels' rendered boxes before they
// count as clear of each other. The test compares actual boxes rather than a
// fixed centre-to-centre radius: a fixed radius neither tracks the Settings
// size slider nor knows that a long "12.000 Å" pill needs more room than a
// short "60.0°" one, and it wrongly reported overlap for labels that had
// already been separated.
const LABEL_DECLUTTER_GAP_PX = 6;
// Overlapping labels are normally resolved by hiding the farther one, which
// is the right call when they merely happen to line up from this camera angle
// — orbiting a little separates them again.
//
// The exception is labels anchored at (essentially) the SAME 3D point — two
// angle measurements sharing one vertex atom, or two distance measurements
// crossing at their common midpoint. Those labels sit on top of each other in
// space, so no camera angle will ever separate them and hiding would
// permanently lose one. Those, and only those, get nudged apart along the
// screen's vertical instead. Hiding remains the fallback if no slot is free.
// Anchors within this distance count as the same point for the rule above.
// Not an exact comparison: two measurements crossing "in the middle" rarely
// land on bit-identical midpoints, and a hard equality test would send those
// down the hiding path. Kept well under a bond length so genuinely distinct
// anchors that merely line up from one camera angle still just hide.
const LABEL_COINCIDENT_ANCHOR = 0.5; // world units (Å)

/** True if `position` is blocked from the camera by opaque scene geometry
 *  nearer than the point itself. Used only for the remove-button hotspot —
 *  the label sprite itself is depth-tested by the GPU. `excludeAtomIndices`
 *  lets a label ignore the atom(s) it is anchored at or beside, and
 *  `vertexAtomIndex` (labels anchored exactly on one atom) additionally
 *  ignores any bond touching that atom, which is part of the same atom's own
 *  "personal space" rather than a separate object in the way. */
function isAnchorOccluded(position, excludeAtomIndices, vertexAtomIndex) {
  const camera = app.camera;
  if (!camera) return false;
  // Deliberately NOT groups.latticeGroup: the unit-cell wireframe is drawn as
  // hairline-thin cylinders (default 0.015 world units), which cannot
  // meaningfully cover anything, but sits exactly where cell-edge atoms are.
  const occluders = [groups.atomsMesh, groups.bondsMesh, groups.polyhedraGroup]
    .filter((o) => o && o.visible);
  if (!occluders.length) return false;

  _toLabel.copy(position).sub(camera.position);
  const dist = _toLabel.length();
  if (!(dist > 0)) return false;
  _occlusionRaycaster.set(camera.position, _toLabel.normalize());
  _occlusionRaycaster.far = dist;

  const structureSrcIndex = fileBrowser.selectedStructure?.periodic?.visibleWrapped?.srcIndex;
  return _occlusionRaycaster.intersectObjects(occluders, true).some((hit) => {
    if (hit.object === groups.atomsMesh) {
      if (hit.instanceId == null || !structureSrcIndex) return true;
      return !excludeAtomIndices?.includes(structureSrcIndex[hit.instanceId]);
    }
    if (hit.object === groups.bondsMesh) {
      if (hit.instanceId == null) return true;
      const srcIndices = getBondByInstanceId(hit.instanceId)?.srcIndices;
      if (!srcIndices) return true;
      const touchesVertex = vertexAtomIndex != null && srcIndices.includes(vertexAtomIndex);
      const bothEndsExcluded = excludeAtomIndices?.includes(srcIndices[0])
        && excludeAtomIndices?.includes(srcIndices[1]);
      return !(touchesVertex || bothEndsExcluded);
    }
    return true; // polyhedra faces
  });
}

/** Face every billboarded marker (the halo ring) at the camera. Cheap: a
 *  handful of markers, one quaternion copy each. */
function updateMarkerBillboards(camera) {
  for (const item of measurements.measureLines) {
    if (!item.userData?.isAtomMarker) continue;
    for (const child of item.children) {
      if (child.userData?.billboard) child.quaternion.copy(camera.quaternion);
    }
  }
}

/** Per-frame label upkeep: declutter labels that collide with each other on
 *  screen, and show/hide each label's remove-button hotspot. Called once per
 *  rendered frame from AnimateModule.js's renderFrameNow, same cadence as
 *  updateChargeBadges(). */
export function updateMeasurementLabelVisibility() {
  const camera = app.camera;
  if (!camera) return;
  const rendererSize = app.labelRenderer?.getSize?.();

  updateMarkerBillboards(camera);

  const labels = measurements.measureLabels;
  camera.getWorldDirection(_towardCamera).negate();
  for (const label of labels) {
    // Where each label sits was decided by resolveLabelPlacement() the last
    // time the measurements changed. Nothing here depends on the camera except
    // the lift, and under an orthographic camera that is a pure depth change
    // which does not move the label on screen at all — so labels stay put
    // while orbiting instead of sliding around.
    label.visible = !label.userData?.duplicateHidden;
    const anchor = label.userData?.anchor;
    if (!anchor) continue;
    const lift = LABEL_CAMERA_LIFT + (label.userData.anchorClearance ?? 0);
    label.position.copy(anchor).addScaledVector(_towardCamera, lift);
    if (label.userData.placementOffset) label.position.add(label.userData.placementOffset);
  }

  const pxPerWorld = rendererSize
    ? pxPerWorldAt(camera, camera.position.distanceTo(app.controls?.target ?? camera.position), rendererSize.height)
    : 0;

  // Declutter: two labels at DIFFERENT points can still line up from one
  // camera angle. Orbiting separates them again, so the farther one is simply
  // hidden — never repositioned, which would make labels move as the view
  // turns. Labels sharing a point are already handled, statically, by
  // resolveLabelPlacement().
  if (rendererSize) {
    const candidates = labels.filter((l) => l.visible).map((label) => {
      const ndc = label.position.clone().project(camera);
      return {
        label,
        distSq: label.position.distanceToSquared(camera.position),
        screenX: (ndc.x * 0.5 + 0.5) * rendererSize.width,
        screenY: (1 - (ndc.y * 0.5 + 0.5)) * rendererSize.height,
        halfW: (label.scale.x * pxPerWorld) / 2,
        halfH: (label.scale.y * pxPerWorld) / 2,
      };
    }).sort((a, b) => a.distSq - b.distSq); // nearest first — nearest wins

    const kept = [];
    for (const candidate of candidates) {
      const overlaps = kept.some((k) =>
        Math.abs(candidate.screenX - k.screenX) < candidate.halfW + k.halfW + LABEL_DECLUTTER_GAP_PX
        && Math.abs(candidate.screenY - k.screenY) < candidate.halfH + k.halfH + LABEL_DECLUTTER_GAP_PX);
      if (overlaps) candidate.label.visible = false;
      else kept.push(candidate);
    }
  }


  // The remove-button hotspot is a DOM overlay with no depth testing of its
  // own, so it follows its label's visibility and additionally hides when the
  // anchor point itself is behind real geometry.
  // Size each remove-button hotspot to its label's ACTUAL on-screen box, so
  // the "x" lands exactly on the pill's top-right corner and grows/shrinks
  // with it (the label is world-scaled, so its pixel size changes with zoom
  // and with the Settings size slider; a fixed-size hotspot drifted away from
  // the corner). The button's own font scales with the pill's height so it
  // stays visually proportional rather than dwarfing a small label.
  for (const label of labels) {
    const hotspot = label.userData?.removeHotspot;
    if (!hotspot) continue;
    hotspot.visible = label.visible && !isAnchorOccluded(
      label.position, label.userData?.excludeAtomIndices, label.userData?.vertexAtomIndex);
    // Follow the label to wherever the declutter pass put it.
    hotspot.position.copy(label.position);
    if (!hotspot.visible || !pxPerWorld) continue;
    const el = hotspot.element;
    if (!el) continue;
    const boxW = Math.max(8, label.scale.x * pxPerWorld);
    const boxH = Math.max(8, label.scale.y * pxPerWorld);
    el.style.width = `${boxW}px`;
    el.style.height = `${boxH}px`;
    // Button diameter tracks the pill height, clamped so it stays clickable
    // when the label is tiny and doesn't balloon when it's large.
    const btnPx = Math.min(20, Math.max(11, boxH * 0.62));
    el.style.setProperty('--measure-remove-size', `${btnPx}px`);
  }
}
