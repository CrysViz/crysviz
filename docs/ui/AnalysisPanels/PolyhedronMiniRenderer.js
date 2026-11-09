// Standalone mini 3D viewport for PolyhedronInspector.js: its own scene,
// camera, WebGL renderer and TrackballControls (same orbit library the main
// viewer uses — see ui/WindowAndSceneControls.js), rendering just ONE
// polyhedron, or one atom selection, with bond-length and bond-angle labels
// drawn as real, depth-
// tested objects in the scene (THREE.Sprite with a canvas-texture — not a
// DOM/CSS2D overlay — so a label sitting behind the polyhedron or an atom
// is correctly hidden instead of always floating on top).
// Deliberately reuses the MAIN view's actual material factory
// (MaterialStyles.js's createStyledMaterial + the getAtomVisSettings/
// getBondVisSettings presets), lighting rig, and renderer colour/tone-mapping
// config verbatim — not a fresh guess at "looks similar" — so this really is
// the same rendering pipeline's output, just pointed at a tiny standalone
// scene instead of app.scene. Fully self-contained: never touches app.scene.

import * as THREE from '../../external/three/three.module.js';
import { TrackballControls } from '../../external/three/TrackballControls.js';
import { ConvexGeometry } from '../../external/three/ConvexGeometry.js';
import { defaultColorMap, getAtomVisSettings, getBondVisSettings } from '../../defaults/color_texture_defaults.js';
import { createStyledMaterial } from '../../render/MaterialStyles.js';
import { app, general } from '../../state/store.js';
import { formatWithSu } from '../../model/cifErrors.js';

const FALLBACK_COLOR = 0x999999;
// Label and arc colours default to the look below; the inspectors' colour
// controls (inspectorLabels.js) override any of them (setLabelColors).
const LENGTH_TEXT = '#fff';
const LENGTH_BG = 'rgba(0,0,0,0.72)';
const ANGLE_TEXT = '#1a1300';
const ANGLE_BG = 'rgba(255,204,68,0.92)';
const ANGLE_ACCENT = 0xffcc44; // arc + angle-label accent
const COMPARE_TEXT = '#e0303a';
// The label buttons' icons (hide, put back), drawn as strokes so they stay
// crisp at any size; currentColor follows the button's theme colour.
const ICON_HIDE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_PUT_BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 10.2A5 5 0 1 0 4.6 4.6L2.6 6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.6 3.2v3.4H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// A placed label's leader back to its bond or arc: a neutral grey that reads
// on the dark view and on a white export alike.
const LEADER_COLOR = '#8a8a8a';

/** '#rrggbb' at the given opacity, as a canvas fillStyle. */
function withAlpha(hex, alpha) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
/** Resolve a colour to a THREE-usable value: prefer the explicit per-atom hex
 *  (already the main view's colour), fall back to the element default. */
function resolveColor(hex, element) {
  if (typeof hex === 'number') return hex;
  const c = element ? (general.customColorMap?.[element] ?? defaultColorMap[element]) : undefined;
  return c !== undefined ? c : FALLBACK_COLOR;
}

/** Same material the main atoms/bonds meshes use (MeshPhysicalMaterial with
 *  the roughness/metalness/clearcoat preset for the active render style, or
 *  MeshToonMaterial in 'cel' style) — see MaterialStyles.createStyledMaterial. */
function atomMaterial(color) {
  return createStyledMaterial({ ...getAtomVisSettings(1.0), color });
}
function bondHalfMaterial(color) {
  return createStyledMaterial(getBondVisSettings(color, 1.0));
}

/** Renders `text` onto an offscreen canvas (rounded pill background) and
 *  returns a THREE.Sprite showing it. Sprites are ordinary depth-tested scene
 *  objects (always face the camera, but `depthTest:true` still lets nearer
 *  geometry — an atom, a hull face — correctly occlude them), which is what
 *  lets a label sit right on top of its bond/arc and still disappear when
 *  that spot is rotated behind the polyhedron. `worldHeight` is the sprite's
 *  height in scene units, so callers can size labels relative to the
 *  polyhedron's own bond length. */
