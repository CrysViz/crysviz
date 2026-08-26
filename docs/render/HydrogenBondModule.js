import * as THREE from '../external/three/three.module.js';

import { general, groups, app, fileBrowser } from '../state/store.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { getAtomRadius } from './MeasurementModule.js';
import { requestRender } from './AnimateModule.js';

// --- Hydrogen bond model ---------------------------------------------------
//
// A hydrogen bond is a D-H...A contact: a hydrogen covalently bonded to an
// electronegative DONOR (D) sits close to a second electronegative ACCEPTOR
// (A). It is not a covalent bond (those are handled by BondsFracUpdateModule),
// so it is drawn as a light dashed line, the same visual language the
// measurement tool uses for distances.
//
// Rather than defining a separate donor/acceptor table, we treat every element
// in HBOND_ELEMENTS as able to act as either. The eligible element pairs are
// therefore "H-<electronegative>" (O-H, N-H, F-H, ...). Each such pair present
// in a structure gets its own H...A distance range (a second slider in the
// Bonds tab, alongside the covalent bond-length slider) plus a shared minimum
// D-H...A angle, which together decide whether a given contact is drawn.

// Electronegative elements that can donate (when carrying an H) or accept a
// hydrogen bond. N/O/F are the classic strong set; Cl/S/Br/I cover the common
// weaker acceptors so those structures light up too.
export const HBOND_ELEMENTS = new Set(['N', 'O', 'F', 'Cl', 'S', 'Br', 'I']);

// A hydrogen is treated as covalently bonded to the nearest electronegative
// atom within this distance (Å). Covalent X-H bonds sit near 0.9-1.35 Å, well
// under any sane hydrogen-bond minimum, so this reliably identifies the donor
// without depending on the covalent-bond slider settings.
const DONOR_COVALENT_MAX = 1.4;

// Default H...A distance range (Å) for a newly seen eligible pair. The minimum
// stays clear of covalent X-H distances; the maximum spans a typical moderate
// hydrogen bond.
export const HBOND_DEFAULT = { min: 1.5, max: 2.6 };
export const HBOND_DEFAULT_MIN_ANGLE = 120; // D-H...A angle floor, degrees

// Dashed-line geometry, deliberately a touch thinner than a distance
// measurement so hydrogen bonds read as secondary to real bonds/measurements.
const HBOND_LINE = { dash: 0.14, gap: 0.11, radius: 0.03 };

/** Canonical "H-X" pair key, matching the alphabetical ordering the Bonds tab
 *  uses for its covalent pair keys (so "O-H" is stored as "H-O", etc.). */
export function hbondPairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Is this covalent-bond pair key also a hydrogen-bond-capable pair? i.e. one
 *  side is H and the other is an electronegative donor/acceptor. Returns the
 *  acceptor element, or null. */
export function hydrogenBondAcceptorOf(pairKey) {
  const [e1, e2] = pairKey.split('-');
  if (e1 === 'H' && HBOND_ELEMENTS.has(e2)) return e2;
  if (e2 === 'H' && HBOND_ELEMENTS.has(e1)) return e1;
  return null;
}

/** Eligible "H-X" pairs for a structure, given the elements actually present.
 *  Empty when the structure has no hydrogen or no electronegative partner. */
export function getEligibleHydrogenBondPairs(structure) {
  const elements = structure?.elements;
  if (!elements) return [];
  const unique = new Set(elements);
  if (!unique.has('H')) return [];
  const pairs = [];
  for (const el of unique) {
    if (el === 'H' || !HBOND_ELEMENTS.has(el)) continue;
    pairs.push(hbondPairKey('H', el));
  }
  return pairs;
}

/** Seed the per-pair distance-range defaults / visibility for every eligible
 *  pair in a structure. Idempotent — existing user values are left untouched.
 *  Mirrors initBondsLengths()'s role for covalent bonds. */
export function initHydrogenBondPairs(structure = fileBrowser.selectedStructure) {
  for (const pair of getEligibleHydrogenBondPairs(structure)) {
    if (!general.hydrogenBondLengths[pair]) {
      general.hydrogenBondLengths[pair] = { ...HBOND_DEFAULT };
      general.defaultHydrogenBondLengths[pair] = { ...HBOND_DEFAULT };
    }
    if (general.hydrogenBondVisibility[pair] === undefined) {
      // Default ON: the whole point of surfacing the slider is to see the
      // hydrogen bonds; the toggle is right there to hide them.
      general.hydrogenBondVisibility[pair] = true;
    }
  }
}

