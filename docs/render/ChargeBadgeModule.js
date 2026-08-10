// Formal-charge badges ("3+", "2−") drawn next to atoms carrying an oxidation
// state, behind the general.showCharges flag.
//
// These are THREE.Sprite objects with a canvas texture rather than CSS2DObject
// labels. CSS2DRenderer is a DOM overlay that never consults the WebGL depth
// buffer, so a CSS2D badge always paints on top of the whole scene — tolerable
// for the occasional measurement label, but not for a badge on potentially
// every atom, where it would read as a cloud of numbers detached from the
// structure. Sprites depth-test for free against opaque geometry; the raycast
// pass below additionally hides badges whose *anchor atom* is itself behind
// something, which the depth test alone cannot do (the badge floats beside the
// atom, so it can be un-occluded while the atom it labels is not).
//
// Textures are cached per charge string — there are only ever a handful of
// distinct charges in a structure, however many atoms carry them.

import * as THREE from '../external/three/three.module.js';

import { app, groups, fileBrowser, general } from '../state/store.js';
import { getElementRadius } from '../defaults/radii_defaults.js';

/** Above this many badges the per-frame raycast is skipped (see updateChargeBadges). */
const MAX_OCCLUSION_RAYCASTS = 200;

// Badge height in world units, scaled by the global atom-size control but
// deliberately NOT by the element's own radius: sizing each badge to its atom
// makes charges on small atoms (O, H) markedly harder to read than those on
// large ones, when both carry the same weight of information. Only the offset
// below tracks the per-atom radius, so badges still sit clear of their sphere.
// Roughly a typical atomic radius, so badges read at the same visual weight as
// the spheres they annotate without any one element dominating.
const BADGE_WORLD_HEIGHT = 1.0;

/** @type {THREE.Group|null} */
let badgeGroup = null;
// `any` for the sprite/texture types: the vendored three.module.js exports
// Sprite and CanvasTexture as values but does not surface them as types, so a
// precise annotation fails typecheck (same reason bondDistanceLabels.js casts
// its CSS2DObject).
/** @type {Array<{sprite: any, cart: number[], radius: number, srcIndex: number}>} */
let badges = [];
/** @type {Map<string, any>} */
const textureCache = new Map();

const _raycaster = new THREE.Raycaster();
const _toBadge = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _sep = new THREE.Vector3();

/**
 * Render a formal charge the way crystallographers write it: magnitude then
 * sign, with a real minus sign rather than a hyphen, and the magnitude dropped
 * when it is 1 ("Cu+" not "Cu1+"). An explicit zero stays "0" — a site declared
 * neutral is information, and is distinct from a site whose charge is unknown
 * (null, which never reaches here).
 *
 * @param {number} charge
 * @returns {string}
 */
export function formatCharge(charge) {
  if (charge === 0) return '0';
  const mag = Math.abs(charge);
  const magText = Number.isInteger(mag) ? String(mag) : String(Number(mag.toFixed(2)));
  return `${mag === 1 ? '' : magText}${charge > 0 ? '+' : '−'}`;
}

/**
 * The inverse of formatCharge(), for a user typing a charge into a table
 * cell (AtomTableInput.js's Charge column): accepts a plain signed number
 * ("3", "-2", "+3") same as before, plus the chemistry notation crystallographers
 * actually write it in — a magnitude then a trailing sign ("3+", "2−"/"2-",
 * bare "+"/"-" meaning 1) or a leading sign ("+3", "-2") — the same two
 * orderings parse_oxidation_from_symbol (cif_parser.js) already tolerates in
 * a CIF's "Fe3+"/"Fe2-" column, just without an element prefix to strip
 * first. Returns null for anything that isn't one of these, including an
 * empty string (blank = unspecified, not 0).
 *
 * @param {string} raw
 * @returns {number|null}
 */
export function parseChargeInput(raw) {
  const s = String(raw).trim().replace(/−/g, '-');
  if (!s) return null;

  // Plain number, exactly what a <input type="number"> already accepted.
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);

  let m = s.match(/^(\d*\.?\d*)([+-])$/);   // "3+", "+"  (digits then sign)
  if (m) {
    const mag = m[1] === '' ? 1 : Number(m[1]);
    return Number.isFinite(mag) ? (m[2] === '-' ? -mag : mag) : null;
  }

  m = s.match(/^([+-])(\d*\.?\d*)$/);       // "+3", "-"  (sign then digits)
  if (m) {
    const mag = m[2] === '' ? 1 : Number(m[2]);
    return Number.isFinite(mag) ? (m[1] === '-' ? -mag : mag) : null;
  }

  return null;
}

