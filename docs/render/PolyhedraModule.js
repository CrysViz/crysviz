import * as THREE from '../external/three/three.module.js';
import { ConvexGeometry } from '../external/three/ConvexGeometry.js';
import { ConvexHull } from '../external/three/ConvexHull.js';
import {app,general,groups, fileBrowser, highlightHover} from '../state/store.js'
import { fracToCart, cartToFrac, invert3x3, transpose3x3 } from '../math/index.js'
// Polyhedra use the length-only cutoff: hiding bonds (per-pair visibility)
// must not remove polyhedra — they follow the configured bond distances.
import { getBondLengthCutoff } from '../render/BondsFracUpdateModule.js'
import { findVoidCentres } from './voidSearch.js';
import {disposeGroup} from '../ui/WindowAndSceneControls.js'
import { Polyhedra } from '../model/Polyhedra.js'
import { Polyhedron } from '../model/Polyhedron.js'
import { getCutPlaneMaskSign } from '../model/Plane.js'
import { CUT_PLANE_TOLERANCE } from './cutPlaneTolerance.js'
import { voronoiNeighbours } from '../render/VoronoiNeighbours.js'
import { atomicRadii } from '../defaults/radii_defaults.js'
import { electronegativity, ANION_FORMERS } from '../defaults/electronegativity_defaults.js'
import { colorHexToCss } from '../utils/ColorModule.js'
import { getFocusOpacityForPolyhedron } from './FocusRegionModule.js'
import {
  buildPolyhedraTable, addPolyhedraObjects, setPolyStyle, setPolyFocus, setPolyColorRGB, uploadPolyStyles,
  setPolyGlow, setPolyEdgeLinewidth, polyColorHex, polyIndexOfKey, polyIndicesOfGroup, polyPaintOverride,
} from './PolyhedraMesh.js'
import { computePolyhedraWasm } from '../compiled/polyhedraWasm.js'
import { computePolyhedraParallel, parallelAvailable } from '../render/polyhedraWorkerPool.js'
import { rebuildAtoms } from '../render/AtomsFracUpdateModule.js'
import { rebuildBonds } from '../render/BondsFracUpdateModule.js'
import { runPeriodicWrapped, normalizePeriodicBounds } from '../render/LatticeModule.js'
import { updatePolyhedraComparisonWarning } from '../ui/PolyhedraComparisonWarningBanner.js'
import { updateDisorderWarning, structureHasFractionalOccupancy } from '../ui/DisorderWarningBanner.js'
import { updatePolyhedraFastNotice } from '../ui/PolyhedraFastNotice.js'
import {
  captureTopology, applyPolyhedraPropertyColors, mergeToleranceHeldPolyhedra, polyhedraToleranceSignature,
} from './PolyhedraFrameModule.js'

// Single-flight guard for the async compute. Only one compute runs at a time; any
// updatePolyhedra() request that arrives while one is in flight sets `polyhedraDirty`
// instead of starting another, so the in-flight loop re-runs and always finishes by
// reflecting the LATEST state (bond lengths, colours, toggles, selected structure) — and
// the workers are never flooded with superseded jobs.
let polyhedraBusy = false;
let polyhedraDirty = false;
let polyhedraPromise = null;

// Bookkeeping for every path that replaces the displayed polyhedra group:
// invalidate the Poly tab's lazy row lists (build counter), drop the (now
// mesh-less) selection, and tell the panel to re-render. A DOM CustomEvent is
// used instead of a render→ui import to respect the layering.
function notifyPolyhedraRebuilt() {
  general.polyhedraBuildCounter = (general.polyhedraBuildCounter || 0) + 1;
  highlightHover.currentlyHighlightedPolyhedron = null;
  highlightHover.currentlyHighlightedPolyIndices = []; // rows of the old table
  document.dispatchEvent(new CustomEvent('crysviz:polyhedra-rebuilt'));
}

// Same DOM-event pattern as notifyPolyhedraRebuilt() above, for colour-only
// edits: most recolours already call updatePolyhedraColors() (below) to keep
// the main view's polyhedra faces in sync, and updateVisualization() (see
// core/crystal-viewer.js) fires this too as a broad safety net — but a
// handful of paths (an individual bond's own color editor) mutate bond
// instance colors directly without going through either, so they call this
// exported helper themselves. Any listener — e.g. the Polyhedron Inspector's
// mini render, which resolves its own atom/bond/face colours fresh on every
// update — gets a single place to learn "a colour just changed".
export function notifyColorsChanged() {
  document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
}

function clearPolyhedraGroup() {
  if (groups.polyhedraGroup) disposeGroup(groups.polyhedraGroup);
  groups.polyhedraGroup = new THREE.Group();
  app.scene.add(groups.polyhedraGroup);
  notifyPolyhedraRebuilt();
}

// ---------- STYLE (render) ----------
const FACE_OPACITY = 0.50;
const EDGE_OPACITY = 1;
const FACE_FALLBACK_COLOR = 0x00aaff;
const EDGE_COLOR = 0x000000;
// Feature-edge angle (18°), double-sided faces and the face material live with
// the one-mesh drawing in render/PolyhedraMesh.js. Transparency-related face
// flags (depthWrite, polygonOffset) are the rendering pipeline's policy:
// 'polyhedraFace' in render/pipeline/ForwardPipeline.js.

// ---------- BEHAVIOR (compute) ----------
// Cages (uncentred): empty closed shells of mutually bonded framework atoms —
// B12 icosahedra and B6 octahedra, clathrate Si20/Si24 cages, C60, cubane,
// dodecahedrane, P4. Found from the empty space, see findCages() below.
// Mirrored in periodic_wasm_src (polyhedra.rs, find_cages).
const ALLOW_CAGES = true;
// Void-grid constants (CAGE_GRID_STEP, CAGE_SPLAT_RADIUS, CAGE_MIN_VOID, ...) live in voidSearch.js.
const CAGE_SHELL_TOL = 1.35;         // shell: framework atoms within 1.35 × the nearest one…
const CAGE_SHELL_PAD = 0.6;          // …or within nearest + 0.6 Å, whichever is larger
const CAGE_SHELL_CAP = 6.5;          // Å, atoms gathered around a void
const CAGE_REFINE_ITERS = 8;         // re-centring steps before a shell must be stable
const CAGE_MIN_SURFACE_SHARE = 0.6;  // share of an atom's framework bonds lying in the shell
const CAGE_MIN_THICKNESS = 0.15;     // anti-flatness of the shell (rings are not cages)

const MIN_THICKNESS_RATIO = 0.08;  // very lenient anti-flatness (e_min / e_max)
const MIN_CENTER_FACE_CLEARANCE_REL = 0.10; // min portion of atomic radius between center and any face (to avoid near-degenerate centered polyhedra)

// Centered neighbour selection: radical Voronoi + solid-angle (see VoronoiNeighbours.js).
// There is no universal "official" cutoff — these are the tunables.
const VORONOI_RADICAL = true;       // weight planes by atomic radii (power/radical Voronoi)
const VORONOI_SOLID_ANGLE_REL = 0.10; // keep faces ≥ this fraction of the largest face
// Candidate-gather radius around a centre (all species, so closer atoms can shadow
// farther ones). Generous enough to bound the Voronoi cell; the cell math then
// ignores far atoms. Clamped so it stays cheap.
function searchRadius(maxCutoff) {
  return Math.min(8.0, Math.max(4.0, 2.5 * maxCutoff));
}

// Chemical filter: a polyhedron vertex must be MORE electronegative than the
// centre, i.e. the anion/ligand coordinates the cation (and a cation never
// coordinates another cation, nor does an anion-centred polyhedron form). When an
// electronegativity value is missing for either element, fall back to requiring a
// different species (which at least blocks the Ti-around-Ti case).
function isLigandOf(nbrElem, centerElem, filterByElectronegativity = true) {
  const enN = electronegativity[nbrElem];
  const enC = electronegativity[centerElem];
  if (enN === undefined || enC === undefined || enN === 0 || enC === 0 || !filterByElectronegativity) {
    return nbrElem !== centerElem;
  }
  return enN > enC + 1e-6;
}

// Second-shell cations. The electronegativity rule alone lets any LESS
// electropositive cation in: around Ca (1.00) in diopside that is Si (1.90)
// and Mg (1.31), both inside the default Ca–Si / Ca–Mg cutoffs, and the Ca
// polyhedron came out with 17 corners (8 O + 6 Si + 3 Mg) instead of 8 O. So
// a candidate is dropped when it is bonded to a more electronegative anion
// former (a nonmetal or metalloid, ANION_FORMERS) that sits clearly nearer to
// the centre: it is a neighbouring cation seen THROUGH that anion (Ca–O–Si).
//
// "Clearly nearer" is d(centre, anion) < BRIDGE_NEARER × d(centre, candidate).
// Over 313 test structures every cation behind an anion came out at a ratio
// of 0.882 or less (perovskites, phosphates, chlorates, YBCO, LiNbO3, MgAgAs,
// K3AsS4), while atoms of one anionic layer sit side by side at 0.92 or more:
// the B and C of LiBC (1.00) and MgB2C2 are both corners of the Li/Mg between
// the layers. A partner farther out than the candidate never counts, so Fe–C≡N in
// Prussian blue, M–C≡O and ferrocene's carbons keep their corners; a metal
// partner never counts either, since in an alloy every atom touches every
// other and Ni or Mo would strip the Fe corners off a Cr site.
//
// The bond to the anion gets BRIDGE_BOND_SLACK on the default cutoff, which
// is too short for some cations: Pb–O in PbZrO3 is 2.9 Å against 2.54 Å. Only
// a bond to an anion that already sits between the two can count, so a
// contact between two separate ligands (O···Cl ≈ 3 Å vs 1.25 × 2.0) never
// does. Mirrored in periodic_wasm_src (polyhedra.rs, is_bridged_cation).
//   cand:   the vertex candidate {elem, pos, d}
//   cands:  every atom gathered around the centre (same objects)
const BRIDGE_NEARER = 0.9;
const BRIDGE_BOND_SLACK = 1.25;

function isBridgedCation(cand, cands) {
  const enB = electronegativity[cand.elem];
  if (!enB) return false;
  for (const x of cands) {
    if (x === cand || !ANION_FORMERS.has(x.elem)) continue;
    const enX = electronegativity[x.elem];
    if (!enX || enX <= enB + 1e-6) continue;
    if (!(x.d < BRIDGE_NEARER * cand.d)) continue;
    const cut = getBondLengthCutoff(cand.elem, x.elem);
    if (cut > 1e-3 && x.pos.distanceTo(cand.pos) <= cut * BRIDGE_BOND_SLACK) return true;
  }
  return false;
}

// ConvexGeometry constructor (vendored addon; fall back to THREE.ConvexGeometry if present)
const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined')
  ? ConvexGeometry
  : (THREE && THREE.ConvexGeometry ? THREE.ConvexGeometry : null);