/** Reset every hydrogen-bond distance range back to its default (used by the
 *  Bonds tab's "Reset Bond Lengths" button). */
export function resetHydrogenBondLengths() {
  for (const pair in general.defaultHydrogenBondLengths) {
    general.hydrogenBondLengths[pair] = { ...general.defaultHydrogenBondLengths[pair] };
  }
}

/** Compute the D-H...A contacts to draw for the current structure, honouring
 *  each eligible pair's enabled state, distance range and the shared minimum
 *  angle. Returns [{ from:[x,y,z], to:[x,y,z], pair }] over the currently
 *  visible (wrapped, periodic-image-expanded) atom set. */
export function computeHydrogenBonds(structure = fileBrowser.selectedStructure) {
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!wrapped) return [];
  const cart = wrapped.cart;
  const elements = wrapped.elements;
  const n = elements?.length ?? 0;
  if (!n) return [];

  // Which acceptor elements are currently enabled, and with what range.
  const enabledRange = {}; // acceptorElement -> { min, max }
  let anyEnabled = false;
  for (const el of new Set(elements)) {
    if (el === 'H' || !HBOND_ELEMENTS.has(el)) continue;
    const pair = hbondPairKey('H', el);
    if (general.hydrogenBondVisibility[pair] === false) continue;
    const range = general.hydrogenBondLengths[pair];
    if (!range || !(range.max > 0)) continue;
    enabledRange[el] = range;
    anyEnabled = true;
  }
  if (!anyEnabled) return [];

  // Split the atom set once.
  const hIdx = [];
  const accIdx = [];
  for (let i = 0; i < n; i++) {
    const el = elements[i];
    if (el === 'H') hIdx.push(i);
    else if (enabledRange[el]) accIdx.push(i);
  }
  if (!hIdx.length || !accIdx.length) return [];

  const minAngleDeg = general.hydrogenBondMinAngle ?? HBOND_DEFAULT_MIN_ANGLE;
  // angle >= minAngle  <=>  cos(angle) <= cos(minAngle)
  const cosMax = Math.cos((minAngleDeg * Math.PI) / 180);
  const donorMaxSq = DONOR_COVALENT_MAX * DONOR_COVALENT_MAX;

  const contacts = [];
  for (const h of hIdx) {
    const ph = cart[h];
    // Donor = nearest electronegative atom to this H within the covalent
    // ceiling. Restricting to HBOND_ELEMENTS keeps C-H hydrogens (whose
    // nearest heavy neighbour is carbon) from acquiring a spurious donor.
    let donor = -1;
    let donorDistSq = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === h || !HBOND_ELEMENTS.has(elements[j])) continue;
      const pj = cart[j];
      const dx = ph[0] - pj[0], dy = ph[1] - pj[1], dz = ph[2] - pj[2];
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq < donorDistSq) { donorDistSq = dsq; donor = j; }
    }
    if (donor < 0 || donorDistSq > donorMaxSq) continue;

    const pd = cart[donor];
    const hdx = pd[0] - ph[0], hdy = pd[1] - ph[1], hdz = pd[2] - ph[2];
    const hdLen = Math.hypot(hdx, hdy, hdz) || 1;

    for (const a of accIdx) {
      if (a === donor) continue; // the covalent partner is not an acceptor
      const pa = cart[a];
      const hax = pa[0] - ph[0], hay = pa[1] - ph[1], haz = pa[2] - ph[2];
      const dsq = hax * hax + hay * hay + haz * haz;
      const range = enabledRange[elements[a]];
      if (dsq < range.min * range.min || dsq > range.max * range.max) continue;
      const haLen = Math.sqrt(dsq) || 1;
      // D-H...A angle: the angle at H between H->D and H->A. A near-linear
      // (strong) hydrogen bond is ~180 degrees; require it above the floor.
      const cos = (hdx * hax + hdy * hay + hdz * haz) / (hdLen * haLen);
      if (cos > cosMax) continue;
      contacts.push({ from: ph, to: pa, pair: hbondPairKey('H', elements[a]) });
    }
  }
  return contacts;
}

/** Build one dashed line (a group of short cylinders) from `start` to `end`,
 *  trimmed back to each atom's surface, into `parent`. Mirrors the measurement
 *  tool's dashed-cylinder look so the two read as the same visual family. */
