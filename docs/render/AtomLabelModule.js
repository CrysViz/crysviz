// Atom labels ("Fe1", "O3") drawn on the atoms of the main view, behind the
// general.showAtomLabels flag (the label button next to ✎ in the Structure
// window, ui/StructureInfoPanel/General.js). The inspectors draw the same
// texts in their own views (ui/AnalysisPanels/PolyhedronMiniRenderer.js).
//
// A label is named as the Structure window's atom rows name the atom: its
// element and its number among the atoms of the same site composition, in file
// order (a mixed site reads "(Fe,Ni)2"), so a label in the view and a row in
// the list always agree. Every periodic copy of an atom carries its atom's
// label.
//
// Built the way the charge badges are (render/ChargeBadgeModule.js, whose
// notes explain the choices): THREE.Sprites with canvas textures, cached per
// text, culled each rendered frame against the atoms in front of them and
// decluttered (a label overlapping a nearer one is hidden). A label sits ON
// its atom: at the centre on screen, lifted toward the camera past the
// sphere's front, so the atom is its backdrop. Unlike the badges it keeps one
// size on screen, as text does (LABEL_SCREEN_PX). A label that passes the
// occlusion test is drawn over everything, so a bond leaving its atom toward
// the viewer never cuts through the text; past MAX_OCCLUSION_RAYCASTS the
// plain depth test decides instead.

import * as THREE from '../external/three/three.module.js';

import { app, groups, fileBrowser, general } from '../state/store.js';
import { getElementRadius } from '../defaults/radii_defaults.js';
import { getFocusOpacityForInstance } from './FocusRegionModule.js';
import { getActiveCutPlanes, isPointCutByPlanes } from './BondsFracUpdateModule.js';
import { getFontScale } from '../ui/FontScaleModule.js';
import { requestRender } from './AnimateModule.js';

/** Above this many labels the per-frame raycast is skipped (as for the charge badges). */
const MAX_OCCLUSION_RAYCASTS = 200;
/** Above this many atoms nothing is labelled: one texture per atom, and a
 *  label per atom of a large cell is unreadable anyway. */
export const MAX_LABELLED_ATOMS = 1000;
/** Label height on screen, in CSS pixels (about 13 px of text), times the
 *  app's font scale and the Atom labels ▸ Size slider (Settings,
 *  general.atomLabelScale): a label reads like the panels' text at any zoom
 *  and atom size, as a font does. An image export renders the same view
 *  larger, so there it keeps its share of the picture. */
const LABEL_SCREEN_PX = 22;

/** @type {THREE.Group|null} */
let labelGroup = null;
// `any` for the sprite/texture types: see ChargeBadgeModule.js.
/** @type {Array<{sprite: any, cart: number[], radius: number, aspect: number, srcIndex: number, instance: number}>} */
let labels = [];
/** What the labels were built from: the structure and its symmetry state.
 *  Names depend on the Wyckoff lock (orbit names while it is on), which can
 *  be switched without the atoms being rebuilt — see refreshAtomLabelsIfStale. */
let builtFrom = null;
const labelSource = (structure) => ({
  structure: structure ?? null,
  symmetry: structure?.symmetry ?? null,
  orbitGroups: structure?.symmetry?.orbitGroups ?? null,
});
const sameSource = (a, b) => !!a && a.structure === b.structure && a.symmetry === b.symmetry
  && a.orbitGroups === b.orbitGroups;

/** The app's font scale, read when the labels are built. */
let fontScale = 1;
/** @type {Map<string, any>} */
const textureCache = new Map();

const _raycaster = new THREE.Raycaster();
const _toLabel = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _forward = new THREE.Vector3();

/**
 * Every atom's label, as the Structure window's atom rows name it
 * (StructureInfoPanel/components/IndividualAtomRow.js defaultAtomLabel,
 * numbered within its site-composition group like CompositionRow.js does):
 * "Fe1", "O3", "(Fe,Ni)2". Hidden atoms count, as they do in the rows.
 * With a Wyckoff lock active the rows are orbits, and every member of an
 * orbit carries the orbit's name as its Wyckoff-tab row gives it: element,
 * the orbit's number among that element's orbits, multiplicity and letter,
 * "N6 4e" (CompositionRow.js createWyckoffCompositionRow).
 * @param {any} structure
 * @returns {string[]}
 */