// Face color for a coordination polyhedron: the central element's atom color
// (falls back to the default blue if unavailable). Previously referenced via a
// `typeof getElementColor === 'function'` guard but never actually defined, so
// polyhedra always rendered with the fallback color.
function getElementColor(element) {
  const colors = fileBrowser.selectedStructure?.getElementColors?.()[element];
  return (colors && colors.length) ? colors[0] : FACE_FALLBACK_COLOR;
}

// Face colour for a polyhedron. A CENTERED polyhedron takes its centre ATOM's colour, so
// editing one atom's colour recolours just its polyhedron — and an element-wide change (which
// recolours every atom of the element) still works. Cages have no centre atom → element colour.
// Returns a CSS string or a hex number; THREE.Color.set accepts either.
export function polyhedronFaceColor(type, centerIndex, colorElem) {
  if (type === 'centered' && Number.isInteger(centerIndex)) {
    const atom = fileBrowser.selectedStructure?.atoms?.[centerIndex];
    if (atom) return colorHexToCss(atom.getColor());
  }
  return getElementColor(colorElem);
}

// ---------- IDENTITY / CATEGORIES / USER STYLES ----------

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

/** Alphabetical composition string of a polyhedron's vertex elements, e.g. "O6", "N2O4". */
function vertexComposition(structure, poly) {
  const counts = {};
  for (const src of poly.vertexSrcList ?? []) {
    const el = structure.elements[src];
    if (el) counts[el] = (counts[el] || 0) + 1;
  }
  return Object.keys(counts).sort()
    .map((el) => `${el}${counts[el] > 1 ? counts[el] : ''}`)
    .join('');
}

/**
 * Stable identity + category for one polyhedron, derived post-hoc from the model
 * geometry so it is identical across all three compute paths (JS / WASM serial /
 * result-reordering parallel workers), which do not surface the image shift.
 * - centered: key = center source index + periodic image shift of the shell
 *   (vertex centroid rounds to the correct image since the center sits inside);
 *   category = center element + vertex composition (label "CuO6").
 * - cage: key = sorted vertex source indices + centroid cell (disambiguates
 *   periodic image copies); category = composition + coordination number.
 * @returns {{key: string, groupKey: string, catKey: string, label: string}}
 */
function polyhedronIdentity(structure, poly, latInv) {
  let cx = 0, cy = 0, cz = 0;
  for (const p of poly.vertices) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const n = poly.vertices.length || 1;
  const frac = cartToFrac([cx / n, cy / n, cz / n], structure.lattice, latInv);
  const comp = vertexComposition(structure, poly);
  if (poly.type === 'centered' && Number.isInteger(poly.centerIndex)) {
    const center = structure.atoms[poly.centerIndex]?.position ?? [0, 0, 0];
    const shift = [0, 1, 2].map((i) => Math.round(frac[i] - center[i])).join(',');
    return {
      key: `c:${poly.centerIndex}:${shift}`,
      groupKey: `c:${poly.centerIndex}`, // all periodic-image copies of this center
      catKey: `c:${poly.centerElement}:${comp}`,
      label: `${poly.centerElement}${comp}`,
    };
  }
  const srcs = [...(poly.vertexSrcList ?? [])].sort((a, b) => a - b).join(',');
  const cell = [0, 1, 2].map((i) => Math.floor(frac[i])).join(',');
  return {
    key: `g:${srcs}:${cell}`,
    groupKey: `g:${srcs}`, // all periodic-image copies of this cage
    catKey: `g:${comp}:${poly.numVertices}`,
    label: `${comp} cage · CN ${poly.numVertices}`,
  };
}

/** What decides the polyhedra besides the positions and the bond cutoffs:
 *  the search mode and settings (a bond breaking tolerance memory made under
 *  others is dropped). */
function polyhedraSearchSettings(structure) {
  let settings = '';
  try { settings = JSON.stringify(structure?.polyhedraSettings ?? null); } catch { /* unserialisable */ }
  return `${effectivePolyhedraMode(structure)}|${settings}|${general.showPeriodic ? 1 : 0}`;
}

/** Strip the periodic-image segment from a polyhedron key ("c:5:0,0,1" -> "c:5"). */
export function polyhedronGroupKey(key) {
  const s = String(key);
  const i = s.lastIndexOf(':');
  return i > 0 ? s.slice(0, i) : s;
}

/** Stamp poly.key / poly.catKey / poly.catLabel onto every model polyhedron. */
function assignPolyhedraKeys(structure, model) {
  if (!model?.polyhedra?.length || !structure?.lattice) return;
  const latInv = invert3x3(transpose3x3(structure.lattice));
  for (const poly of model.polyhedra) {
    const id = polyhedronIdentity(structure, poly, latInv);
    poly.key = id.key;
    poly.groupKey = id.groupKey;
    poly.catKey = id.catKey;
    poly.catLabel = id.label;
  }
}

/**
 * Group the current structure's polyhedra for the Poly tab.
 * @returns {Map<string, {label: string, type: string, cn: number, indices: number[]}>}
 *   indices index into structure.polyhedra.polyhedra.
 */
export function groupPolyhedraByCategory(structure) {
  const map = new Map();
  const polys = structure?.polyhedra?.polyhedra ?? [];
  polys.forEach((poly, i) => {
    if (!poly.catKey) return; // keys not assigned yet (no lattice / stale model)
    let entry = map.get(poly.catKey);
    if (!entry) {
      entry = { label: poly.catLabel, type: poly.type, cn: poly.numVertices, indices: [] };
      map.set(poly.catKey, entry);
    }
    entry.indices.push(i);
  });
  return map;
}

/** The Poly tab's element-row key of a category: its centre element
 *  ("c:Ca:O8" -> "Ca"), or 'cage' for every cage category ("g:…"). */
export function polyhedraElementKeyOf(catKey) {
  if (!catKey) return null;
  return catKey.startsWith('c:') ? catKey.split(':')[1] : 'cage';
}

/**
 * Resolve the effective style for one polyhedron: individual override >
 * category override > element override (the Poly tab's element row,
 * structure.polyhedraElementStyles) > default (center-atom/element color,
 * FACE_OPACITY, EDGE_COLOR/EDGE_OPACITY for the edge lines).
 * `visible` is a category/element-level setting only.
 * @returns {{color: string|number, opacity: number, visible: boolean,
 *            edgeColor: string|number, edgeOpacity: number}}
 */
export function resolvePolyhedronStyle(structure, key, catKey, type, centerIndex, colorElem) {
  structure.polyhedraUserStyles ??= {}; // defensive: pre-existing structures
  structure.polyhedraCategoryStyles ??= {};
  structure.polyhedraElementStyles ??= {}; // files from before the element rows
  const ind = key ? structure.polyhedraUserStyles[key] : null;
  const cat = catKey ? structure.polyhedraCategoryStyles[catKey] : null;
  const el = catKey ? structure.polyhedraElementStyles[polyhedraElementKeyOf(catKey)] : null;
  return {
    color: ind?.color ?? cat?.color ?? el?.color ?? polyhedronFaceColor(type, centerIndex, colorElem),
    opacity: clamp01(ind?.alpha ?? cat?.alpha ?? el?.alpha ?? FACE_OPACITY),
    visible: (cat?.visible ?? el?.visible) !== false,
    edgeColor: ind?.edgeColor ?? cat?.edgeColor ?? el?.edgeColor ?? EDGE_COLOR,
    edgeOpacity: clamp01(ind?.edgeAlpha ?? cat?.edgeAlpha ?? el?.edgeAlpha ?? EDGE_OPACITY),
  };
}

// Framework bond for cage detection (chemical filter on). A cage is a shell of
// atoms bonded to EACH OTHER: Si–Si in a clathrate, B–B, C–C in cubane, P–P,
// or metal–metal in an intermetallic. Not framework: a metal–nonmetal bond
// (that is a coordination bond — the nonmetal is the metal's ligand), and a
// metal–metal contact both of whose atoms bond to one more electronegative
// anion former (two cations sharing an anion, Ti–O–Ti in rutile, which the
// default cutoffs also call a bond). Without this, ordinary oxides showed
// "cages" of Ti2O2 or Al2O2, and those swallowed the real octahedra (ilmenite,
// LiNbO3) as nested. Mirrored in polyhedra.rs (is_framework_bond).
//   ei, ej:     element symbols; nbrI: atom i's neighbour images; posJ: j's image
//   elements:   element symbol per source atom
function isFrameworkBond(ei, ej, nbrI, posJ, elements) {
  const afI = ANION_FORMERS.has(ei), afJ = ANION_FORMERS.has(ej);
  if (afI !== afJ) return false;
  if (afI) return true;
  const enMax = Math.max(electronegativity[ei] || 0, electronegativity[ej] || 0);
  for (const x of nbrI) {
    const ex = elements[x.srcJ];
    if (!ANION_FORMERS.has(ex) || !((electronegativity[ex] || 0) > enMax + 1e-6)) continue;
    const cut = getBondLengthCutoff(ej, ex);
    if (cut > 1e-3 && x.pos.distanceTo(posJ) <= cut) return false;
  }
  return true;
}

// ---------- Helpers ----------
function thicknessRatio(points) {
  const mean = points.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/points.length);
  const rel  = points.map(p=>p.clone().sub(mean));
  let xx=0,xy=0,xz=0, yy=0,yz=0, zz=0;
  for (const v of rel) { const x=v.x,y=v.y,z=v.z; xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z; }
  const n = Math.max(1, rel.length);
  xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
  const m00=xx, m01=xy, m02=xz, m11=yy, m12=yz, m22=zz;
  const p1 = m01*m01 + m02*m02 + m12*m12;
  let eMin=0,eMax=0;
  if (p1 <= 1e-18) { const e=[m00,m11,m22].sort((a,b)=>a-b); eMin=e[0]; eMax=e[2]; }
  else {
    const q=(m00+m11+m22)/3;
    let p2=(m00-q)*(m00-q)+(m11-q)*(m11-q)+(m22-q)*(m22-q)+2*p1;
    const p=Math.sqrt(p2/6);
    const b00=(m00-q)/p, b01=m01/p,   b02=m02/p;
    const b10=m01/p,   b11=(m11-q)/p, b12=m12/p;
    const b20=m02/p,   b21=m12/p,     b22=(m22-q)/p;
    const detB = b00*(b11*b22-b12*b21)-b01*(b10*b22-b12*b20)+b02*(b10*b21-b11*b20);
    const r = Math.max(-1, Math.min(1, detB/2));
    const phi = Math.acos(r)/3;
    const eig1 = q + 2*p*Math.cos(phi);
    const eig3 = q + 2*p*Math.cos(phi + 2*Math.PI/3);
    const eig2 = 3*q - eig1 - eig3;
    const ev=[eig1,eig2,eig3].sort((a,b)=>a-b);
    eMin=ev[0]; eMax=ev[2];
  }
  return eMin / Math.max(1e-12, eMax);
}