/**
 * Collect the charges to show for one atom. Every species carrying a known
 * oxidation state contributes one, so a disordered site labels each of its
 * constituents rather than silently showing only the majority one.
 *
 * @param {any} atom
 * @returns {number[]}
 */
function chargesForAtom(atom) {
  if (!atom?.species) return [];
  return atom.species
    .map((s) => s.oxidationState)
    .filter((c) => Number.isFinite(c));
}

/**
 * @param {string} text
 * @returns {any} a THREE.CanvasTexture (see the note on textureCache)
 */
function chargeTexture(text) {
  const cached = textureCache.get(text);
  if (cached) return cached;

  const fontPx = 64;
  const font = `700 ${fontPx}px 'CrysViz Sans', sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const textWidth = ctx.measureText(text).width;
  const padX = fontPx * 0.42;
  const padY = fontPx * 0.24;
  canvas.width = Math.ceil(textWidth + padX * 2);
  canvas.height = Math.ceil(fontPx + padY * 2);
  // Resizing the canvas resets the 2D context, so the font has to be re-applied.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = 'rgba(20, 20, 24, 0.82)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height * 0.32);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(text, texture);
  return texture;
}

/** Remove every badge sprite and free its material (textures stay cached). */
export function disposeChargeBadges() {
  if (badgeGroup) {
    for (const { sprite } of badges) {
      sprite.material.dispose();
      badgeGroup.remove(sprite);
    }
    app.scene?.remove(badgeGroup);
  }
  badgeGroup = null;
  badges = [];
}

/**
 * Rebuild every badge from the current structure. Cheap enough to call on any
 * structure change; call updateChargeBadges() afterwards to place them.
 */
export function rebuildChargeBadges() {
  disposeChargeBadges();

  const structure = fileBrowser.selectedStructure;
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!structure || !wrapped || !app.scene) return;
  if (general.showCharges === false) return;

  badgeGroup = new THREE.Group();
  badgeGroup.name = 'chargeBadges';

  const { elements, cart, srcIndex } = wrapped;
  // An atom sitting on a cell face/edge/corner gets several wrapped
  // instances - the periodic mirror mechanism draws it again at each
  // touching corner so the cell reads as complete, which is genuinely
  // several distinct on-screen spheres and each earns its own badge. What
  // it can ALSO produce, though, is two mirror copies landing on top of (or
  // very close to) each other for the same source atom - a corner that's
  // near more than one face at once can generate near-duplicate positions a
  // fraction of an Angstrom apart - and THOSE stack illegibly. Dedup by
  // (source atom, rounded position) rather than by source atom alone, so
  // only genuinely-coincident copies collapse to one badge.
  const seenAt = new Set();
  for (let i = 0; i < srcIndex.length; i++) {
    const c = cart[i];
    const posKey = `${srcIndex[i]}:${c[0].toFixed(2)},${c[1].toFixed(2)},${c[2].toFixed(2)}`;
    if (seenAt.has(posKey)) continue;
    const atom = structure.atoms[srcIndex[i]];
    if (!atom || atom.hidden) continue;
    seenAt.add(posKey);

    const charges = chargesForAtom(atom);
    if (!charges.length) continue;

    // Matches the diameter written into the instance matrix, so the badge
    // tracks the atom's on-screen size including per-element hiding (radius 0).
    const element = elements[i];
    const hidden = general.atomVisibility?.[element] === false;
    if (hidden) continue;
    const radius = getElementRadius(element) * general.atomSize * (atom.radiusScale ?? 1);
    if (!(radius > 0)) continue;

    const text = charges.map((c) => formatCharge(c)).join('/');
    const texture = chargeTexture(text);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: true, depthWrite: false,
    }));
    const height = BADGE_WORLD_HEIGHT * (general.atomSize || 1);
    const aspect = texture.image.width / texture.image.height;
    sprite.scale.set(height * aspect, height, 1);

    badgeGroup.add(sprite);
    badges.push({ sprite, cart: cart[i], radius, srcIndex: srcIndex[i] });
  }

  if (badges.length) app.scene.add(badgeGroup);
  else badgeGroup = null;
}

/**
 * Place and cull the badges for the current camera. Called once per rendered
 * frame (the app renders on demand, so this does not run while idle).
 *
 * Placement is screen-space: each badge sits up and to the right of its atom's
 * silhouette edge rather than at its centre, so it neither covers the atom nor
 * collides with anything drawn at the atom's own position.
 */
export function updateChargeBadges() {
  if (!badges.length || !app.camera) return;

  const camera = app.camera;
  if (general.showCharges === false) {
    for (const { sprite } of badges) sprite.visible = false;
    return;
  }

  // Screen-space right/up in world terms, so the offset direction is stable
  // regardless of how the structure is oriented.
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);

  for (const badge of badges) {
    const { sprite, cart, radius } = badge;
    _anchor.set(cart[0], cart[1], cart[2]);
    sprite.position.copy(_anchor)
      .addScaledVector(_right, radius * 0.75)
      .addScaledVector(_up, radius * 0.75);
    sprite.visible = true;
  }

  // A raycast per badge per frame does not scale, so past a threshold fall back
  // to the plain depth test: badges may then show through atoms in front of
  // them, which is a better failure than a stalled viewport on a large cell.
  if (badges.length > MAX_OCCLUSION_RAYCASTS) return;

  const occluders = [groups.atomsMesh, groups.bondsMesh, groups.polyhedraGroup, groups.latticeGroup]
    .filter((o) => o && o.visible);
  if (!occluders.length) return;

  // A corner/edge atom's own OTHER periodic images sit in the same
  // atomsMesh - two images of one atom (same charge, same everything) can
  // land exactly in line with the camera (e.g. two opposite corners of a
  // cube on its body diagonal), and without this the far one's badge gets
  // "occluded" by its own sibling image and disappears, while the six other
  // images around it stay visible - inconsistent and confusing given they
  // all represent the very same atom. Only a DIFFERENT atom (or a bond /
  // polyhedron / the lattice) should be able to hide a badge.
  const structureSrcIndex = fileBrowser.selectedStructure?.periodic?.visibleWrapped?.srcIndex;

  for (const badge of badges) {
    const { sprite, radius, srcIndex: ownSrcIndex } = badge;
    // Raycast to the SPRITE's actual position, not the atom's centre (cart)
    // - the sprite sits offset up-and-right of the atom (see the placement
    // loop above), so testing the atom's centre checks a different point
    // than the one that actually renders, and a badge that should be
    // hidden behind a foreground atom would pass the check anyway.
    _toBadge.copy(sprite.position).sub(camera.position);
    const dist = _toBadge.length();
    if (!(dist > 0)) continue;
    _raycaster.set(camera.position, _toBadge.normalize());
    // Stop just short of the sprite itself, or its own anchor atom (the
    // offset is small relative to the atom's radius) would self-occlude it.
    _raycaster.far = Math.max(0, dist - radius * 0.2);
    const hits = _raycaster.intersectObjects(occluders, true);
    sprite.visible = !hits.some((hit) => {
      if (hit.object !== groups.atomsMesh || hit.instanceId == null || !structureSrcIndex) return true;
      return structureSrcIndex[hit.instanceId] !== ownSrcIndex;
    });
  }

  // Label declutter for two DIFFERENT atoms' badges landing close together
  // on screen: hide the farther one rather than nudging positions apart.
  // Position-based avoidance (an earlier version of this) made badges
  // visibly slide and pivot around each other as the camera moved — more
  // distracting than a badge just disappearing. Priority is camera distance
  // (nearer badge wins, stays put at its natural anchor); a badge that loses
  // is hidden outright rather than relocated. HIDE_MARGIN > 1 means a badge
  // hides before its edges actually touch a nearer one's — deliberately
  // erring toward hiding a bit early over ever showing a merged, illegible
  // pair. Runs after the occlusion pass so it only competes among badges
  // that survived real occlusion.
  const HIDE_MARGIN = 1.3;
  const contendingBadges = badges.filter((b) => b.sprite.visible);
  contendingBadges.sort((a, b) =>
    a.sprite.position.distanceToSquared(camera.position) - b.sprite.position.distanceToSquared(camera.position));
  const keptBadges = [];
  for (const badge of contendingBadges) {
    const { sprite } = badge;
    let hide = false;
    for (const kept of keptBadges) {
      _sep.copy(sprite.position).sub(kept.sprite.position);
      const dx = _sep.dot(_right);
      const dy = _sep.dot(_up);
      const dist = Math.hypot(dx, dy);
      const ux = dist > 1e-6 ? dx / dist : 1;
      const uy = dist > 1e-6 ? dy / dist : 0;
      const extentThis = Math.abs(ux) * sprite.scale.x * 0.5 + Math.abs(uy) * sprite.scale.y * 0.5;
      const extentKept = Math.abs(ux) * kept.sprite.scale.x * 0.5 + Math.abs(uy) * kept.sprite.scale.y * 0.5;
      if (dist < (extentThis + extentKept) * HIDE_MARGIN) { hide = true; break; }
    }
    if (hide) sprite.visible = false;
    else keptBadges.push(badge);
  }
}