function addDashedLine(parent, material, start, end, startTrim, endTrim) {
  const full = start.distanceTo(end);
  if (!(full > 0)) return;
  const usableStart = Math.min(startTrim, full * 0.45);
  const usableEnd = Math.min(endTrim, full * 0.45);
  const distance = full - usableStart - usableEnd;
  if (!(distance > 0)) return;

  const step = new THREE.Vector3().subVectors(end, start).normalize();
  const origin = start.clone().addScaledVector(step, usableStart);
  const segmentLength = HBOND_LINE.dash + HBOND_LINE.gap;
  const count = Math.floor(distance / segmentLength);
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(HBOND_LINE.radius, HBOND_LINE.radius, HBOND_LINE.dash, 10),
      material);
    mesh.position.copy(origin).addScaledVector(step, i * segmentLength + HBOND_LINE.dash / 2);
    mesh.lookAt(end);
    mesh.rotateX(Math.PI / 2);
    parent.add(mesh);
  }
}

/** The dashed-line colour for a given "H-X" pair: its per-pair override, else
 *  the global default. */
export function hydrogenBondColorFor(pair) {
  return general.hydrogenBondColors?.[pair] || general.hydrogenBondColor || '#33d6d6';
}

/** Remove and dispose the hydrogen-bond graphics (leaves the group in the
 *  scene, empty, so a later rebuild can reuse it). */
export function clearHydrogenBonds() {
  const group = groups.hydrogenBondsGroup;
  if (!group) return;
  for (const child of group.children.slice()) {
    child.geometry?.dispose();
    group.remove(child);
  }
  // Dispose the per-colour materials shared across this build's dashes.
  for (const material of group.userData.sharedMaterials ?? []) material.dispose?.();
  group.userData.sharedMaterials = [];
}

/** Recompute and redraw every hydrogen bond for the current structure. Cheap
 *  no-op when nothing is eligible/enabled. Called from updateVisualization so
 *  the lines track atom moves (trajectories), structure switches and slider
 *  edits, exactly like measurements do. */
export function updateHydrogenBonds(structure = fileBrowser.selectedStructure) {
  const contacts = structure ? computeHydrogenBonds(structure) : [];

  // Nothing to draw (feature off, or no qualifying contacts). Only touch the
  // scene if a group already exists with old lines to clear — avoids creating
  // an empty group (and an extra render) on the common no-hydrogen path.
  if (!contacts.length) {
    if (groups.hydrogenBondsGroup?.children.length) {
      clearHydrogenBonds();
      requestRender();
    }
    return;
  }

  // Lazily create the container group.
  let group = groups.hydrogenBondsGroup;
  if (!group) {
    group = groups.hydrogenBondsGroup = new THREE.Group();
    group.name = 'hydrogenBonds';
    group.userData.isHydrogenBonds = true;
    if (app.scene) app.scene.add(group);
  } else if (app.scene && group.parent !== app.scene) {
    // Scene was rebuilt (structure reload) — re-attach.
    app.scene.add(group);
  }
  clearHydrogenBonds();

  const opacity = general.measureLineOpacity ?? 1;
  // One material per distinct colour in use (pairs can be coloured
  // independently), reused across every dash of that colour and disposed
  // together on the next clear.
  const materials = new Map(); // colorHex -> MeshBasicMaterial
  const materialFor = (color) => {
    let material = materials.get(color);
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color, opacity });
      // Route the transparency intent through the active pipeline, same as the
      // measurement ghost lines — never set transparent/depthWrite by hand.
      applyTransparency(material, { kind: 'measureGhost', opacity });
      materials.set(color, material);
    }
    return material;
  };

  const _start = new THREE.Vector3();
  const _end = new THREE.Vector3();
  for (const c of contacts) {
    _start.set(c.from[0], c.from[1], c.from[2]);
    _end.set(c.to[0], c.to[1], c.to[2]);
    const [e1, e2] = c.pair.split('-');
    const acceptorEl = e1 === 'H' ? e2 : e1;
    // Trim the H end minimally (hydrogens are tiny) and the acceptor end to
    // its own surface so the dashes meet the sphere rather than vanish inside.
    addDashedLine(group, materialFor(hydrogenBondColorFor(c.pair)), _start, _end,
      getAtomRadius('H') * 0.8, getAtomRadius(acceptorEl) * 0.9);
  }
  group.userData.sharedMaterials = [...materials.values()];
  requestRender();
}