// Nesting margin (Å). A point counts as inside a hull only when it is at least
// this far inside every face. A point ON a face — the Al centre of MnAlCu2 is a
// corner of the Mn polyhedron — is not nested; with a 1e-6 tolerance rounding
// decided it, and the JS and WASM paths (which also scaled it differently) kept
// different polyhedra. Mirrors NEST_MARGIN in polyhedra.rs.
const NEST_MARGIN = 0.01;

function pointInsideConvexGeometry(p, geom, margin = NEST_MARGIN) {
  const pos = geom.getAttribute('position');
  const idx = geom.getIndex();
  if (!pos) return false;
  const pc = new THREE.Vector3();
  for (let i=0;i<pos.count;i++) pc.add(new THREE.Vector3().fromBufferAttribute(pos, i));
  pc.multiplyScalar(1/pos.count);
  const triCount = idx ? idx.count/3 : pos.count/3;
  for (let t=0; t<triCount; t++) {
    const i0 = idx ? idx.getX(3*t+0) : 3*t+0;
    const i1 = idx ? idx.getX(3*t+1) : 3*t+1;
    const i2 = idx ? idx.getX(3*t+2) : 3*t+2;
    const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i2);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-18) continue;
    n.normalize();
    const outward = Math.sign(n.dot(a.clone().sub(pc))) || 1;
    n.multiplyScalar(outward);
    const s = n.dot(new THREE.Vector3().subVectors(p, a));
    if (s > -margin) return false;
  }
  return true;
}

function centeredHullIsAcceptable(centerPos, centerRadius, posList, eps = 1e-6) {
  const hull = new ConvexHull().setFromPoints(posList);
  if (!hull.containsPoint(centerPos)) return false;

  const minClearance = MIN_CENTER_FACE_CLEARANCE_REL * Math.max(centerRadius, 0);
  for (const face of hull.faces) {
    const signedDistance = face.distanceToPoint(centerPos);
    if (signedDistance > eps) return false;
    if (-signedDistance < minClearance - eps) return false;
  }

  return true;
}

function imageKey(src, shift) {
  return `${src}:${shift[0]},${shift[1]},${shift[2]}`;
}

function getActiveCutPlanes() {
  return (general.atomCutPlanes || []).filter((plane) => plane?.enabled);
}

function normalizeCutPlaneNormal(x = 1, y = 0, z = 0) {
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const nz = Number(z) || 0;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) return [1, 0, 0];
  return [nx / length, ny / length, nz / length];
}

function isPointCutByPlanes(position, cutPlanes) {
  if (!Array.isArray(position) || position.length < 3) return false;
  return cutPlanes.some((plane) => {
    const [nx, ny, nz] = normalizeCutPlaneNormal(plane.x, plane.y, plane.z);
    const maskSign = getCutPlaneMaskSign(plane.side);
    const planeSide = ((position[0] * nx) + (position[1] * ny) + (position[2] * nz) - (Number(plane.r) || 0)) * maskSign;
    return planeSide > CUT_PLANE_TOLERANCE;
  });
}

function isAtomImageVisible(position, atom, cutPlanes) {
  if (atom?.hidden) return false;
  if (!cutPlanes.length) return true;
  if (atom?.cutPlaneImmune) return true;
  return !isPointCutByPlanes(position, cutPlanes);
}

// ---------- Search mode (Features ▸ Show Polyhedra ▸ Fast | Auto | Advanced) ----------

/**
 * The search computePolyhedra runs for `structure`: general.polyhedraMode when
 * it is 'fast' or 'advanced'; for 'auto', fast from general.polyhedraFastMin
 * atoms on (structure.atoms.length, see the note in state/store.js).
 * @param {any} [structure]
 * @returns {'fast' | 'advanced'}
 */
export function effectivePolyhedraMode(structure = fileBrowser.selectedStructure) {
  const setting = general.polyhedraMode;
  if (setting === 'fast' || setting === 'advanced') return setting;
  const min = Number(general.polyhedraFastMin);
  return (structure?.atoms?.length ?? 0) >= (Number.isFinite(min) ? min : 2000) ? 'fast' : 'advanced';
}

/**
 * Tell the Features window's status line and the Polyhedra window's greyed
 * rows which search runs (a DOM event, as notifyPolyhedraRebuilt, to keep
 * render → ui loose). Sent by computePolyhedra and by every updatePolyhedra,
 * so a structure switch updates them while polyhedra are off too.
 * @param {any} [structure]
 */
function announcePolyhedraMode(structure = fileBrowser.selectedStructure) {
  document.dispatchEvent(new CustomEvent('crysviz:polyhedra-mode', {
    detail: {
      mode: effectivePolyhedraMode(structure),
      setting: general.polyhedraMode,
      atoms: structure?.atoms?.length ?? 0,
    },
  }));
}

/**
 * Compute coordination polyhedra for a structure and return them as a model
 * `Polyhedra` (plain data; no GPU resources). ConvexGeometry is used transiently
 * here only to validate shape and test nesting; the hull is rebuilt for display
 * in {@link renderPolyhedra}.
 *
 * @param {any} structure active Structure (needs `atoms`, `elements`, `lattice`)
 * @returns {Polyhedra | Promise<Polyhedra>} serial paths return synchronously; the
 *   parallel (Web Worker) path returns a Promise. `updatePolyhedra` awaits either.
 */