function makeLabelSprite(text, { color = '#fff', bg = 'rgba(0,0,0,0.72)', bold = false, worldHeight = 0.3, resolution = 1 } = {}) {
  // `resolution` > 1 draws the texture larger (an image export renders the
  // view several times its on-screen size); the sprite's world size is the same.
  const fontPx = 56 * resolution;
  const font = `${bold ? 700 : 500} ${fontPx}px 'CrysViz Sans', sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  // A label is one run of text, or several runs in their own colours (a
  // compared value after the inspected one): [{ text, color }].
  const runs = Array.isArray(text) ? text : [{ text, color }];
  const runWidths = runs.map((r) => ctx.measureText(r.text).width);
  const textWidth = runWidths.reduce((a, b) => a + b, 0);
  const padX = fontPx * 0.55;
  const padY = fontPx * 0.36;
  canvas.width = Math.ceil(textWidth + padX * 2);
  canvas.height = Math.ceil(fontPx + padY * 2);
  // Sizing the canvas resets the 2D context state, so re-apply the font.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const r = canvas.height * 0.3;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, r);
  ctx.fill();

  ctx.textAlign = 'left';
  let x = (canvas.width - textWidth) / 2;
  runs.forEach((r, i) => {
    ctx.fillStyle = r.color ?? color;
    ctx.fillText(r.text, x, canvas.height / 2 + fontPx * 0.03);
    x += runWidths[i];
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: true, depthWrite: false,
  }));
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(worldHeight * aspect, worldHeight, 1);
  sprite.userData.text = runs.map((r) => r.text).join(''); // what it says, for tests
  return sprite;
}

// Scratch vector for the per-frame camera-lift of the bond-length labels.
const _miniToCam = new THREE.Vector3();

/** A two-tone cylinder between atoms at `a` (colour ca) and `b` (colour cb)
 *  — the half-and-half bond look the main viewer uses. It starts `trimA`
 *  from `a` and ends `trimB` before `b`: where the main render draws the same
 *  bond (scaled to this view's sphere sizes), so the joints look as they do
 *  there. Open-ended like the main view's bond cylinders. */
function makeBond(a, b, ca, cb, radius, trimA = 0, trimB = 0) {
  const g = new THREE.Group();
  const dir = b.clone().sub(a);
  const dist = dir.length();
  dir.normalize();
  if (trimA + trimB >= dist - 1e-4) return g; // the atoms overlap: no visible bond
  const start = a.clone().addScaledVector(dir, trimA);
  const end = b.clone().addScaledVector(dir, -trimB);
  const mid = start.clone().lerp(end, 0.5);
  const half = start.distanceTo(end) / 2;
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  for (const [from, to, color] of [[start, mid, ca], [mid, end, cb]]) {
    const geom = new THREE.CylinderGeometry(radius, radius, half, 16, 1, true);
    const mesh = new THREE.Mesh(geom, bondHalfMaterial(color));
    mesh.position.copy(from.clone().lerp(to, 0.5));
    mesh.quaternion.copy(quat);
    g.add(mesh);
  }
  return g;
}

/** Points along the minor arc between unit directions d1,d2, radius r from
 *  origin `center` — for drawing an angle indicator between two bonds. */
function arcPoints(center, d1, d2, r, segments = 28) {
  const theta = Math.acos(Math.max(-1, Math.min(1, d1.dot(d2))));
  const pts = [];
  if (theta < 1e-4) return pts;
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

function disposeObject3D(obj) {
  obj.traverse((child) => {
    // THREE.Sprite instances share a single module-level plane geometry
    // across the WHOLE app — disposing it here would break every other
    // sprite, so only dispose per-instance (non-Sprite) geometry.
    if (child.geometry && !child.isSprite) {
      try { child.geometry.dispose(); } catch { /* already disposed */ }
    }
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (m.map) { try { m.map.dispose(); } catch { /* already disposed */ } } // label canvas texture
        try { m.dispose(); } catch { /* already disposed */ }
      }
    }
  });
}

/** The faint look of an atom or bond the Add atoms tool offers. */
function makeGhost(material) {
  material.transparent = true;
  material.opacity = 0.28;
  material.depthWrite = false;
  material.needsUpdate = true;
}

function applyFaceOpacity(material, opacity) {
  if (!material) return;
  material.opacity = opacity;
  material.transparent = opacity < 0.999;
  material.depthWrite = opacity >= 0.999;
  material.needsUpdate = true;
}

/** @param {HTMLElement} container empty block element the viewport fills */
export function createPolyhedronMiniRenderer(container) {
  container.classList.add('pi-mini-container');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  camera.position.set(0, 0, 6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  // Draw at the screen's own resolution, as the main view does
  // (ui/WindowAndSceneControls.js): at the default ratio of 1 a Retina screen
  // showed this view upscaled, with soft, stepped atom outlines. An image
  // export sets 1 for its own renders and restores this afterwards.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  // Same colour pipeline as the main viewer (ui/WindowAndSceneControls.js's
  // initRenderer) — without this the mini view reads flat/washed-out next to
  // the main scene even with identical materials and lights.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.domElement.className = 'pi-mini-canvas';
  container.appendChild(renderer.domElement);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3.0;
  controls.noPan = true;
  controls.minDistance = 0.5;
  controls.maxDistance = 100;

  // Exact main-view lighting rig (ui/WindowAndSceneControls.js's setupScene +
  // render/AnimateModule.js's per-frame key-light placement): a soft ambient
  // fill plus one strong directional key light parked upper-front-right
  // relative to the (mini) camera, re-aimed every frame as the user orbits.
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 5.0);
  scene.add(keyLight);
  // A DirectionalLight's un-added `.target` defaults to world (0,0,0) and,
  // never being part of the scene graph, stays there forever — fine for the
  // main view where the structure sits near the origin, but this mini scene
  // draws the polyhedron at its real absolute coordinates from the parent
  // structure, which can be many Å away from (0,0,0). With the target stuck
  // at the origin, the light's actual direction was dominated by "point at
  // the origin" rather than "stay upper-front-right of the camera", so a
  // half-turn could swing a previously lit face into near-darkness. Adding
  // the target to the scene and tracking controls.target (the polyhedron's
  // own centroid) every frame restores the intended camera-relative headlamp.
  scene.add(keyLight.target);

  let group = new THREE.Group();
  scene.add(group);
  let faceMaterial = null; // live handle for the opacity slider
  let occluders = []; // atoms/bonds/hull — tested against for label visibility
  let labelSprites = []; // every bond-length/angle label sprite currently shown
  const labelRay = new THREE.Raycaster();
  // Whether the camera has already been framed onto a polyhedron — lets
  // setModel's `keepCamera` option skip re-framing on a pure colour refresh
  // (no selection/geometry change) instead of snapping the user's own
  // orbit/zoom in this mini viewport back to the auto-framed view every time.
  let hasFramed = false;
  // Angle arcs and length labels are toggleable (the inspector's switches),
  // and labels can be hidden one by one. The last model + face-opacity are
  // remembered so any of these can rebuild the scene in place — keeping the
  // camera — without the caller re-supplying them.
  let showAngles = true;
  let showLengths = true;
  /** @type {Set<string>} */
  let hiddenLabels = new Set();
  let lastModel = null;
  let lastFrame = null;
  let lastFrameAll = null;
  let lastFaceOpacityOpt;
  let atomMeshes = []; // pickable: a click on one is reported to the inspector
  let handlers = { onLabelHide: null, onAtomClick: null, onLabelMoved: null };
  // Labels the user placed (setPlacing): label key -> offset from its own
  // place, in world units along the camera's right and up. Kept in screen
  // directions, so a placed label stays beside its bond or angle as the view
  // turns, scales with zoom, and comes out the same in an export. A placed
  // label draws over everything, with a thin leader to the centre of its bond
  // or the middle of its arc. The map is the caller's (inspectorLabels.js
  // state), so placements survive a rebuild.
  /** @type {Map<string, {r: number, u: number}>} */
  let labelOffsets = new Map();
  let placing = false;
  // See inspectorLabels.js LabelColors; null = the default above.
  let labelColors = { valueA: null, valueB: COMPARE_TEXT, lengthBg: null, angleBg: null, arc: null };

  let running = false;
  let rafId = null;
  // Label texture resolution: 1 on screen, higher while an export renders.
  let labelResolution = 1;
  function frame() {
    if (!running) return;
    controls.update();
    updateLights();
    updateLabels();
    placeRemoveButton();
    placeReturnButtons();
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }

  function updateLights() {
    keyLight.position.copy(camera.position).add(
      new THREE.Vector3(3, 4, 3).applyQuaternion(camera.quaternion),
    );
    keyLight.target.position.copy(controls.target);
  }

  function updateLabels() {
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    for (const sprite of labelSprites) {
      // Bond-length labels sit ON their bond and are lifted toward the camera
      // so the bond renders BEHIND them — the same "value in front of the line"
      // look as the main measurement labels, instead of the bond cutting into
      // the label. Crucially this lift is ALONG the camera→anchor ray, so it
      // never changes where the label lands on screen (a point moved toward the
      // camera along its own view ray projects to the same pixel): the label
      // stays visually glued to its bond as the viewport rotates, no sliding.
      const base = sprite.userData.baseAnchor;
      if (base) {
        _miniToCam.copy(camera.position).sub(base);
        const d = _miniToCam.length() || 1;
        _miniToCam.multiplyScalar(1 / d);
        sprite.position.copy(base).addScaledVector(_miniToCam, Math.min(sprite.userData.lift, d * 0.5));
      } else if (sprite.userData.home) {
        sprite.position.copy(sprite.userData.home);
      }
      const off = sprite.userData.labelKey != null ? labelOffsets.get(sprite.userData.labelKey) : null;
      sprite.material.depthTest = !off;
      sprite.renderOrder = off ? 10 : 0;
      if (off) {
        // Placed by the user: where they put it, over everything, on a leader.
        sprite.position.addScaledVector(camRight, off.r).addScaledVector(camUp, off.u);
        sprite.visible = true;
        placeLeader(sprite.userData.leader, sprite.userData.leaderAnchor, sprite.position);
        continue;
      }
      if (sprite.userData.leader) sprite.userData.leader.visible = false;
      // Hide a label actually blocked (by an atom, another bond, or the hull)
      // from the current angle — a real raycast rather than an angle-from-centre
      // heuristic, which wrongly flags labels as "far side" whenever the
      // polyhedron is viewed near one of its own vertices. The label's OWN bond
      // sits behind the lifted position, so it is past the ray's far clip and
      // never counts as an occluder — only genuinely-in-front geometry hides it.
      const toLabel = sprite.position.clone().sub(camera.position);
      const dist = toLabel.length();
      labelRay.set(camera.position, toLabel.normalize());
      labelRay.far = dist - 0.01;
      sprite.visible = labelRay.intersectObjects(occluders, true).length === 0;
    }
  }

  function start() { if (running) return; running = true; frame(); }
  function stop() { running = false; if (rafId != null) cancelAnimationFrame(rafId); rafId = null; }

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    controls.handleResize();
  }

  /**
   * Draw a model: atoms, the bonds between them, the angles between bonds that
   * meet at an atom, and optionally a convex hull. The inspector builds one
   * from a polyhedron (centre + vertices + hull) or from an atom selection.
   * Every label carries a key so it can be hidden individually. A length or
   * angle with an s.u. (lengthSu / angleSu, the CIF errors —
   * model/cifErrors.js) is written with it in parentheses, 2.3456(12) Å; a
   * compared value with its own (lengthSu2 / angleSu2) likewise.
   * @param {null | {
   *   atoms: Array<{key:string, pos:number[], color?:number|null, element?:string|null, radius?:number|null, ghost?:boolean}>,
   *   bonds: Array<{key?:string, a:number, b:number, colorA?:number|null, colorB?:number|null, trimA?:number|null, trimB?:number|null, length?:number|null, length2?:number|null, lengthSu?:number|null, lengthSu2?:number|null, labelAt?:number, ghost?:boolean}>,
   *   angles: Array<{key:string, at:number, i:number, j:number, angleDeg:number, angleDeg2?:number|null, angleSu?:number|null, angleSu2?:number|null}>,
   *   hull?: null | {points:number[][], faceColor?:number|string, faceOpacity?:number, edgeColor?:number|string},
   * }} model
   * @param {{faceOpacity?: number, keepCamera?: boolean}} [opts] local opacity
   *   override (0-1) for the hull face, independent of the main structure's
   *   setting; `keepCamera` skips the auto-framing step below so a refresh
   *   that keeps the same subject doesn't disturb the user's own orbit/zoom
   *   (ignored until the camera has been framed at least once).
   */
  function setModel(model, opts = {}) {
    scene.remove(group);
    disposeObject3D(group);
    group = new THREE.Group();
    scene.add(group);
    faceMaterial = null;
    occluders = [];
    labelSprites = [];
    atomMeshes = [];
    lastModel = model;
    if (opts.faceOpacity != null) lastFaceOpacityOpt = opts.faceOpacity;
    if (!model || !model.atoms.length) { hasFramed = false; return; }

    const atomVecs = model.atoms.map((a) => new THREE.Vector3(...a.pos));
    // Label colours: a chosen value colour applies to both kinds of label; a
    // compared structure's values (bonds' length2, angles' angleDeg2) have
    // their own.
    const lengthText = labelColors.valueA ?? LENGTH_TEXT;
    const angleText = labelColors.valueA ?? ANGLE_TEXT;
    const compareColor = labelColors.valueB ?? COMPARE_TEXT;
    // A chosen pill colour is near-opaque, as the angle pills are: the default
    // dark pill may let its bond show through, a figure's white one should not.
    const lengthBg = labelColors.lengthBg ? withAlpha(labelColors.lengthBg, 0.92) : LENGTH_BG;
    const angleBg = labelColors.angleBg ? withAlpha(labelColors.angleBg, 0.92) : ANGLE_BG;
    const arcColor = labelColors.arc ?? ANGLE_ACCENT;
    const solid = model.atoms.map((a, i) => (a.ghost ? null : atomVecs[i])).filter(Boolean);
    const framePoints = solid.length ? solid : atomVecs;
    const sphereOf = (points) => {
      const c = points.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
      return { centroid: c, radius: points.reduce((m, p) => Math.max(m, p.distanceTo(c)), 0.5) };
    };
    const { centroid, radius: maxRadius } = sphereOf(framePoints);

    // One length scale for spheres, bond radii, arcs and labels: the shortest
    // drawn bond, else the closest pair of atoms, else the model's own size.
    let span = Infinity;
    for (const b of model.bonds) {
      if (!b.ghost) span = Math.min(span, atomVecs[b.a].distanceTo(atomVecs[b.b]));
    }
    if (!Number.isFinite(span)) {
      for (let i = 0; i < solid.length; i++) {
        for (let j = i + 1; j < solid.length; j++) span = Math.min(span, solid[i].distanceTo(solid[j]));
      }
    }
    const bondSpan = Number.isFinite(span) && span > 1e-3 ? span : maxRadius;

    // Keep the atoms ball-and-stick sized (so bonds/angles stay visible) while
    // preserving the REAL relative sizes + colours: shrink every rendered
    // radius by one common factor so the largest sphere is ~0.34× the shortest
    // bond, then never smaller than a floor so tiny-radius species still show.
    const maxRaw = Math.max(0.001, ...model.atoms.map((a) => a.radius ?? 0));
    const shrink = Math.min(1, (bondSpan * 0.34) / maxRaw);
    const floor = bondSpan * 0.06;
    const sphereFor = (r) => Math.max(floor, (r ?? maxRaw) * shrink);
    // Frame the outer atoms' whole spheres, not just their centres. The faint
    // atoms only count when fitting on request (fit({includeGhosts})).
    lastFrame = { centroid, maxRadius: maxRadius + sphereFor(maxRaw) };
    const all = sphereOf(atomVecs);
    lastFrameAll = { centroid: all.centroid, maxRadius: all.radius + sphereFor(maxRaw) };

    // Finer than the main view's 32 x 24: a few atoms fill this view, so each
    // sphere is drawn many times larger and a coarser mesh shows its facets
    // along the outline.
    const sphereGeom = new THREE.SphereGeometry(1, 48, 36);
    const bondRadius = bondSpan * 0.045;
    const atomColors = model.atoms.map((a) => resolveColor(a.color, a.element));
    const sphereR = model.atoms.map((a) => sphereFor(a.radius) * (a.ghost ? 0.8 : 1));
    // A bond end from the main render (trimA/trimB, Å from the atom's centre)
    // scaled by how much this view resized that atom's sphere; no drawn bond
    // in the main view → from the centre.
    const endAt = (trim, i) => {
      const raw = model.atoms[i].radius;
      return trim != null && raw > 0 ? trim * (sphereR[i] / raw) : 0;
    };

    model.atoms.forEach((a, i) => {
      const material = atomMaterial(atomColors[i]);
      if (a.ghost) makeGhost(material);
      const mesh = new THREE.Mesh(sphereGeom, material);
      mesh.position.copy(atomVecs[i]);
      mesh.scale.setScalar(sphereR[i]);
      mesh.userData.atomIndex = i;
      group.add(mesh);
      atomMeshes.push(mesh);
      if (!a.ghost) occluders.push(mesh);
    });

    for (const b of model.bonds) {
      const pa = atomVecs[b.a], pb = atomVecs[b.b];
      // Prefer the bond's OWN rendered half-colours (length/category/user-
      // override colouring can differ from the endpoint atoms' own colours)
      // and fall back to the endpoint atom colours when no matching bond was
      // found (e.g. bonds currently hidden).
      const ca = b.colorA != null ? resolveColor(b.colorA, model.atoms[b.a].element) : atomColors[b.a];
      const cb = b.colorB != null ? resolveColor(b.colorB, model.atoms[b.b].element) : atomColors[b.b];
      const bond = makeBond(pa, pb, ca, cb, b.ghost ? bondRadius * 0.6 : bondRadius,
        endAt(b.trimA, b.a), endAt(b.trimB, b.b));
      if (b.ghost) bond.traverse((c) => { if (c.material) makeGhost(c.material); });
      group.add(bond);
      if (b.ghost) continue;
      occluders.push(bond);
      if (!showLengths || b.length == null || (b.key && hiddenLabels.has(b.key))) continue;
      const labelHeight = bondSpan * 0.11;
      const lengthValue = formatWithSu(b.length, b.lengthSu, 3);
      const text = b.length2 == null ? `${lengthValue} Å` : [
        { text: lengthValue, color: lengthText },
        { text: `  ${formatWithSu(b.length2, b.lengthSu2, 3)}`, color: compareColor },
        { text: ' Å', color: lengthText },
      ];
      const label = makeLabelSprite(text, {
        color: lengthText, bg: lengthBg, bold: true, worldHeight: labelHeight, resolution: labelResolution,
      });
      // Anchored ON the bond (toward its far end for a polyhedron, so the label
      // clears the angle-arc cluster at the centre). It is NOT offset sideways:
      // the frame loop lifts it toward the camera so the bond renders behind it
      // (the main measurement labels' "value in front of the line" look), and
      // that lift keeps its screen position fixed on the bond, so nothing
      // slides as the viewport rotates.
      label.userData.baseAnchor = pa.clone().lerp(pb, b.labelAt ?? 0.5);
      // Lift far enough to clear the bond cylinder's near surface (radius)
      // with margin, so the bond can never cut into the label.
      label.userData.lift = bondRadius * 3 + labelHeight * 0.5;
      label.userData.labelKey = b.key ?? null;
      label.position.copy(label.userData.baseAnchor);
      label.userData.leaderAnchor = label.userData.baseAnchor.clone();
      label.userData.leader = makeLeader(bondSpan);
      group.add(label.userData.leader);
      group.add(label);
      labelSprites.push(label);
    }

    // Convex hull: translucent faces + edges styled like the main view's
    // polyhedron (also the only geometry for cages, which have no centre bonds).
    // Face material matches PolyhedraModule.renderPolyhedra's own params
    // (metalness 0 / roughness 1) rather than the atom/bond preset — that's
    // what the main view's polyhedra actually use.
    const hull = model.hull;
    if (hull && hull.points.length >= 4) {
      try {
        const hullGeom = new ConvexGeometry(hull.points.map((p) => new THREE.Vector3(...p)));
        const edges = new THREE.EdgesGeometry(hullGeom, 15);
        group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: hull.edgeColor ?? 0x222222, transparent: true, opacity: 0.6 })));
        faceMaterial = new THREE.MeshStandardMaterial({
          color: hull.faceColor ?? 0x3388ff, side: THREE.DoubleSide, metalness: 0, roughness: 1,
        });
        applyFaceOpacity(faceMaterial, opts.faceOpacity ?? lastFaceOpacityOpt ?? hull.faceOpacity ?? 0.4);
        // NOT added to `occluders`: bond/angle-label anchor points sit inside
        // the hull by construction (a point between the convex hull's centre
        // and any of its own vertices is itself interior), so an unconditional
        // hull-vs-label raycast would hide literally every label at any
        // camera angle. The hull still occludes labels correctly through the
        // ordinary WebGL depth test instead (see applyFaceOpacity/
        // setFaceOpacity), which already only writes depth once its opacity
        // is high enough to read as "solid" — exactly the opacity-dependent
        // behaviour actually wanted here.
        group.add(new THREE.Mesh(hullGeom, faceMaterial));
      } catch { /* degenerate/coplanar point set — skip the hull, spheres+bonds still show */ }
    }

    // Angle indicators: an arc between the two bonds + the value on it, for
    // whichever pairs the model supplies (a polyhedron's inspector picks the
    // pairs its distortion metric is defined over; a selection gives every
    // pair of selected bonds at an atom). Suppressed entirely when the
    // inspector's Angles toggle is off (see setShowAngles).
    if (showAngles) {
      // A bit bigger than "just clear of the atom sphere" — pushes the arc (and
      // the label riding on it) further out so neither reads as overlapping
      // the atom from any orientation.
      const arcR = bondSpan * 0.4;
      const arcTubeRadius = bondSpan * 0.014;
      for (const a of model.angles) {
        if (hiddenLabels.has(a.key)) continue;
        const centerVec = atomVecs[a.at];
        const d1 = atomVecs[a.i].clone().sub(centerVec).normalize();
        const d2 = atomVecs[a.j].clone().sub(centerVec).normalize();
        const pts = arcPoints(centerVec, d1, d2, arcR);
        if (!pts.length) continue;
        // A real tube (not a THREE.Line) so the arc reads as clearly thick
        // at this small a viewport size — LineBasicMaterial's `linewidth`
        // is ignored on most platforms (a long-standing WebGL limitation).
        const arcCurve = new THREE.CatmullRomCurve3(pts);
        const arcTubeGeom = new THREE.TubeGeometry(arcCurve, Math.max(8, pts.length - 1), arcTubeRadius, 8, false);
        // depthWrite:false so this ring can never win the depth test against
        // a LABEL — with a CN6 centre there are up to 12 of these arcs
        // packed close together, and one ring's tube sitting a hair nearer
        // the camera than a neighbour's label was hiding that label behind
        // it. Labels still depth-test correctly against the real geometry
        // (atoms, hull, bonds), which DO write depth — only rings never
        // occlude a label now, so every label reads as "in front of its ring".
        group.add(new THREE.Mesh(arcTubeGeom, new THREE.MeshBasicMaterial({ color: arcColor, depthWrite: false })));
        // Sit right on the arc itself (a hair outside it) rather than pushed
        // out toward the hull — depth-testing (not spatial offset) is what
        // keeps this legible now, and a label glued to its own arc is much
        // easier to attribute at a glance than one floating further out.
        const mid = pts[Math.floor(pts.length / 2)];
        const outward = mid.clone().sub(centerVec).normalize();
        const angleValue = `${formatWithSu(a.angleDeg, a.angleSu, 1)}°`;
        const text = a.angleDeg2 == null ? angleValue : [
          { text: angleValue, color: angleText },
          { text: `  ${formatWithSu(a.angleDeg2, a.angleSu2, 1)}°`, color: compareColor },
        ];
        const label = makeLabelSprite(text, {
          color: angleText, bg: angleBg, bold: true, worldHeight: bondSpan * 0.1, resolution: labelResolution,
        });
        label.position.copy(centerVec.clone().addScaledVector(outward, arcR * 1.08));
        label.userData.home = label.position.clone();
        label.userData.labelKey = a.key;
        label.userData.leaderAnchor = mid.clone();
        label.userData.leader = makeLeader(bondSpan);
        group.add(label.userData.leader);
        group.add(label);
        labelSprites.push(label);
      }
    }

    if (!opts.keepCamera || !hasFramed) frame0();
  }

  // Orient the SAME as the main view's current camera (not a fixed canned
  // angle): copy its quaternion/up and re-derive a matching distance so the
  // subject shows up rotated exactly as it currently appears in the main 3D
  // scene, re-centred on itself. `keepOrientation` keeps the mini view's own
  // rotation and only re-centres/re-zooms (the double-click re-centre);
  // `includeGhosts` fits the faint atoms too.
  function frame0({ keepOrientation = false, includeGhosts = false } = {}) {
    const frameOf = includeGhosts ? lastFrameAll : lastFrame;
    if (!frameOf) return;
    const { centroid, maxRadius } = frameOf;
    // Far enough that a sphere of maxRadius fits the narrower of the two
    // fields of view (a wide dock is limited by its height, a tall one by its
    // width), with a little margin.
    const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const dist = Math.max(2.5, (maxRadius * 1.02) / Math.sin(Math.min(halfV, halfH)));
    if (keepOrientation) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      camera.position.copy(centroid).addScaledVector(forward, -dist);
    } else if (app.camera) {
      camera.quaternion.copy(app.camera.quaternion);
      camera.up.copy(app.camera.up);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      camera.position.copy(centroid).addScaledVector(forward, -dist);
    } else {
      camera.position.copy(centroid).add(new THREE.Vector3(0.9, 0.75, 1.3).normalize().multiplyScalar(dist));
      camera.up.set(0, 1, 0);
    }
    controls.target.copy(centroid);
    controls.update();
    hasFramed = true;
  }

  function rebuild() {
    if (lastModel) setModel(lastModel, { keepCamera: true });
  }

  /** Live-update just the hull face opacity (the inspector's local slider)
   *  without rebuilding the whole scene. */
  function setFaceOpacity(opacity) {
    lastFaceOpacityOpt = opacity;
    applyFaceOpacity(faceMaterial, opacity);
  }

  /** Show/hide the bond-angle arcs and their labels. Rebuilds the scene from
   *  the last model (the arcs are baked in setModel) but keeps the camera, so
   *  flipping the toggle doesn't disturb the user's orbit/zoom. */
  function setShowAngles(show) {
    if (show === showAngles) return;
    showAngles = show;
    rebuild();
  }

  /** Show/hide the bond-length labels (the bonds themselves stay). */
  function setShowLengths(show) {
    if (show === showLengths) return;
    showLengths = show;
    rebuild();
  }

  /** The labels hidden one by one (by key); the caller owns the set. */
  function setHiddenLabels(keys) {
    hiddenLabels = keys;
    rebuild();
  }

  /** Label and arc colours (inspectorLabels.js LabelColors); rebuilds in place. */
  function setLabelColors(colors) {
    labelColors = { ...colors };
    // The view's background (inspectorLabels.js LabelColors.background): the
    // panel's own wash unless one is chosen. The canvas is transparent.
    container.style.background = colors.background ?? '';
    rebuild();
  }

  /** The colours the labels are drawn with now, defaults resolved — for a
   *  legend drawn elsewhere (the export) to match them. */
  function getLabelStyle() {
    return {
      lengthText: labelColors.valueA ?? LENGTH_TEXT,
      angleText: labelColors.valueA ?? ANGLE_TEXT,
      compareText: labelColors.valueB ?? COMPARE_TEXT,
      lengthBg: labelColors.lengthBg ? withAlpha(labelColors.lengthBg, 0.92) : LENGTH_BG,
    };
  }

  /**
   * This view as an image-export source (render/ImageExportModule.js
   * ExportSource): the export takes the renderer over — the render loop
   * pauses, labels redraw at export resolution — and hands it back.
   * @param {{ background: () => string, overlays?: Function, title?: string }} opts
   */
  function getExportSource({ background, overlays, title }) {
    return {
      renderer, scene, camera, viewEl: container, isMain: false,
      pipeline: { render: (ctx) => ctx.renderer.render(ctx.scene, ctx.camera) },
      background, overlays, title,
      begin() {
        stop();
        labelResolution = 3;
        rebuild();
        updateLights();
        // The rebuilt meshes get their world transforms only when rendered;
        // the label occlusion rays need them now, or a label behind an atom
        // would be drawn into the image although it is hidden on screen.
        scene.updateMatrixWorld(true);
        updateLabels();
      },
      end() {
        labelResolution = 1;
        rebuild();
        resize();
        start();
      },
    };
  }

  /** Callbacks: a label's × pressed (onLabelHide), a click (not a drag) on
   *  an atom of the model (onAtomClick). */
  function setHandlers(next) {
    handlers = { ...handlers, ...next };
  }

  /** A placed label's leader: a thin tube, sized like the arcs (thinner). */
  function makeLeader(bondSpan) {
    const geom = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geom.translate(0, 0.5, 0); // spans y 0..1, so it scales from its anchor
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: LEADER_COLOR }));
    mesh.userData.radius = bondSpan * 0.006;
    mesh.visible = false;
    return mesh;
  }

  const _leaderDir = new THREE.Vector3();
  const _leaderUp = new THREE.Vector3(0, 1, 0);
  function placeLeader(leader, from, to) {
    if (!leader || !from) return;
    _leaderDir.copy(to).sub(from);
    const len = _leaderDir.length();
    leader.visible = len > 1e-4;
    if (!leader.visible) return;
    leader.position.copy(from);
    leader.quaternion.setFromUnitVectors(_leaderUp, _leaderDir.multiplyScalar(1 / len));
    const r = leader.userData.radius;
    leader.scale.set(r, len, r);
  }

  // Placing labels: while on, the view does not turn; dragging a label (mouse,
  // touch or pen) moves it. The offset is in world units at the label's depth,
  // along the camera's right/up, so it follows the pointer exactly.
  let drag = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!placing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const key = pickLabel(e);
    if (key == null) return;
    const sprite = labelSprites.find((sp) => sp.userData.labelKey === key);
    if (!sprite) return;
    e.preventDefault();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const depth = Math.max(0.1, sprite.position.clone().sub(camera.position).dot(forward));
    const perPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, renderer.domElement.clientHeight);
    const start = labelOffsets.get(key) ?? { r: 0, u: 0 };
    drag = { key, id: e.pointerId, x: e.clientX, y: e.clientY, r0: start.r, u0: start.u, perPx };
    hideRemove();
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* synthetic events cannot capture */ }
    container.classList.add('pi-dragging-label');
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (placing && !drag) container.classList.toggle('pi-over-label', pickLabel(e) != null);
    if (!drag || e.pointerId !== drag.id) return;
    labelOffsets.set(drag.key, {
      r: drag.r0 + (e.clientX - drag.x) * drag.perPx,
      u: drag.u0 - (e.clientY - drag.y) * drag.perPx,
    });
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { key } = drag;
    drag = null;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    container.classList.remove('pi-dragging-label');
    handlers.onLabelMoved?.(key);
  };
  renderer.domElement.addEventListener('pointerup', endDrag);
  renderer.domElement.addEventListener('pointercancel', endDrag);

  /** Turn label placing on (labels drag, the view does not turn) or off. */
  function setPlacing(on) {
    placing = !!on;
    /** @type {any} */ (controls).enabled = !placing; // inherited from three Controls; not in the bundled types
    drag = null;
    hideRemove();
    container.classList.toggle('pi-placing', placing);
    container.classList.remove('pi-over-label', 'pi-dragging-label');
  }

  /** The placements to use (inspectorLabels.js state.offsets; kept by reference). */
  function setLabelOffsets(map) {
    labelOffsets = map ?? new Map();
  }

  // A label's hide ×: pointing at a label shows it just right of the label —
  // tapping the label does, on touch — and only the × hides the label (as on
  // the main view's measurement labels), so a stray click on a label hides
  // nothing. One button, moved to whichever label is active and kept on it
  // every frame as the view turns.
  const removeHot = document.createElement('div');
  removeHot.className = 'pi-label-hotspot';
  removeHot.hidden = true;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'pi-label-btn pi-label-remove';
  removeBtn.innerHTML = ICON_HIDE;
  removeBtn.title = 'Hide this label';
  removeBtn.setAttribute('aria-label', 'Hide this label');
  removeHot.appendChild(removeBtn);
  container.appendChild(removeHot);
  let activeLabel = null;
  let hideTimer = null;
  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = null; };
  const showRemove = (key) => { cancelHide(); activeLabel = key; placeRemoveButton(); };
  const hideRemove = () => { cancelHide(); activeLabel = null; removeHot.hidden = true; };
  // A moment's grace, so the pointer can travel from the label to its ×.
  const scheduleHide = () => { if (activeLabel != null && !hideTimer) hideTimer = setTimeout(hideRemove, 300); };

  /** A label sprite's box on the page: centre and half sizes, in px. */
  function labelScreenBox(sprite, camUp) {
    const c = toScreen(sprite.position);
    const top = toScreen(sprite.position.clone().addScaledVector(camUp, sprite.scale.y / 2));
    const halfH = Math.hypot(top.x - c.x, top.y - c.y);
    return { x: c.x, y: c.y, halfH, halfW: halfH * (sprite.scale.x / sprite.scale.y) };
  }

  /** Lay a hotspot box over a label sprite; its button sits just outside one end. */
  function placeHotspot(hot, sprite, camUp, rect) {
    const box = labelScreenBox(sprite, camUp);
    hot.hidden = false;
    hot.style.left = `${box.x - box.halfW - rect.left - container.clientLeft}px`;
    hot.style.top = `${box.y - box.halfH - rect.top - container.clientTop}px`;
    hot.style.width = `${2 * box.halfW}px`;
    hot.style.height = `${2 * box.halfH}px`;
    // The button follows the pill's height, clamped so it stays easy to hit
    // (it is also a touch target) without dwarfing a small label.
    hot.style.setProperty('--pi-label-btn-size', `${Math.min(22, Math.max(18, box.halfH * 1.5))}px`);
  }

  function placeRemoveButton() {
    const sprite = activeLabel == null ? null : labelSprites.find((s) => s.userData.labelKey === activeLabel);
    if (!sprite?.visible) { removeHot.hidden = true; return; }
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    placeHotspot(removeHot, sprite, camUp, container.getBoundingClientRect());
  }

  // While placing labels, every moved label carries a put-back ↺ just left of
  // it (the × button's look, always shown — no hover needed, so touch works
  // too; the × keeps the right side, shown as usual):
  // it drops that label's placement, so the label goes back onto its bond or
  // arc, loses its leader and is depth-tested with the geometry again.
  /** @type {Map<string, HTMLElement>} */
  const returnHots = new Map();
  function returnHotFor(key) {
    let hot = returnHots.get(key);
    if (hot) return hot;
    hot = document.createElement('div');
    hot.className = 'pi-label-hotspot';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pi-label-btn pi-label-return';
    btn.innerHTML = ICON_PUT_BACK;
    btn.title = 'Put this label back on its bond or angle';
    btn.setAttribute('aria-label', 'Put this label back');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      labelOffsets.delete(key);
      dropReturnHot(key);
      handlers.onLabelMoved?.(key);
    });
    hot.appendChild(btn);
    container.appendChild(hot);
    returnHots.set(key, hot);
    return hot;
  }
  function dropReturnHot(key) {
    returnHots.get(key)?.remove();
    returnHots.delete(key);
  }
  function placeReturnButtons() {
    if (!placing) {
      for (const key of [...returnHots.keys()]) dropReturnHot(key);
      return;
    }
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const rect = container.getBoundingClientRect();
    const shown = new Set();
    for (const sprite of labelSprites) {
      const key = sprite.userData.labelKey;
      if (key == null || !labelOffsets.has(key) || !sprite.visible) continue;
      placeHotspot(returnHotFor(key), sprite, camUp, rect);
      shown.add(key);
    }
    for (const key of [...returnHots.keys()]) if (!shown.has(key)) dropReturnHot(key);
  }

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const hit = pickLabel(e);
    if (hit != null) showRemove(hit);
    else scheduleHide();
  });
  renderer.domElement.addEventListener('pointerleave', scheduleHide);
  removeBtn.addEventListener('pointerenter', cancelHide);
  removeBtn.addEventListener('pointerleave', scheduleHide);
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = activeLabel;
    hideRemove();
    if (key != null) handlers.onLabelHide?.(key);
  });

  // A press that moves less than a few pixels and lifts quickly is a click;
  // anything else belongs to the orbit controls. Timed by the events' own
  // timestamps, not when the handlers get to run: a slow frame between them
  // (software GL, a busy main view) must not turn a click into a long press.
  let press = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    press = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    const quick = e.timeStamp - press.t < 400;
    press = null;
    if (moved > 4 || !quick) return;
    const hit = pick(e);
    // A click on a label only shows its × (the way to it on touch) — while
    // placing labels too (a press that moved was a drag, not a click).
    if (hit?.label != null) showRemove(hit.label);
    else {
      hideRemove();
      if (hit?.atom != null) handlers.onAtomClick?.(hit.atom, e);
    }
  });

  function toScreen(position) {
    const p = position.clone().project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
  }

  const pickRay = new THREE.Raycaster();
  /** What a click at this pointer position lands on: a shown label first
   *  (labels sit in front of their geometry), else an atom. Labels are tested
   *  in screen space — the pill as drawn, nearest the camera winning —
   *  because a sprite raycast missed some labels that were plainly under the
   *  pointer, and a label is a flat, camera-facing thing anyway. */
  function pickLabel(e) {
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    let label = null;
    for (const sprite of labelSprites) {
      if (!sprite.visible || !sprite.userData.labelKey) continue;
      const box = labelScreenBox(sprite, camUp);
      if (Math.abs(e.clientX - box.x) > box.halfW || Math.abs(e.clientY - box.y) > box.halfH) continue;
      const d = sprite.position.distanceTo(camera.position);
      if (!label || d < label.d) label = { key: sprite.userData.labelKey, d };
    }
    return label?.key ?? null;
  }

  function pick(e) {
    const label = pickLabel(e);
    if (label != null) return { label };
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    pickRay.setFromCamera(ndc, camera);
    const atomHit = pickRay.intersectObjects(atomMeshes, false)[0];
    if (atomHit) return { atom: atomHit.object.userData.atomIndex };
    return null;
  }

  function dispose() {
    hideRemove();
    removeHot.remove();
    for (const key of [...returnHots.keys()]) dropReturnHot(key);
    stop();
    disposeObject3D(group);
    renderer.dispose();
    controls.dispose();
    renderer.domElement.remove();
  }

  return {
    setModel, setFaceOpacity, setShowAngles, setShowLengths, setHiddenLabels, setHandlers,
    setLabelColors, getLabelStyle, getExportSource, setPlacing, setLabelOffsets,
    fit: ({ includeGhosts = false } = {}) => frame0({ keepOrientation: true, includeGhosts }), resize, start, stop, dispose, getCamera: () => camera,
    // For tests: what is drawn, with page coordinates to click.
    getLabels: () => labelSprites.map((sprite) => ({
      key: sprite.userData.labelKey, text: sprite.userData.text, visible: sprite.visible, ...toScreen(sprite.position),
      moved: labelOffsets.has(sprite.userData.labelKey), leader: !!sprite.userData.leader?.visible,
      depthTested: sprite.material.depthTest !== false,
      anchor: sprite.userData.leaderAnchor ? toScreen(sprite.userData.leaderAnchor) : null,
    })),
    getAtomScreenPositions: () => atomMeshes.map((mesh) => ({
      index: mesh.userData.atomIndex, ghost: !!lastModel?.atoms[mesh.userData.atomIndex]?.ghost,
      ...toScreen(mesh.position),
    })),
  };
}