export function atomLabelTexts(structure) {
  const atoms = structure?.atoms ?? [];
  const counts = new Map();
  const orbits = structure?.symmetry?.mode === 'wyckoff' ? structure.symmetry.orbitGroups : null;
  /** @type {Array<string|undefined>} */
  const orbitNames = [];
  if (Array.isArray(orbits) && orbits.length) {
    const perElement = new Map();
    for (const group of orbits) {
      const n = (perElement.get(group.element) ?? 0) + 1;
      perElement.set(group.element, n);
      const name = `${group.element}${n} ${group.multiplicity}${group.wyckoff ?? '?'}`;
      for (const i of group.atomIndices ?? []) orbitNames[i] = name;
    }
  }
  return atoms.map((atom, i) => {
    if (orbitNames[i]) return orbitNames[i];
    const element = structure.elements?.[i] ?? atom?.element ?? '?';
    const species = atom?.species?.length ? atom.species.map((s) => s.element) : [element];
    const elements = [...new Set(species)].sort();
    const vacancy = (atom?.getVacancyFraction?.() ?? 0) > 1e-3;
    const key = elements.join(',') + (vacancy ? ',Vac' : '');
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return atom?.isDisordered?.() ? `(${elements.join(',')})${n}` : `${element}${n}`;
  });
}

/** Clear cached canvas textures (after the bundled fonts have loaded). */
export function clearAtomLabelTextureCache() {
  for (const texture of textureCache.values()) texture.dispose();
  textureCache.clear();
}

/**
 * White bold text with a dark outline and no pill: it reads on any atom colour
 * and leaves the atom's own colour visible around it.
 * @param {string} text
 * @returns {any} a THREE.CanvasTexture
 */