export function computePolyhedra(structure) {
  if (!ConvexGeomCtor) {
    console.error('[computePolyhedra] ConvexGeometry missing. Load examples/jsm/geometries/ConvexGeometry.js');
    return new Polyhedra({ polyhedra: [] });
  }

  // Fast mode: hull of the bonded ligands (cutoff + the chemical filter applied
  // to those neighbours only), no Voronoi selection and no cages; see the fast
  // block in periodic_wasm_src/src/polyhedra.rs (build_candidates) and
  // runJsPath below.
  const polyMode = effectivePolyhedraMode(structure);
  const simple = polyMode === 'fast';
  const useChemicalFilter = structure?.polyhedraSettings?.useChemicalFilter !== false;
  const detectCages = !simple && structure?.polyhedraSettings?.detectCages !== false;
  updatePolyhedraFastNotice(structure, polyMode);
  announcePolyhedraMode(structure);

  // ---------- Perf timing ----------
  const _t0 = performance.now();
  let _tSetup = _t0, _tCentered = _t0, _tCages = _t0;
  let _cagePoolMs = 0; // time spent building per-seed BFS pools (subset of cages)

  // ---------- Periodic-image neighbour graph ----------
  const positions = structure.atoms.map(a => a.position); // fractional
  const elements = [...structure.elements];
  const lattice = structure.lattice.map(r => [...r]);

  // Lattice vectors + primary-cell Cartesian positions of every atom.
  const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
  const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
  const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);
  const baseCart = fracToCart(positions, lattice).map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const nAtoms = baseCart.length;
  const latInv = invert3x3(transpose3x3(lattice));
  const dispWrapped = structure.periodic?.visibleWrapped;
  const activeCutPlanes = getActiveCutPlanes();

  // Build the set of wrapped base images eligible to act as displayed centres.
  // This follows the shared atom display surface (`periodic.wrapped`) so the
  // periodic-image toggles still control which centre images exist. Candidate
  // vertices are cut-plane filtered separately and are not required to already
  // exist in `wrapped`.
  const centerImageKeys = new Set();
  /** @type {Array<{cart:THREE.Vector3, src:number, shift:[number,number,number]}>} */
  let displayCenters = [];
  // Only the BASE atoms are polyhedra centers. "Complete Polyhedra" appends extra atoms to
  // `wrapped` (after `baseCount`); excluding them here keeps the completion exactly one level
  // deep (completing atoms are shown but never seed their own polyhedra).
  const baseCount = (typeof dispWrapped?.baseCount === 'number')
    ? dispWrapped.baseCount
    : (dispWrapped?.frac?.length ?? 0);
  if (dispWrapped?.frac?.length && dispWrapped?.srcIndex?.length) {
    for (let i = 0; i < baseCount; i++) {
      const src = dispWrapped.srcIndex[i];
      if (!Number.isInteger(src) || src < 0 || src >= positions.length) continue;
      const frac = dispWrapped.frac[i];
      if (!Array.isArray(frac) || frac.length < 3) continue;
      const cart = dispWrapped?.cart?.[i];
      const cartVec = cart instanceof THREE.Vector3
        ? cart.clone()
        : new THREE.Vector3(
            Number(cart?.[0] ?? frac[0]) || 0,
            Number(cart?.[1] ?? frac[1]) || 0,
            Number(cart?.[2] ?? frac[2]) || 0,
          );
      if (!isAtomImageVisible(cartVec.toArray(), structure.atoms[src], activeCutPlanes)) continue;
      const shift = /** @type {[number,number,number]} */ ([
        Math.round(frac[0] - positions[src][0]),
        Math.round(frac[1] - positions[src][1]),
        Math.round(frac[2] - positions[src][2]),
      ]);
      const key = imageKey(src, shift);
      centerImageKeys.add(key);
      displayCenters.push({ cart: cartVec, src, shift });
    }
  }
  if (!centerImageKeys.size) {
    for (let i = 0; i < nAtoms; i++) {
      if (!isAtomImageVisible(baseCart[i].toArray(), structure.atoms[i], activeCutPlanes)) continue;
      centerImageKeys.add(imageKey(i, [0, 0, 0]));
      displayCenters.push({ cart: baseCart[i].clone(), src: i, shift: [0, 0, 0] });
    }
  }

  // Largest configured bond cutoff — bounds the neighbour-image search range.
  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {}).map(v => (typeof v === 'number' ? v : (v?.max ?? 0))), 0.0);

  // ---------- Compute-path dispatch (parallel WASM → serial WASM → pure JS) ----------
  // The display-coupled prep above (displayCenters, centerImageKeys, maxCutoff) is
  // shared. `prep` is the input bundle for the WASM paths; the pure-JS implementation
  // (runJsPath) stays as the final fallback.
  const seedVisible = new Uint8Array(nAtoms);
  const cutPlaneImmune = new Uint8Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    seedVisible[i] = isAtomImageVisible(baseCart[i].toArray(), structure.atoms[i], activeCutPlanes) ? 1 : 0;
    cutPlaneImmune[i] = structure.atoms[i]?.cutPlaneImmune ? 1 : 0;
  }
  const cutPlaneData = activeCutPlanes.map((plane) => {
    const [nx, ny, nz] = normalizeCutPlaneNormal(plane.x, plane.y, plane.z);
    return [nx, ny, nz, Number(plane.r) || 0, getCutPlaneMaskSign(plane.side)];
  });
  // With periodic images shown, a cage on the cell boundary is drawn at every
  // image the display bounds hold, by the rule the atoms follow
  // (render/LatticeModule.js periodicWrapped): [min − tol, max + tol] per axis.
  // null: one copy, centre in the cell.
  const faceTol = general.periodicFaceTol ?? 1e-3;
  const cageBounds = general.showPeriodic
    ? normalizePeriodicBounds(general.periodicBounds).map(([lo, hi]) => [lo - faceTol, hi + faceTol])
    : null;
  const prep = {
    positions, elements, lattice, maxCutoff,
    useChemicalFilter, detectCages, simple, cageBounds,
    displayCenters, centerImageKeys, seedVisible, cutPlaneImmune, cutPlaneData,
    getBondCutoff: getBondLengthCutoff, // length-only (visibility-independent)
  };

  // Serial WASM (one call) → model.
  const runWasmSerial = () => {
    const { polyhedra, timing } = computePolyhedraWasm(prep);
    const ms = (x) => x.toFixed(1);
    console.log(
      `[polyhedra] WASM total=${ms(performance.now() - _t0)}ms ` +
      `(setup=${ms(timing.setup)} centered=${ms(timing.centered)} ` +
      `cages=${ms(timing.cages)}(pool=${ms(timing.cagePool)} band=${ms(timing.cageBand)}[built=${timing.bandsBuilt} skip=${timing.bandsSkipped}] nloop=${ms(timing.cageNloop)}) ` +
      `accept=${ms(timing.accept)}) | ` +
      `atoms=${nAtoms} centers=${displayCenters.length} ` +
      `accepted=${polyhedra.length} mode=${polyMode} detectCages=${detectCages}`
    );
    return new Polyhedra({ polyhedra: polyhedra.map(p => new Polyhedron(p)) });
  };

  // Serial path: WASM if enabled (JS on failure), else pure JS.
  const serialModel = () => {
    if (general.useWasmPolyhedra) {
      try { return runWasmSerial(); }
      catch (err) { console.warn('[computePolyhedra] WASM path failed; falling back to JS:', err); }
    }
    return runJsPath();
  };

  // Parallel over Web Workers when enabled, available, and the system is large enough to
  // amortise worker overhead; falls back to the serial model on any failure.
  const PARALLEL_MIN = 1000; // combined centers + atoms
  if (general.useWasmPolyhedra && !general.serialPolyhedraAlgorithm
      && parallelAvailable() && (displayCenters.length + nAtoms) >= PARALLEL_MIN) {
    return computePolyhedraParallel(prep)
      .then((polys) => {
        const accepted = polys.map(p => new Polyhedron(p));
        console.log(
          `[polyhedra] WASM-parallel total=${(performance.now() - _t0).toFixed(1)}ms ` +
          `atoms=${nAtoms} centers=${displayCenters.length} accepted=${accepted.length} ` +
          `mode=${polyMode} detectCages=${detectCages}`
        );
        return new Polyhedra({ polyhedra: accepted });
      })
      .catch((err) => {
        console.warn('[computePolyhedra] parallel path failed; falling back to serial:', err);
        return serialModel();
      });
  }
  return serialModel();

  // ---------- Pure-JS implementation (final fallback) ----------
  function runJsPath() {
  // Guaranteed-complete image range per axis (JS path): how many cells the largest
  // bond cutoff can reach, using the cell's perpendicular widths d = V/|b×c| so no
  // neighbour image is ever missed, even for skewed cells.
  const cellVol = Math.abs(a.dot(new THREE.Vector3().crossVectors(b, c)));
  const widthA = cellVol / Math.max(new THREE.Vector3().crossVectors(b, c).length(), 1e-9);
  const widthB = cellVol / Math.max(new THREE.Vector3().crossVectors(c, a).length(), 1e-9);
  const widthC = cellVol / Math.max(new THREE.Vector3().crossVectors(a, b).length(), 1e-9);
  const nA = Math.max(1, Math.ceil(maxCutoff / Math.max(widthA, 1e-6)));
  const nB = Math.max(1, Math.ceil(maxCutoff / Math.max(widthB, 1e-6)));
  const nC = Math.max(1, Math.ceil(maxCutoff / Math.max(widthC, 1e-6)));

  /**
   * Every periodic image of any atom that lies within its bond cutoff of point P
   * (which may sit anywhere, not only in the primary cell). Searches the ±n image
   * ring around the cell containing P, so it stays complete even far from origin.
   * @param {THREE.Vector3} P
   * @param {string} elem element symbol at P (for the cutoff lookup)
   * @returns {Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number}>}
   */
  // Per-center-element bond-cutoff rows, memoized. `getBondLengthCutoff`
  // rebuilds a string key on every call and sits in the hottest neighbour
  // loops, so cache an nAtoms-long row of cutoffs for each distinct centre
  // element.
  /** @type {Map<string, Float64Array>} */
  const cutoffRowCache = new Map();
  function cutoffRow(elem) {
    let row = cutoffRowCache.get(elem);
    if (!row) {
      row = new Float64Array(nAtoms);
      for (let j = 0; j < nAtoms; j++) row[j] = getBondLengthCutoff(elem, elements[j]);
      cutoffRowCache.set(elem, row);
    }
    return row;
  }

  function neighborImages(P, elem) {
    const fp = cartToFrac([P.x, P.y, P.z], lattice, latInv);
    const out = [];
    const cuts = cutoffRow(elem);
    for (const j of cellCandidates(fp, nbHaloX, nbHaloY, nbHaloZ)) {
      const cutoff = cuts[j];
      if (cutoff <= 1e-3) continue;
      const fj = positions[j];
      const c0 = Math.round(fp[0] - fj[0]);
      const c1 = Math.round(fp[1] - fj[1]);
      const c2 = Math.round(fp[2] - fj[2]);
      for (let dx = c0 - nA; dx <= c0 + nA; dx++)
        for (let dy = c1 - nB; dy <= c1 + nB; dy++)
          for (let dz = c2 - nC; dz <= c2 + nC; dz++) {
            const q = baseCart[j].clone().addScaledVector(a, dx).addScaledVector(b, dy).addScaledVector(c, dz);
            const d = q.distanceTo(P);
            if (d > cutoff || d < 1e-4) continue;
            out.push({ srcJ: j, shift: /** @type {[number,number,number]} */ ([dx, dy, dz]), pos: q, d });
          }
    }
    return out;
  }

  // All atom images (any species) within `radius` of point P — used to gather
  // Voronoi candidates for a centre. Unlike neighborImages this is NOT limited to
  // bonded pairs, because a closer non-bonded atom must still be able to shadow a
  // farther one for the Voronoi cell to be correct.
  const R = searchRadius(maxCutoff);
  const mA = Math.max(1, Math.ceil(R / Math.max(widthA, 1e-6)));
  const mB = Math.max(1, Math.ceil(R / Math.max(widthB, 1e-6)));
  const mC = Math.max(1, Math.ceil(R / Math.max(widthC, 1e-6)));
  /**
   * @param {THREE.Vector3} P
   * @returns {Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number, elem:string, radius:number}>}
   */
  function gatherWithin(P) {
    const fp = cartToFrac([P.x, P.y, P.z], lattice, latInv);
    const out = [];
    for (const j of cellCandidates(fp, gwHaloX, gwHaloY, gwHaloZ)) {
      const fj = positions[j];
      const c0 = Math.round(fp[0] - fj[0]);
      const c1 = Math.round(fp[1] - fj[1]);
      const c2 = Math.round(fp[2] - fj[2]);
      for (let dx = c0 - mA; dx <= c0 + mA; dx++)
        for (let dy = c1 - mB; dy <= c1 + mB; dy++)
          for (let dz = c2 - mC; dz <= c2 + mC; dz++) {
            const q = baseCart[j].clone().addScaledVector(a, dx).addScaledVector(b, dy).addScaledVector(c, dz);
            const d = q.distanceTo(P);
            if (d > R || d < 1e-4) continue;
            out.push({ srcJ: j, shift: /** @type {[number,number,number]} */ ([dx, dy, dz]), pos: q, d, elem: elements[j], radius: atomicRadii[elements[j]] || 1.0 });
          }
    }
    return out;
  }

  // All atom images (any species) within `r` of P, the atom AT P included —
  // gatherWithin with a radius of the caller's choosing (cage shells reach
  // past the Voronoi search radius: a C60 is 3.5 Å across its middle).
  /**
   * @param {THREE.Vector3} P
   * @param {number} r
   * @returns {Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number}>}
   */
  function gatherRadius(P, r) {
    const fp = cartToFrac([P.x, P.y, P.z], lattice, latInv);
    const hx = Math.floor(r / binWA) + 1, hy = Math.floor(r / binWB) + 1, hz = Math.floor(r / binWC) + 1;
    // Half a cell of slack on the image window, so how an exact .5 rounds
    // (differently in JS and Rust) cannot drop an image.
    const ia = Math.max(1, Math.ceil(r / Math.max(widthA, 1e-6) + 0.5));
    const ib = Math.max(1, Math.ceil(r / Math.max(widthB, 1e-6) + 0.5));
    const ic = Math.max(1, Math.ceil(r / Math.max(widthC, 1e-6) + 0.5));
    const out = [];
    for (const j of cellCandidates(fp, hx, hy, hz)) {
      const fj = positions[j];
      const c0 = Math.round(fp[0] - fj[0]);
      const c1 = Math.round(fp[1] - fj[1]);
      const c2 = Math.round(fp[2] - fj[2]);
      for (let dx = c0 - ia; dx <= c0 + ia; dx++)
        for (let dy = c1 - ib; dy <= c1 + ib; dy++)
          for (let dz = c2 - ic; dz <= c2 + ic; dz++) {
            const q = baseCart[j].clone().addScaledVector(a, dx).addScaledVector(b, dy).addScaledVector(c, dz);
            const d = q.distanceTo(P);
            if (d > r) continue;
            out.push({ srcJ: j, shift: /** @type {[number,number,number]} */ ([dx, dy, dz]), pos: q, d });
          }
    }
    return out;
  }

  // ---------- Spatial cell list (shared neighbour acceleration) ----------
  // Both scans above are O(atoms) per query → O(atoms²) overall, which dominates
  // large structures. Bin every atom by its wrapped fractional cell into a grid,
  // then a query only inspects atoms in the surrounding ±halo bins (with periodic
  // wrap) instead of all of them. The grid is sized by the smaller (bond) radius so
  // the per-atom periodic-image distance test below is still run unchanged on each
  // candidate — so emitted neighbours are byte-for-byte identical, just far fewer
  // atoms are visited. The halo is computed from each query's own radius, so the
  // wide gatherWithin radius scans more bins than the tight neighborImages radius.
  const binRadius = Math.max(maxCutoff, 1.5);
  const Gx = Math.max(1, Math.floor(widthA / binRadius));
  const Gy = Math.max(1, Math.floor(widthB / binRadius));
  const Gz = Math.max(1, Math.floor(widthC / binRadius));
  const binWA = widthA / Gx, binWB = widthB / Gy, binWC = widthC / Gz;
  // Per-axis halo (in bins) for the two query radii. floor(ρ/binW)+1 is the exact
  // worst-case bin span (the +1 absorbs the floor-binning offset of the two points,
  // which a bare ceil would miss at integer ratios). For the tight bond radius this
  // is just 1, so the hot setup scan pays nothing extra.
  const nbHaloX = Math.floor(maxCutoff / binWA) + 1; // neighborImages (bond cutoff)
  const nbHaloY = Math.floor(maxCutoff / binWB) + 1;
  const nbHaloZ = Math.floor(maxCutoff / binWC) + 1;
  const gwHaloX = Math.floor(R / binWA) + 1;         // gatherWithin (search radius)
  const gwHaloY = Math.floor(R / binWB) + 1;
  const gwHaloZ = Math.floor(R / binWC) + 1;
  /** @type {number[][]} */
  const cellBins = new Array(Gx * Gy * Gz);
  for (let bi = 0; bi < cellBins.length; bi++) cellBins[bi] = [];
  const wrapBin = (f, G) => {
    let g = Math.floor((f - Math.floor(f)) * G);
    if (g >= G) g = G - 1; else if (g < 0) g = 0;
    return g;
  };
  for (let j = 0; j < nAtoms; j++) {
    const gx = wrapBin(positions[j][0], Gx);
    const gy = wrapBin(positions[j][1], Gy);
    const gz = wrapBin(positions[j][2], Gz);
    cellBins[(gx * Gy + gy) * Gz + gz].push(j);
  }
  // Per-query dedup via a stamp array (avoids allocating a Set per query).
  const _cellStamp = new Int32Array(nAtoms).fill(-1);
  let _cellQueryId = 0;
  const axisRange = (g, halo, G) => {
    if (2 * halo + 1 >= G) { const r = new Array(G); for (let i = 0; i < G; i++) r[i] = i; return r; }
    const r = new Array(2 * halo + 1);
    for (let d = -halo, k = 0; d <= halo; d++, k++) r[k] = ((g + d) % G + G) % G;
    return r;
  };
  /**
   * Atom indices whose nearest periodic image could lie within `halo` bins of
   * fractional point `fp`. Superset-correct: contains every true neighbour for the
   * radius the halo was derived from.
   * @param {number[]} fp fractional coordinates of the query point
   * @returns {number[]}
   */
  function cellCandidates(fp, hx, hy, hz) {
    const qid = _cellQueryId++;
    const xs = axisRange(wrapBin(fp[0], Gx), hx, Gx);
    const ys = axisRange(wrapBin(fp[1], Gy), hy, Gy);
    const zs = axisRange(wrapBin(fp[2], Gz), hz, Gz);
    const out = [];
    for (const gx of xs) for (const gy of ys) for (const gz of zs) {
      const bin = cellBins[(gx * Gy + gy) * Gz + gz];
      for (const j of bin) {
        if (_cellStamp[j] === qid) continue;
        _cellStamp[j] = qid;
        out.push(j);
      }
    }
    return out;
  }

  // Framework graph for the cage search (only built when cages are on): the
  // framework-bond neighbour images of each base atom, as keys for an O(1)
  // image-aware bond test, and each atom's framework degree counted over
  // non-terminal partners (an H on a cubane carbon is no part of the cage).
  // With the chemical filter on, framework bonds are isFrameworkBond's
  // (nonmetal–nonmetal, or metal–metal not bridged by an anion); off, every bond.
  /** @type {Array<Array<{srcJ:number, shift:[number,number,number]}>>} */
  let fwNbrs = [];
  /** @type {Array<Set<string>>} */
  let fwKeys = [];
  /** @type {Int32Array | null} */
  let fwDeg = null;
  // What a shell atom's in-shell bonds are measured against: its framework
  // degree, except for a metal under the chemical filter, which counts all
  // its metal–metal contacts — in a carbide most Ti–Ti contacts are bridged
  // by C (no framework bonds), and a Ti4 hole then passed with 3 of 4.
  /** @type {Int32Array | null} */
  let shareDeg = null;
  if (ALLOW_CAGES && detectCages) {
    fwNbrs = new Array(nAtoms);
    fwKeys = new Array(nAtoms);
    shareDeg = new Int32Array(nAtoms);
    for (let i = 0; i < nAtoms; i++) {
      const nbr = neighborImages(baseCart[i], elements[i]);
      fwNbrs[i] = nbr.filter((o) => !useChemicalFilter
        || isFrameworkBond(elements[i], elements[o.srcJ], nbr, o.pos, elements));
      fwKeys[i] = new Set(fwNbrs[i].map((o) => `${o.srcJ}:${o.shift[0]},${o.shift[1]},${o.shift[2]}`));
      if (useChemicalFilter && !ANION_FORMERS.has(elements[i])) {
        shareDeg[i] = nbr.filter((o) => !ANION_FORMERS.has(elements[o.srcJ])).length;
      }
    }
    fwDeg = new Int32Array(nAtoms);
    for (let i = 0; i < nAtoms; i++) {
      for (const o of fwNbrs[i]) if (fwNbrs[o.srcJ].length >= 2) fwDeg[i]++;
      if (!(useChemicalFilter && !ANION_FORMERS.has(elements[i]))) shareDeg[i] = fwDeg[i];
    }
  }
  _tSetup = performance.now();

  // ---------- Build candidates ----------
  /** @type {Array<{
   *   kind: 'centered'|'cage',
   *   colorElem: string,
   *   centerSrc?: number,
   *   centerShift?: [number,number,number],
   *   centerPos?: THREE.Vector3,
   *   posList: THREE.Vector3[],
   *   vertexSrcList: number[],
   *   vertexImageList: Array<{src:number, shift:[number,number,number]}>,
   *   refPoint: THREE.Vector3,
   * }>} */
  const candidates = [];

  // ---- Centered: compute directly on the visible displayed center images. ----
  // This keeps plane-cut visibility and periodic-image visibility in the same
  // coordinate frame as the user-visible atoms, instead of computing once on the
  // primary atom and translating the result afterwards.
  for (const dc of displayCenters) {
    const centerPos = dc.cart;
    const centerElem = elements[dc.src];

    // Fast mode: every bonded neighbour that passes the element rule is a
    // corner, less (with the chemical filter) the cations seen through a
    // nearer anion among those neighbours (mirrors the fast block of
    // polyhedra.rs build_candidates).
    if (simple) {
      const bonded = neighborImages(centerPos, centerElem)
        .map((o) => ({ ...o, elem: elements[o.srcJ] }))
        .filter((o) => isLigandOf(o.elem, centerElem, useChemicalFilter)
          && isAtomImageVisible(o.pos.toArray(), structure.atoms[o.srcJ], activeCutPlanes));
      const ligands = useChemicalFilter ? bonded.filter((o) => !isBridgedCation(o, bonded)) : bonded;
      if (ligands.length < 4) continue;
      const posList = ligands.map((o) => o.pos);
      if (thicknessRatio(posList) < MIN_THICKNESS_RATIO) continue;
      candidates.push({
        kind: 'centered',
        colorElem: centerElem,
        centerSrc: dc.src,
        centerShift: dc.shift,
        centerPos: centerPos.clone(),
        posList,
        vertexSrcList: ligands.map((o) => o.srcJ),
        vertexImageList: [],
        refPoint: centerPos.clone(),
      });
      continue;
    }

    // Radical-Voronoi + solid-angle neighbour selection (distance-independent:
    // keeps elongated bonds, rejects shadowed far atoms). Candidates include all
    // species so closer atoms can shadow farther ones; a vertex must additionally
    // be a chemical ligand of the centre and within the visible bond cutoff.
    const cands = gatherWithin(centerPos);
    if (cands.length < 4) continue;
    const isLigand = (/** @type {any} */ cand) => {
      if (!isLigandOf(cand.elem, centerElem, useChemicalFilter)) return false;
      const cutoff = getBondLengthCutoff(centerElem, cand.elem);
      return cutoff > 1e-3 && cand.d <= cutoff;
    };
    const accept = (/** @type {any} */ cand) => isLigand(cand)
      && !(useChemicalFilter && isBridgedCation(cand, cands));
    const vor = voronoiNeighbours(centerPos, cands, {
      radical: VORONOI_RADICAL,
      relMin: VORONOI_SOLID_ANGLE_REL,
      centerRadius: atomicRadii[centerElem] || 1.0,
      accept,
    });

    // Cut-plane visibility is tested directly on the candidate image, independent
    // of whether that periodic image exists in `wrapped`.
    const byImage = new Map();
    for (const { cand } of vor) {
      const key = imageKey(cand.srcJ, cand.shift);
      if (!isAtomImageVisible(cand.pos.toArray(), structure.atoms[cand.srcJ], activeCutPlanes)) continue;
      const prev = byImage.get(key);
      if (!prev || cand.d < prev.d) byImage.set(key, cand);
    }
    const entries = Array.from(byImage.values());
    if (entries.length < 4) continue; // need ≥4 non-coplanar points for a closed hull

    // Only remaining skip reason is geometric degeneracy (a near-planar set has no
    // volume). No distortion filter — the neighbour set is the genuine shell.
    // `centeredHullIsAcceptable` builds the (only) hull here; a non-constructible
    // point set throws and is skipped, so no separate constructibility probe is
    // needed (avoids an extra ConvexGeometry build per centre).
    const posList = entries.map(o => o.pos);
    if (thicknessRatio(posList) < MIN_THICKNESS_RATIO) continue;
    let centeredOK = false;
    try { centeredOK = centeredHullIsAcceptable(centerPos, atomicRadii[centerElem] || 1.0, posList); }
    catch { continue; }
    if (!centeredOK) continue;

    candidates.push({
      kind: 'centered',
      colorElem: centerElem,
      centerSrc: dc.src,
      centerShift: dc.shift,
      centerPos: centerPos.clone(),
      posList,
      vertexSrcList: entries.map(o => o.srcJ),
      vertexImageList: [],
      refPoint: centerPos.clone(),
    });
  }

  _tCentered = performance.now();

  // ---- Cages (uncentred): empty shells of mutually bonded framework atoms ----
  if (ALLOW_CAGES && detectCages) {
    const _c0 = performance.now();
    findCages();
    _cagePoolMs += performance.now() - _c0;
  }

  /**
   * Cages from the empty space. A cage is a closed shell of framework atoms
   * around a void: a B12 icosahedron, a clathrate's Si20 or Si24, a C60. The
   * old search grew a pool of atoms around each SEED ATOM and cut it into
   * distance bands about the pool's centroid, which sits near the seed, not
   * in a cage — so it found none of the real ones and plenty of junk.
   *
   *   1. Distance to the nearest atom on a grid over the cell (each atom
   *      stamps a sphere of CAGE_SPLAT_RADIUS; periodic by index wrap), and
   *      its local maxima at least CAGE_MIN_VOID from every atom.
   *   2. Around each, the framework atoms within CAGE_SHELL_TOL × the nearest
   *      distance (or + CAGE_SHELL_PAD), re-centred on their centroid until the
   *      shell stops changing.
   *   3. It is a cage when every shell atom has ≥ 3 framework bonds inside the
   *      shell and at least CAGE_MIN_SURFACE_SHARE of all its framework bonds
   *      (a metal: of all its metal–metal contacts, see shareDeg) lie in it (5 of 6 on a B12, 3 of 4 on a clathrate cage, 3 of 3 on a
   *      C60 — but 3 of 6 around the gap between icosahedra in boron, ≤ 6 of 12
   *      at a hole in a close-packed metal), the shell is connected and not
   *      flat, the void lies inside its hull with every shell atom on the hull,
   *      and no atom at all lies inside (a shell around an atom or a guest is
   *      that atom's polyhedron — Ba8Si46 keeps its Ba-centred cages).
   *
   * Each cage is kept once, translated so its centre lies in the cell (with a
   * 1e-6 nudge so a centre on a cell face lands the same way on both paths).
   */
  function findCages() {
    if (!fwDeg || !fwDeg.some((d) => d >= 3)) return;
    // 1. the voids: local maxima of the distance to the nearest atom
    const { voids } = findVoidCentres(lattice, positions);

    const imgKey = (o) => `${o.srcJ}:${o.shift[0]},${o.shift[1]},${o.shift[2]}`;
    const byImage = (u, v) => (u.srcJ - v.srcJ) || (u.shift[0] - v.shift[0]) || (u.shift[1] - v.shift[1]) || (u.shift[2] - v.shift[2]);
    const bonded = (u, v) => fwKeys[u.srcJ].has(`${v.srcJ}:${v.shift[0] - u.shift[0]},${v.shift[1] - u.shift[1]},${v.shift[2] - u.shift[2]}`);
    /** @type {Set<string>} */
    const seen = new Set();

    for (const { frac } of voids) {
      // 2. the shell around this void, re-centred until it is stable
      let P = new THREE.Vector3().addScaledVector(a, frac[0]).addScaledVector(b, frac[1]).addScaledVector(c, frac[2]);
      let shell = null;
      let prevKey = '';
      let stable = false;
      for (let it = 0; it < CAGE_REFINE_ITERS; it++) {
        const near = gatherRadius(P, CAGE_SHELL_CAP);
        if (!near.length) break;
        let dmin = Infinity;
        for (const o of near) if (o.d < dmin) dmin = o.d;
        const cutR = Math.max(CAGE_SHELL_TOL * dmin, dmin + CAGE_SHELL_PAD);
        const sh = near.filter((o) => o.d <= cutR && fwNbrs[o.srcJ].length >= 2).sort(byImage);
        if (sh.length < 4) break;
        const key = sh.map(imgKey).join('|');
        if (key === prevKey) { stable = true; shell = sh; break; }
        prevKey = key;
        P = sh.reduce((acc, o) => acc.add(o.pos), new THREE.Vector3()).multiplyScalar(1 / sh.length);
      }
      if (!stable || !shell) continue;

      // translate so the centre lies in the cell, then keep each cage once
      const fc = cartToFrac([P.x, P.y, P.z], lattice, latInv);
      const t = fc.map((x) => Math.floor(x + 1e-6));
      if (t[0] || t[1] || t[2]) {
        const off = new THREE.Vector3().addScaledVector(a, t[0]).addScaledVector(b, t[1]).addScaledVector(c, t[2]);
        P = P.clone().sub(off);
        shell = shell.map((o) => ({ ...o, pos: o.pos.clone().sub(off),
          shift: /** @type {[number,number,number]} */ ([o.shift[0] - t[0], o.shift[1] - t[1], o.shift[2] - t[2]]) }));
      }
      const cageKey = shell.map(imgKey).join('|');
      if (seen.has(cageKey)) continue;
      seen.add(cageKey);

      // 3. is it a cage?
      let ok = true;
      for (const u of shell) {
        let inShell = 0;
        for (const w of shell) if (w !== u && bonded(u, w)) inShell++;
        if (inShell < 3 || inShell < CAGE_MIN_SURFACE_SHARE * shareDeg[u.srcJ]) { ok = false; break; }
      }
      if (!ok) continue;
      const reached = new Set([0]);
      const queue = [0];
      while (queue.length) {
        const u = queue.pop();
        for (let w = 0; w < shell.length; w++) {
          if (!reached.has(w) && bonded(shell[u], shell[w])) { reached.add(w); queue.push(w); }
        }
      }
      if (reached.size !== shell.length) continue;
      const posList = shell.map((o) => o.pos);
      if (thicknessRatio(posList) < CAGE_MIN_THICKNESS) continue;
      let geom;
      try { geom = new ConvexGeomCtor(posList); } catch { continue; }
      const inside = (q) => pointInsideConvexGeometry(q, geom);
      let rMax = 0;
      for (const o of shell) rMax = Math.max(rMax, o.pos.distanceTo(P));
      const keys = new Set(shell.map(imgKey));
      const good = inside(P)
        && shell.every((o) => !inside(o.pos))
        && gatherRadius(P, rMax + 0.05).every((o) => keys.has(imgKey(o)) || !inside(o.pos));
      geom.dispose();
      if (!good) continue;

      // One candidate per image on show (see cageBounds): the in-cell centre
      // coordinate w takes every shift n with lo ≤ w + n ≤ hi.
      const w = [fc[0] - t[0], fc[1] - t[1], fc[2] - t[2]];
      const range = (/** @type {number} */ k) => (cageBounds
        ? [Math.ceil(cageBounds[k][0] - w[k]), Math.floor(cageBounds[k][1] - w[k])]
        : [0, 0]);
      const [rx, ry, rz] = [range(0), range(1), range(2)];
      for (let nx = rx[0]; nx <= rx[1]; nx++) {
        for (let ny = ry[0]; ny <= ry[1]; ny++) {
          for (let nz = rz[0]; nz <= rz[1]; nz++) {
            const off = new THREE.Vector3().addScaledVector(a, nx).addScaledVector(b, ny).addScaledVector(c, nz);
            const img = shell.map((o) => ({ srcJ: o.srcJ, pos: o.pos.clone().add(off),
              shift: /** @type {[number,number,number]} */ ([o.shift[0] + nx, o.shift[1] + ny, o.shift[2] + nz]) }));
            if (!img.every((o) => isAtomImageVisible(o.pos.toArray(), structure.atoms[o.srcJ], activeCutPlanes))) continue;
            candidates.push({
              kind: 'cage',
              colorElem: elements[img[0].srcJ],
              posList: img.map((o) => o.pos),
              vertexSrcList: img.map((o) => o.srcJ),
              vertexImageList: img.map((o) => ({ src: o.srcJ, shift: o.shift })),
              refPoint: P.clone().add(off),
            });
          }
        }
      }
    }
  }
  _tCages = performance.now();

  // ---------- Global constraints & accept into model ----------
  // Image-level center-not-corner:
  //  - An accepted center image (src, shift) cannot appear as a cage vertex.
  const acceptedCenterImageKeys = new Set(); // '<src>:<dx>,<dy>,<dz>'
  const acceptedHulls = []; // transient geometries kept only for inside tests
 // Priority: larger N first; then centered over cages

  candidates.sort((A, B) => {
    const nA = A.posList.length, nB = B.posList.length;
    if (nA !== nB) return nB - nA; // larger first

    // For large shells, prefer cages (so they aren't blocked by centered selections)
    if (nA >= 12 && A.kind !== B.kind) {
      return (A.kind === 'cage' ? -1 : 1);
    }

    // Otherwise your previous preference (centered first)
    if (A.kind !== B.kind) return (A.kind === 'centered' ? -1 : 1);

    return 0;
  });

  /** @type {Polyhedron[]} */
  const accepted = [];

  for (const cand of candidates) {
    // Image-level center-not-corner
    if (cand.kind === 'cage' && cand.vertexImageList) {
      // A cage must not use an already-accepted center image as a vertex
      const conflict = cand.vertexImageList.some(
        v => acceptedCenterImageKeys.has(`${v.src}:${v.shift[0]},${v.shift[1]},${v.shift[2]}`)
      );
      if (conflict) continue;
    }

    // Build hull for shape + nesting tests
    let geom;
    try { geom = new ConvexGeomCtor(cand.posList); } catch { continue; }
    geom.computeVertexNormals();

    // No nesting: reference point not inside any accepted hull
    let inside = false;
    for (const g of acceptedHulls) {
      if (pointInsideConvexGeometry(cand.refPoint, g)) { inside = true; break; }
    }
    if (inside) { geom.dispose(); continue; }

    // Accept → record as plain-data model Polyhedron
    accepted.push(new Polyhedron({
      name: `${cand.colorElem}${cand.kind === 'centered' ? '' : '-cage'}-CN${cand.posList.length}`,
      type: cand.kind,
      centerIndex: (cand.kind === 'centered') ? (cand.centerSrc ?? null) : null,
      centerElement: (cand.kind === 'centered') ? cand.colorElem : null,
      colorElem: cand.colorElem,
      vertices: cand.posList.map(p => [p.x, p.y, p.z]),
      vertexSrcList: cand.vertexSrcList,
    }));

    // Update constraint sets — key the centre by its (src, image shift)
    if (cand.kind === 'centered' && typeof cand.centerSrc === 'number') {
      const cs = cand.centerShift || [0, 0, 0];
      acceptedCenterImageKeys.add(`${cand.centerSrc}:${cs[0]},${cs[1]},${cs[2]}`);
    }
    acceptedHulls.push(geom); // keep for future inside tests (disposed below)
  }

  // Dispose the transient validation hulls — render rebuilds its own.
  for (const g of acceptedHulls) g.dispose();

  const _tEnd = performance.now();
  const ms = (x) => x.toFixed(1);
  console.log(
    `[polyhedra] total=${ms(_tEnd - _t0)}ms ` +
    `setup=${ms(_tSetup - _t0)} centered=${ms(_tCentered - _tSetup)} ` +
    `cages=${ms(_tCages - _tCentered)}(pool=${ms(_cagePoolMs)}) accept=${ms(_tEnd - _tCages)} | ` +
    `atoms=${nAtoms} centers=${displayCenters.length} ` +
    `candidates=${candidates.length} accepted=${accepted.length} ` +
    `mode=${polyMode} detectCages=${detectCages}`
  );

  return new Polyhedra({ polyhedra: accepted });
  } // runJsPath
}

/**
 * Draw the polyhedra stored on `structure.polyhedra` into
 * `groups.polyhedraGroup` (which the caller has already reset): one table +
 * one face geometry + one edge geometry for all of them
 * (render/PolyhedraMesh.js), styled here from the store.
 *
 * @param {any} structure active Structure with a populated `polyhedra` model
 */
export function renderPolyhedra(structure) {
  const model = structure.polyhedra;
  if (!model || !model.polyhedra || !model.polyhedra.length) return;

  // Keys are normally stamped in updatePolyhedra right after the compute;
  // stamp defensively for any model that predates that (e.g. restored sessions).
  if (model.polyhedra.some((p) => !p.key)) assignPolyhedraKeys(structure, model);

  const table = buildPolyhedraTable(model, {
    outlineDirs: general.renderStyle === 'cel' && general.celOutlineMode === 'hull',
  });
  writePolyhedraStyles(structure, table);
  addPolyhedraObjects(table, groups.polyhedraGroup);
  // What an MD / trajectory fast frame needs to move these polyhedra
  // (render/PolyhedraFrameModule.js), then the property colours over the
  // style ones when Colour by is set.
  captureTopology(table, structure, model, { cutoffOf: getBondLengthCutoff });
  applyPolyhedraPropertyColors(table, { upload: false, saveStyle: true });
  repaintOverride(table);
  uploadPolyStyles(table);
}