function labelTexture(text) {
  const cached = textureCache.get(text);
  if (cached) return cached;

  const fontPx = 44;
  const font = `700 ${fontPx}px 'CrysViz Sans', sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const stroke = fontPx * 0.2;
  const pad = stroke + 2;
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = Math.ceil(fontPx * 1.2 + pad * 2);
  // Sizing the canvas resets the 2D context, so the font has to be re-applied.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke;
  ctx.strokeStyle = 'rgba(12, 12, 16, 0.9)';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(text, texture);
  return texture;
}

/** Remove every label sprite and free its material (textures stay cached). */
export function disposeAtomLabels() {
  if (labelGroup) {
    for (const { sprite } of labels) {
      sprite.material.dispose();
      labelGroup.remove(sprite);
    }
    app.scene?.remove(labelGroup);
  }
  labelGroup = null;
  labels = [];
}

/**
 * Rebuild every label from the current structure. Cheap enough to call on any
 * structure change; updateAtomLabels() places them each frame.
 */
export function rebuildAtomLabels() {
  disposeAtomLabels();

  const structure = fileBrowser.selectedStructure;
  builtFrom = labelSource(structure);
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!structure || !wrapped || !app.scene) return;
  if (!general.showAtomLabels) return;
  if (structure.atoms.length > MAX_LABELLED_ATOMS) return;

  labelGroup = new THREE.Group();
  labelGroup.name = 'atomLabels';
  const texts = atomLabelTexts(structure);
  fontScale = getFontScale();

  const { elements, cart, srcIndex } = wrapped;
  // Coincident copies of one atom collapse to one label (see the charge
  // badges); distinct copies each get their own.
  const seenAt = new Set();
  for (let i = 0; i < cart.length; i++) {
    const src = srcIndex ? srcIndex[i] : i;
    const c = cart[i];
    const posKey = `${src}:${c[0].toFixed(2)},${c[1].toFixed(2)},${c[2].toFixed(2)}`;
    if (seenAt.has(posKey)) continue;
    const atom = structure.atoms[src];
    if (!atom || atom.hidden) continue;
    seenAt.add(posKey);
    const element = elements[i];
    if (general.atomVisibility?.[element] === false) continue;
    // The sphere's radius as drawn (the instance matrix), so the label clears it.
    const radius = getElementRadius(element) * general.atomSize * (atom.radiusScale ?? 1);
    if (!(radius > 0)) continue;

    const texture = labelTexture(texts[src]);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: true, depthWrite: false,
    }));
    const aspect = texture.image.width / texture.image.height;
    sprite.userData.text = texts[src]; // what it says, for tests
    labelGroup.add(sprite);
    labels.push({ sprite, cart: [c[0], c[1], c[2]], radius, aspect, srcIndex: src, instance: i });
  }

  if (labels.length) app.scene.add(labelGroup);
  else labelGroup = null;
  applyFocusToAtomLabels(structure);
}

/**
 * Rebuild the labels if the names they show are no longer the structure's —
 * a Wyckoff lock switched on or off (or re-grouped) leaves the atoms as they
 * are, so nothing else rebuilds them. Called whenever the Structure window
 * re-renders (it does after every such change) and on each rendered frame;
 * cheap when nothing changed. Tells the inspectors too.
 * @returns {boolean} whether they were rebuilt
 */
export function refreshAtomLabelsIfStale() {
  if (!general.showAtomLabels || sameSource(builtFrom, labelSource(fileBrowser.selectedStructure))) return false;
  rebuildAtomLabels();
  requestRender();
  document.dispatchEvent(new CustomEvent('crysviz:atom-labels-changed'));
  return true;
}

/** A label fades with its atom: the focus-region factor of that instance. */
export function applyFocusToAtomLabels(structure = fileBrowser.selectedStructure) {
  for (const { sprite, instance } of labels) {
    sprite.material.opacity = getFocusOpacityForInstance(instance, structure);
  }
}

/** The labels shown now (for tests): text, whether visible, their atom
 *  (source and instance) and the point they are anchored at. */
export function atomLabelSprites() {
  return labels.map(({ sprite, srcIndex, instance, cart }) => ({
    text: sprite.userData.text, visible: sprite.visible, srcIndex, instance, anchor: [...cart],
  }));
}

/**
 * Place and cull the labels for the current camera. Called once per rendered
 * frame (the app renders on demand, so this does not run while idle).
 */
export function updateAtomLabels() {
  refreshAtomLabelsIfStale();
  if (!labels.length || !app.camera) return;
  const camera = app.camera;
  if (!general.showAtomLabels || general.showAtoms === false || groups.atomsMesh?.visible === false) {
    for (const { sprite } of labels) sprite.visible = false;
    return;
  }

  // An orthographic camera looks along one direction everywhere; a
  // perspective one along the ray to each atom — lifting a label along that
  // ray keeps it exactly over its atom's centre on screen.
  const ortho = !!(/** @type {any} */ (camera).isOrthographicCamera);
  if (ortho) _toCam.set(0, 0, 1).applyQuaternion(camera.quaternion);
  const cutPlanes = getActiveCutPlanes();
  const atoms = fileBrowser.selectedStructure?.atoms ?? [];
  // Each atom's centre and radius as drawn now — read from its instance (the
  // trajectory fast path moves instances without a rebuild; size controls
  // rescale them), so a label never lags its atom.
  const mesh = groups.atomsMesh;
  const m = mesh?.instanceMatrix?.array;
  const count = mesh?.count ?? 0;
  if (mesh) mesh.updateMatrixWorld();
  // World units per CSS pixel: fixed for an orthographic camera, growing with
  // the distance along the view for a perspective one.
  const cam = /** @type {any} */ (camera);
  const viewPx = app.renderer?.domElement?.clientHeight || 600;
  const perPx = ortho
    ? (cam.top - cam.bottom) / (cam.zoom || 1) / viewPx
    : (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2)) / (cam.zoom || 1) / viewPx;
  _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const labelPx = LABEL_SCREEN_PX * fontScale * (general.atomLabelScale ?? 1);
  for (const label of labels) {
    const { sprite, instance } = label;
    if (m && instance < count) {
      const o = instance * 16;
      label.radius = Math.hypot(m[o], m[o + 1], m[o + 2]);
      _anchor.set(m[o + 12], m[o + 13], m[o + 14]).applyMatrix4(mesh.matrixWorld);
      label.cart[0] = _anchor.x; label.cart[1] = _anchor.y; label.cart[2] = _anchor.z;
    } else {
      _anchor.set(label.cart[0], label.cart[1], label.cart[2]);
    }
    sprite.position.copy(_anchor);
    if (!ortho) _toCam.copy(camera.position).sub(_anchor).normalize();
    sprite.position.addScaledVector(_toCam, label.radius * 1.05 + 0.02);
    const depth = ortho ? 1 : Math.max(1e-3, _sep.copy(sprite.position).sub(camera.position).dot(_forward));
    const height = labelPx * perPx * depth;
    sprite.scale.set(height * label.aspect, height, 1);
    // A zero radius is a hidden atom (a hidden element is drawn at scale 0);
    // a cut plane hides an atom in the shader, so the label follows it here.
    sprite.visible = label.radius > 1e-6 && !(cutPlanes.length && !atoms[label.srcIndex]?.cutPlaneImmune
      && isPointCutByPlanes(label.cart, cutPlanes));
  }

  const raycast = labels.length <= MAX_OCCLUSION_RAYCASTS;
  const occluders = [groups.atomsMesh, groups.bondsMesh, groups.polyhedraGroup]
    .filter((o) => o && o.visible);
  if (raycast && occluders.length) {
    // Another copy of the same atom never hides a label (see the badges).
    const structureSrcIndex = fileBrowser.selectedStructure?.periodic?.visibleWrapped?.srcIndex;
    for (const label of labels) {
      const { sprite, radius, srcIndex: own } = label;
      if (!sprite.visible) continue;
      if (ortho) {
        // Rays start on the camera's plane and run along the view direction.
        const back = _sep.copy(camera.position).sub(sprite.position).dot(_toCam);
        _toLabel.copy(_toCam).negate();
        _raycaster.set(_sep.copy(sprite.position).addScaledVector(_toCam, back), _toLabel);
        _raycaster.far = Math.max(0, back - radius * 0.05);
      } else {
        _toLabel.copy(sprite.position).sub(camera.position);
        const dist = _toLabel.length();
        if (!(dist > 0)) continue;
        _raycaster.set(camera.position, _toLabel.normalize());
        _raycaster.far = Math.max(0, dist - radius * 0.05);
      }
      const hits = _raycaster.intersectObjects(occluders, true);
      sprite.visible = !hits.some((hit) => {
        if (hit.object !== groups.atomsMesh || hit.instanceId == null || !structureSrcIndex) return true;
        return structureSrcIndex[hit.instanceId] !== own;
      });
    }
  }
  for (const { sprite } of labels) {
    // Tested: over everything, so its own bonds never cut the text. Untested
    // (a large cell): the depth test decides.
    sprite.material.depthTest = !raycast;
    sprite.renderOrder = raycast ? 20 : 0;
  }

  // Declutter: a label overlapping a nearer one on screen is hidden (not
  // moved: sliding labels distract more than a missing one). Boxes in NDC,
  // bucketed on a grid one widest label wide, so this stays linear for the
  // thousand labels of a large cell.
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const boxes = [];
  let cellW = 0, cellH = 0;
  for (const label of labels) {
    const { sprite } = label;
    if (!sprite.visible) continue;
    _toLabel.copy(sprite.position).project(camera);
    const cx = _toLabel.x, cy = _toLabel.y, cz = _toLabel.z;
    _sep.copy(sprite.position).addScaledVector(_right, sprite.scale.x * 0.5)
      .addScaledVector(_up, sprite.scale.y * 0.5).project(camera);
    const hx = Math.abs(_sep.x - cx), hy = Math.abs(_sep.y - cy);
    cellW = Math.max(cellW, 2 * hx);
    cellH = Math.max(cellH, 2 * hy);
    boxes.push({ sprite, cx, cy, hx, hy, cz });
  }
  boxes.sort((a, b) => a.cz - b.cz); // nearest first
  cellW = cellW || 1;
  cellH = cellH || 1;
  /** @type {Map<string, Array<{cx:number, cy:number, hx:number, hy:number}>>} */
  const grid = new Map();
  for (const box of boxes) {
    const gx = Math.floor(box.cx / cellW), gy = Math.floor(box.cy / cellH);
    let hide = false;
    for (let dx = -1; dx <= 1 && !hide; dx++) {
      for (let dy = -1; dy <= 1 && !hide; dy++) {
        for (const other of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.abs(box.cx - other.cx) < box.hx + other.hx
              && Math.abs(box.cy - other.cy) < (box.hy + other.hy) * 0.9) { hide = true; break; }
        }
      }
    }
    if (hide) { box.sprite.visible = false; continue; }
    const key = `${gx},${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(box);
  }
}