/** Resolve every row's style (and focus factor) into the table — CPU only. */
function writePolyhedraStyles(structure, table) {
  // The table's own model: a trajectory frame switch may have dropped
  // structure.polyhedra while these polyhedra are still the ones drawn.
  const polys = (table.topo?.model ?? structure.polyhedra)?.polyhedra ?? [];
  for (let i = 0; i < table.n; i++) {
    const poly = polys[i];
    if (!poly) continue;
    const style = resolvePolyhedronStyle(
      structure, poly.key, poly.catKey, poly.type, poly.centerIndex, poly.colorElem);
    // Authored alpha (style) — focus regions scale it (applyFocusToPolyhedra)
    // without ever overwriting it, mirroring Atom.opacity.
    table.focus[i] = getFocusOpacityForPolyhedron(poly, structure);
    setPolyStyle(table, i, style.color, style.opacity, style.edgeColor, style.edgeOpacity, style.visible);
  }
}

/** The drawn polyhedra's table (render/PolyhedraMesh.js), or null when none
 *  are drawn. Row i is structure.polyhedra.polyhedra[i]. */
export function polyhedraTable() {
  return groups.polyhedraGroup?.userData?.polyTable ?? null;
}

/** How many polyhedra are drawn (a hull was built), and of those how many
 *  are shown (category visible). */
export function polyhedraDrawnCount({ shownOnly = false } = {}) {
  const table = polyhedraTable();
  if (!table) return 0;
  let n = 0;
  for (let i = 0; i < table.n; i++) if (table.faceCount[i] && (!shownOnly || table.visible[i])) n++;
  return n;
}

/** One drawn polyhedron as a plain object (tests, the selection bar):
 *  identity, displayed and authored alpha, colours, glow. Not for per-frame
 *  use. */
export function polyhedronInfo(i) {
  const table = polyhedraTable();
  if (!table || !(i >= 0 && i < table.n)) return null;
  return {
    index: i,
    key: table.key[i], groupKey: table.groupKey[i], catKey: table.catKey[i],
    centerIndex: table.centerIndex[i] >= 0 ? table.centerIndex[i] : null,
    kind: table.kind[i] ? 'cage' : 'centered', cn: table.cn[i],
    drawn: table.faceCount[i] > 0, visible: table.visible[i] === 1,
    opacity: table.opacity[i], baseOpacity: table.baseOpacity[i],
    edgeOpacity: table.edgeOpacity[i], baseEdgeOpacity: table.baseEdgeOpacity[i],
    focus: table.focus[i],
    color: polyColorHex(table, i), edgeColor: polyColorHex(table, i, true),
    glow: table.glow[i] === 1,
    faceStart: table.faceStart[i], faceCount: table.faceCount[i],
    edgeStart: table.edgeStart[i], edgeCount: table.edgeCount[i],
  };
}

/** polyhedronInfo() of every drawn polyhedron (tests, debugging). */
export function polyhedraInfo() {
  const table = polyhedraTable();
  const out = [];
  for (let i = 0; table && i < table.n; i++) if (table.faceCount[i]) out.push(polyhedronInfo(i));
  return out;
}

/** Rows of the drawn polyhedra by stable key / periodic-copy group key. */
export function polyhedronIndexOfKey(key) {
  return polyIndexOfKey(polyhedraTable(), key);
}
export function polyhedronIndicesOfGroup(groupKey) {
  return polyIndicesOfGroup(polyhedraTable(), groupKey);
}

/** Selection glow (orange emissive) on/off for table rows. */
export function setPolyhedraGlow(rows, on) {
  setPolyGlow(polyhedraTable(), rows, on);
}

/** Re-scale every drawn polyhedron by its focus-region factor (see
 *  FocusRegionModule.focusOpacityForPolyhedron). Authored alpha stays in the
 *  table (baseOpacity), so repeated calls never compound. */
export function applyFocusToPolyhedra(structure = fileBrowser.selectedStructure) {
  const table = polyhedraTable();
  if (!table || !structure) return;
  const polys = structure.polyhedra?.polyhedra ?? [];
  for (let i = 0; i < table.n; i++) {
    const poly = polys[i];
    setPolyFocus(table, i, poly ? getFocusOpacityForPolyhedron(poly, structure) : 1);
  }
  uploadPolyStyles(table);
}

/**
 * Restyle the existing polyhedra in place — no geometry recompute. Applies
 * the full resolved style (color, opacity, category visibility) with user
 * overrides taking precedence over the default atom/element colours. Use after
 * an element-colour change or a Poly-tab style edit, so the polyhedra match
 * without a full (async) `updatePolyhedra`. Never touches the glow — that is
 * owned by the selection highlight. No-op when nothing drawn.
 */
/**
 * Set style fields (color, alpha, ...) on individual polyhedra by key, the
 * persistent per-polyhedron record (individual > category), and redraw their
 * colours. Shared by the Polyhedra rows and the host's apply.
 * @param {any} structure
 * @param {string[]} keys
 * @param {Record<string, any>} patch
 */
export function setPolyhedronStyles(structure, keys, patch) {
  structure.polyhedraUserStyles ??= {};
  for (const k of keys) Object.assign(structure.polyhedraUserStyles[k] ??= {}, patch);
  updatePolyhedraColors();
}

export function updatePolyhedraColors() {
  notifyColorsChanged();
  const table = polyhedraTable();
  const structure = fileBrowser.selectedStructure;
  if (!table || !structure) return;
  writePolyhedraStyles(structure, table);
  // Colour by a property: its colours stay over the freshly written styles
  // (an alpha or show/hide edit keeps them); 'style' leaves the styles.
  applyPolyhedraPropertyColors(table, { upload: false, saveStyle: true });
  repaintOverride(table);
  uploadPolyStyles(table);
  // Complete Polyhedra adds the corner atoms of the DRAWN polyhedra
  // (syncCompletingAtoms); a show/hide edit changes that set, so recompute —
  // only then: a colour or alpha edit must not rebuild (the rebuild re-renders
  // the Poly tab and would close the editor being used).
  if (general.completePolyhedra && !polyhedraBusy) {
    const sig = polyhedraVisibilitySignature(structure);
    if (sig !== structure._completingVisSig) updatePolyhedra();
  }
}

/** The show/hide state of every polyhedra category and element, as one
 *  string: what decides which polyhedra Complete Polyhedra completes. */
function polyhedraVisibilitySignature(structure) {
  const parts = [];
  for (const [k, v] of Object.entries(structure.polyhedraCategoryStyles ?? {})) if (v?.visible != null) parts.push(`c:${k}=${v.visible ? 1 : 0}`);
  for (const [k, v] of Object.entries(structure.polyhedraElementStyles ?? {})) if (v?.visible != null) parts.push(`e:${k}=${v.visible ? 1 : 0}`);
  for (const [k, v] of Object.entries(structure.polyhedraUserStyles ?? {})) if (v?.visible != null) parts.push(`u:${k}=${v.visible ? 1 : 0}`);
  return parts.sort().join('|');
}

/** Disco mode's paint override (render/PolyhedraMesh.js): reapply it over
 *  freshly written styles, so a rebuild or a restyle keeps the paint. */
function repaintOverride(table) {
  const pick = polyPaintOverride();
  if (!pick) return;
  for (let i = 0; i < table.n; i++) {
    if (!table.faceCount[i]) continue;
    _paint.set(pick(i));
    setPolyColorRGB(table, i, _paint.r, _paint.g, _paint.b);
  }
}

const _paint = new THREE.Color();

/** Paint every drawn polyhedron's faces and edges with `pick(i)` (anything
 *  THREE.Color.set takes) WITHOUT touching the stored styles — the disco
 *  ball's reversible paint; updatePolyhedraColors() restores the styles. */
export function paintPolyhedraColors(pick) {
  const table = polyhedraTable();
  if (!table) return;
  for (let i = 0; i < table.n; i++) {
    if (!table.faceCount[i]) continue;
    _paint.set(pick(i));
    setPolyColorRGB(table, i, _paint.r, _paint.g, _paint.b);
  }
  uploadPolyStyles(table);
}

/** Live-update the polyhedra edge thickness (world units: width 1 = the
 *  unit-cell line thickness; 0 hides the edges entirely). */
export function setPolyEdgeWidth(width) {
  general.polyEdgeWidth = width;
  setPolyEdgeLinewidth(polyhedraTable(), width);
}

/**
 * Toggle/refresh entry point. Recomputes `structure.polyhedra` (so the model
 * mirrors the scene and bond-cutoff edits take effect) and renders it.
 */
// A session restore (ui/ShareModule.js applySharedState) builds the structure
// first and restores the atom order and polyhedron styles after it: polyhedra
// computed in between were thrown away and computed again, the slowest part of
// opening a styled share link. While held, a request is only remembered; the
// restore makes the one request that counts once its styles are on.
let holdDepth = 0;
let heldRequest = false;

/** Hold polyhedra requests until releasePolyhedra(). */
export function holdPolyhedra() {
  holdDepth += 1;
}

/** End holdPolyhedra(); true when a request arrived meanwhile (the caller
 *  should then run updatePolyhedra() itself). */
export function releasePolyhedra() {
  if (!holdDepth) return false;
  holdDepth -= 1;
  if (holdDepth) return false;
  const held = heldRequest;
  heldRequest = false;
  return held;
}

export function updatePolyhedra() {
  // Reflect current showPolyhedra/completePolyhedra + comparison-structure
  // state in the viewport warning banner every time this entry point runs
  // (toggles, comparison enable/disable/step-change all funnel through here).
  updatePolyhedraComparisonWarning();
  updateDisorderWarning();
  updatePolyhedraFastNotice();
  announcePolyhedraMode();

  if (holdDepth) {
    heldRequest = true;
    return polyhedraPromise || Promise.resolve();
  }

  // A coordination polyhedron's identity comes from the species of its centre
  // and ligands, and a fractionally occupied site has no single answer for
  // either. Rather than pick a representative species and draw something that
  // looks authoritative but isn't, the feature is unavailable for such
  // structures; the banner says so.
  if (structureHasFractionalOccupancy()) {
    updatePolyhedraFastNotice(null);
    clearPolyhedraGroup();
    if (polyhedraBusy) polyhedraDirty = true;
    return;
  }

  // Turning the feature off takes effect immediately (clear the group now), even if a
  // compute is in flight — flag it dirty so that in-flight loop also stops/settles.
  if (!general.showPolyhedra && !general.completePolyhedra) {
    clearPolyhedraGroup();
    if (polyhedraBusy) polyhedraDirty = true;
    return polyhedraPromise || Promise.resolve();
  }

  // Coalesce concurrent requests into the single in-flight loop below. A request that
  // arrives mid-compute just flags `dirty` so the loop recomputes once more with the
  // latest state — guaranteeing the last change is always reflected, without spawning a
  // pile of superseded compute jobs.
  if (polyhedraBusy) { polyhedraDirty = true; return polyhedraPromise; }
  polyhedraBusy = true;
  // "Complete Polyhedra" is a FIXED-POINT iteration: the completing atoms are
  // appended to the periodic `wrapped` set, which is exactly where the next
  // compute draws its polyhedron centers/candidates from — so appending them
  // can reveal MORE polyhedra (e.g. cages around boundary-image centers).
  // Interactive use converges incidentally (every edit re-triggers), but a
  // session restore runs only one pass and came up short. Budget-capped so a
  // pathological oscillation can't loop forever.
  let completingPasses = 0;
  polyhedraPromise = (async () => {
  try {
    do {
      polyhedraDirty = false;

      // Compute whenever faces OR completing atoms are wanted; nothing drawn when neither.
      if (!general.showPolyhedra && !general.completePolyhedra) {
        clearPolyhedraGroup();
        continue;
      }
      // Nothing to build without an active structure + lattice (e.g. polyhedra
      // toggled/restored on before a structure is loaded). Without this guard the code
      // below calls fracToCart on an undefined lattice, which hard-crashes the WASM math
      // backend (the JS backend would silently produce NaN).
      const structure = fileBrowser.selectedStructure;
      if (!structure || !structure.lattice || !structure.atoms) {
        clearPolyhedraGroup();
        continue;
      }

      const _tc = performance.now();
      // The cell the corners are computed in: an MD frame's fast path
      // (render/PolyhedraFrameModule.js) reads the corners back as fractional
      // positions, and under a barostat the cell may move during the compute.
      const srcLattice = structure.lattice.map((row) => [...row]);
      // computePolyhedra returns a Polyhedra (serial) or a Promise<Polyhedra> (parallel);
      // awaiting handles both. A newer request during the await sets `polyhedraDirty`.
      const model = await computePolyhedra(structure);
      model.srcLattice = srcLattice;

      // A newer request arrived while computing → this result is stale; loop and recompute.
      if (polyhedraDirty) continue;
      // Toggled off, or the selected structure switched, during the compute.
      if ((!general.showPolyhedra && !general.completePolyhedra)
          || fileBrowser.selectedStructure !== structure) {
        if (!general.showPolyhedra && !general.completePolyhedra) clearPolyhedraGroup();
        continue;
      }

      structure.polyhedra = model;
      // Stamp stable keys on the model side too (not just at render time), so the
      // Poly tab can list/group polyhedra even before/without faces being drawn.
      assignPolyhedraKeys(structure, model);

      // Bond breaking tolerance (render/BondBreakTolerance.js): during playback
      // the polyhedra drawn now are the memory — corners and polyhedra the
      // tolerance still holds join the strict search result, then get their
      // keys by the same code as searched ones. Nothing on a fresh load,
      // another structure, tol 0, or after a cutoff / search setting change.
      model.toleranceSig = polyhedraToleranceSignature(polyhedraSearchSettings(structure));
      if (!general.completePolyhedra && !getActiveCutPlanes().length) {
        const latInv = invert3x3(transpose3x3(structure.lattice));
        const merged = mergeToleranceHeldPolyhedra(structure, model, {
          cutoffOf: getBondLengthCutoff,
          keyOf: (poly) => polyhedronIdentity(structure, poly, latInv).key,
          makePolyhedron: (opts) => new Polyhedron(opts),
        });
        if (merged) assignPolyhedraKeys(structure, model);
      }

      // "Complete Polyhedra": append the out-of-cell vertex atoms to the displayed set so
      // every polyhedron has an atom (with bonds) at each vertex. Only re-renders atoms/bonds
      // when the completing set actually changes (see syncCompletingAtoms). When it DID
      // change, the compute inputs changed too — loop for the fixed point (see above).
      if (general.completePolyhedra) {
        structure._completingVisSig = polyhedraVisibilitySignature(structure);
        const completingChanged = syncCompletingAtoms(structure, model);
        if (completingChanged && ++completingPasses <= 4) polyhedraDirty = true;
      }

      // Build into a fresh group and swap atomically, keeping the previous polyhedra on
      // screen during the compute (no flicker / disappearance while recomputing).
      const prev = groups.polyhedraGroup;
      const newGroup = new THREE.Group();
      groups.polyhedraGroup = newGroup;
      app.scene.add(newGroup);
      if (general.showPolyhedra) {
        const _tr = performance.now();
        renderPolyhedra(structure); // renders into groups.polyhedraGroup (=== newGroup)
        console.log(`[polyhedra] render=${(performance.now() - _tr).toFixed(1)}ms (compute+render=${(performance.now() - _tc).toFixed(1)}ms)`);
      }
      if (prev) disposeGroup(prev);
      notifyPolyhedraRebuilt();
    } while (polyhedraDirty);
  } catch (err) {
    console.error('[updatePolyhedra] compute failed:', err);
    throw err;
  } finally {
    polyhedraBusy = false;
    polyhedraDirty = false;
  }
  })();
  // Most interactive callers intentionally do not await this function. Mark
  // the shared rejection handled while preserving rejection for awaited
  // restoration/bootstrap callers.
  polyhedraPromise.catch(() => {});
  const result = polyhedraPromise;
  polyhedraPromise.then(
    () => { if (polyhedraPromise === result) polyhedraPromise = null; },
    () => { if (polyhedraPromise === result) polyhedraPromise = null; },
  );
  return result;
}

/**
 * Append the atoms needed to complete the polyhedra (vertices on periodic images that
 * aren't in the base displayed set) into `structure.periodic.wrapped`, then re-render atoms
 * and bonds — but only when that set has changed since the last sync (tracked by a signature
 * on `wrapped`). The appended atoms carry `srcIndex = primary atom`, so they inherit the
 * right colour/UUID, and they sit AFTER `wrapped.baseCount` so they never become polyhedra
 * centers.
 * @param {any} structure
 * @param {Polyhedra} model
 */
/** @returns {boolean} whether the displayed/wrapped atom set changed (the
 *  caller then recomputes — the wrapped set feeds back into the compute). */
function syncCompletingAtoms(structure, model) {
  const positions = structure.atoms.map(a => a.position); // fractional
  const elements = [...structure.elements];
  const lattice = structure.lattice;

  // Settle the base `wrapped` (and its hash) for the CURRENT state FIRST. If a hashed input
  // changed — most importantly the bond lengths — runPeriodicWrapped rebuilds `wrapped` from
  // base right here, before we append the completing atoms. That matters because the
  // rebuildAtoms()/rebuildBonds() at the end each call runPeriodicWrapped again: doing the
  // rebuild now means those see a MATCHING hash and reuse the augmented `wrapped`, instead of
  // rebuilding it back to base and dropping the completing atoms (the bug when bond distance
  // changed).
  const hashBefore = structure.periodic?.hash;
  runPeriodicWrapped(structure.periodic, positions, elements, lattice);
  const wrapped = structure.periodic?.wrapped;
  if (!wrapped) return false;
  // Did the settle rebuild `wrapped` to base-only? If so the atom/bond meshes still show the
  // PREVIOUS set (the bond-length edit used reRenderAtoms:false), so the sig-based skip below
  // is unsafe — we must refresh the meshes even if the new completing set is empty/unchanged.
  const baseRebuilt = structure.periodic?.hash !== hashBefore;

  const latInv = invert3x3(transpose3x3(lattice));
  const baseCount = (typeof wrapped.baseCount === 'number')
    ? wrapped.baseCount
    : (wrapped.elements?.length ?? 0);

  // Base displayed image keys (src, shift) of the atoms already shown.
  const baseKeys = new Set();
  for (let i = 0; i < baseCount; i++) {
    const src = wrapped.srcIndex?.[i];
    if (!Number.isInteger(src) || src < 0 || src >= positions.length) continue;
    const f = wrapped.frac?.[i];
    if (!Array.isArray(f) || f.length < 3) continue;
    baseKeys.add(imageKey(src, [
      Math.round(f[0] - positions[src][0]),
      Math.round(f[1] - positions[src][1]),
      Math.round(f[2] - positions[src][2]),
    ]));
  }

  // Every accepted polyhedron vertex whose image isn't already displayed → a completing atom.
  const seen = new Set();
  const add = { elements: [], frac: [], cart: [], srcIndex: [] };
  for (const poly of (model?.polyhedra ?? [])) {
    // Only drawn polyhedra are completed: a hidden category or element
    // (Poly tab switches) would otherwise leave a halo of its corner atoms
    // around the cell with nothing to attach to.
    if (poly.key && resolvePolyhedronStyle(structure, poly.key, poly.catKey, poly.type, poly.centerIndex, poly.colorElem).visible === false) continue;
    const verts = poly.vertices || [];
    const srcs = poly.vertexSrcList || [];
    for (let v = 0; v < verts.length; v++) {
      const src = srcs[v];
      if (!Number.isInteger(src) || src < 0 || src >= positions.length) continue;
      const cart = verts[v];
      const fr = cartToFrac(cart, lattice, latInv);
      const shift = [
        Math.round(fr[0] - positions[src][0]),
        Math.round(fr[1] - positions[src][1]),
        Math.round(fr[2] - positions[src][2]),
      ];
      const key = imageKey(src, shift);
      if (baseKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      add.elements.push(elements[src]);
      add.frac.push([positions[src][0] + shift[0], positions[src][1] + shift[1], positions[src][2] + shift[2]]);
      add.cart.push([cart[0], cart[1], cart[2]]);
      add.srcIndex.push(src);
    }
  }

  const sig = Array.from(seen).sort().join('|');
  // Skip the (expensive) mesh rebuild only when the base wasn't rebuilt this call AND the
  // completing set is unchanged — i.e. the meshes already show exactly this set. When the
  // base WAS rebuilt, the meshes are stale relative to `wrapped`, so we must refresh even if
  // the new completing set is empty (otherwise old completing atoms linger — the bug when
  // bond distance was decreased).
  if (!baseRebuilt && sig === (wrapped.completingSig ?? '')) return false;

  // Rebuild wrapped = base + completing (truncate any previous completing first).
  wrapped.elements.length = baseCount;
  wrapped.frac.length = baseCount;
  wrapped.cart.length = baseCount;
  wrapped.srcIndex.length = baseCount;
  for (let i = 0; i < add.elements.length; i++) {
    wrapped.elements.push(add.elements[i]);
    wrapped.frac.push(add.frac[i]);
    wrapped.cart.push(add.cart[i]);
    wrapped.srcIndex.push(add.srcIndex[i]);
  }
  wrapped.completingSig = sig;

  // Re-render atoms + bonds against the augmented set. The hash was settled above, so
  // rebuildAtoms()'s runPeriodicWrapped reuses this mutated `wrapped` (no rebuild back to base).
  rebuildAtoms();
  rebuildBonds();
  return true;
}
