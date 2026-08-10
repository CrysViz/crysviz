// Standalone mini 3D viewport for PolyhedronInspector.js: its own scene,
// camera, WebGL renderer and TrackballControls (same orbit library the main
// viewer uses — see ui/WindowAndSceneControls.js), rendering just ONE
// polyhedron with bond-length and bond-angle labels drawn as real, depth-
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

const FALLBACK_COLOR = 0x999999;
const ANGLE_ACCENT = 0xffcc44; // arc + angle-label accent
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
function makeLabelSprite(text, { color = '#fff', bg = 'rgba(0,0,0,0.72)', bold = false, worldHeight = 0.3 } = {}) {
  const fontPx = 56;
  const font = `${bold ? 700 : 500} ${fontPx}px monospace`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const textWidth = ctx.measureText(text).width;
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

  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.03);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: true, depthWrite: false,
  }));
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(worldHeight * aspect, worldHeight, 1);
  return sprite;
}

/** A vector of length `magnitude`, perpendicular to `dir` and tilted as far
 *  toward world "up" as it can while staying perpendicular — i.e. the
 *  direction that reads as "above" a bond pointing in `dir`, not sideways
 *  off it — for pushing a label off the bond's own centreline so it doesn't
 *  render embedded inside the (opaque) cylinder mesh drawn along that line. */
function upwardOffset(dir, magnitude) {
  const worldUp = new THREE.Vector3(0, 1, 0);
  // A near-vertical bond has no meaningful perpendicular "up" — fall back to
  // world Z so the offset is still well-defined.
  const ref = Math.abs(dir.dot(worldUp)) > 0.98 ? new THREE.Vector3(0, 0, 1) : worldUp;
  return ref.clone().sub(dir.clone().multiplyScalar(dir.dot(ref))).normalize().multiplyScalar(magnitude);
}

/** A short two-tone cylinder from `a` (colour ca) to `b` (colour cb) — the
 *  half-and-half bond look the main viewer uses. */
function makeBond(a, b, ca, cb, radius) {
  const g = new THREE.Group();
  const mid = a.clone().lerp(b, 0.5);
  const half = a.distanceTo(b) / 2;
  const dir = b.clone().sub(a).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  for (const [from, to, color] of [[a, mid, ca], [mid, b, cb]]) {
    const geom = new THREE.CylinderGeometry(radius, radius, half, 16, 1);
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
  // setDetail's `keepCamera` option skip re-framing on a pure colour refresh
  // (no selection/geometry change) instead of snapping the user's own
  // orbit/zoom in this mini viewport back to the auto-framed view every time.
  let hasFramed = false;

  let running = false;
  let rafId = null;
  function frame() {
    if (!running) return;
    controls.update();
    keyLight.position.copy(camera.position).add(
      new THREE.Vector3(3, 4, 3).applyQuaternion(camera.quaternion),
    );
    keyLight.target.position.copy(controls.target);
    // Hide labels actually blocked (by an atom, a bond, or the hull) from the
    // current camera angle — a real raycast rather than an angle-from-centre
    // heuristic, since the latter wrongly flags labels as "far side" whenever
    // the polyhedron is viewed anywhere near one of its own vertices (e.g. a
    // tetrahedron's classic three-legs-toward-camera framing has its three
    // visible bonds sitting more than 90° from the view axis, well past any
    // fixed angular cutoff, despite nothing actually occluding them).
    for (const sprite of labelSprites) {
      const toLabel = sprite.position.clone().sub(camera.position);
      const dist = toLabel.length();
      labelRay.set(camera.position, toLabel.normalize());
      labelRay.far = dist - 0.01;
      sprite.visible = labelRay.intersectObjects(occluders, true).length === 0;
    }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
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

  /** @param {ReturnType<typeof import('../../render/PolyhedraAnalysisModule.js').computePolyhedronDetail>} detail
   *  @param {{faceOpacity?: number, keepCamera?: boolean}} [opts] local opacity
   *   override (0-1) for the polyhedron face, independent of the main
   *   structure's setting; `keepCamera` skips the auto-framing step below so a
   *   pure colour refresh doesn't disturb the user's own orbit/zoom (ignored
   *   until the camera has been framed at least once). */
  function setDetail(detail, opts = {}) {
    scene.remove(group);
    disposeObject3D(group);
    group = new THREE.Group();
    scene.add(group);
    faceMaterial = null;
    occluders = [];
    labelSprites = [];
    if (!detail) { hasFramed = false; return; }

    const { centerCart, centerElement, centerColor, centerRadius, vertices, angles, faceColor, faceOpacity, edgeColor } = detail;
    const centerVec = centerCart ? new THREE.Vector3(...centerCart) : null;
    const vertexVecs = vertices.map((v) => new THREE.Vector3(...v.pos));

    const allPoints = centerVec ? [centerVec, ...vertexVecs] : vertexVecs;
    const centroid = allPoints.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / allPoints.length);
    const maxRadius = allPoints.reduce((m, p) => Math.max(m, p.distanceTo(centroid)), 0.5);
    const minBond = centerVec
      ? vertices.reduce((m, v) => Math.min(m, v.bondLength ?? Infinity), Infinity)
      : maxRadius;
    const bondSpan = Number.isFinite(minBond) ? minBond : maxRadius;

    // Keep the atoms ball-and-stick sized (so bonds/angles stay visible) while
    // preserving the REAL relative sizes + colours: shrink every rendered
    // radius by one common factor so the largest sphere is ~0.34× the shortest
    // bond, then never smaller than a floor so tiny-radius species still show.
    const rawRadii = [
      ...(centerRadius != null ? [centerRadius] : []),
      ...vertices.map((v) => v.radius),
    ];
    const maxRaw = Math.max(0.001, ...rawRadii);
    const shrink = Math.min(1, (bondSpan * 0.34) / maxRaw);
    const floor = bondSpan * 0.06;
    const sphereFor = (r) => Math.max(floor, (r ?? maxRaw) * shrink);

    const sphereGeom = new THREE.SphereGeometry(1, 24, 18);
    const bondRadius = bondSpan * 0.045;

    if (centerVec) {
      const mesh = new THREE.Mesh(sphereGeom, atomMaterial(resolveColor(centerColor, centerElement)));
      mesh.position.copy(centerVec);
      mesh.scale.setScalar(sphereFor(centerRadius));
      group.add(mesh);
      occluders.push(mesh);
    }

    vertices.forEach((v, i) => {
      const vVec = vertexVecs[i];
      const vColor = resolveColor(v.color, v.element);
      const mesh = new THREE.Mesh(sphereGeom, atomMaterial(vColor));
      mesh.position.copy(vVec);
      mesh.scale.setScalar(sphereFor(v.radius));
      group.add(mesh);
      occluders.push(mesh);

      if (centerVec) {
        // Prefer the bond's OWN rendered half-colours (length/category/user-
        // override colouring can differ from the endpoint atoms' own colours)
        // and fall back to the endpoint atom colour when no matching bond was
        // found (e.g. bonds currently hidden).
        const nearColor = v.bondColorNear != null ? resolveColor(v.bondColorNear, centerElement) : resolveColor(centerColor, centerElement);
        const farColor = v.bondColorFar != null ? resolveColor(v.bondColorFar, v.element) : vColor;
        const bond = makeBond(centerVec, vVec, nearColor, farColor, bondRadius);
        group.add(bond);
        occluders.push(bond);
        if (v.bondLength != null) {
          const label = makeLabelSprite(`${v.bondLength.toFixed(3)} Å`, { bold: true, worldHeight: bondSpan * 0.11 });
          // Toward the vertex (not the exact midpoint) so bond labels clear the
          // angle-arc cluster that gathers near the centre — then nudged
          // above the bond's own centreline, or the label renders embedded
          // in the (opaque) bond cylinder instead of sitting above it.
          const bondDir = vVec.clone().sub(centerVec).normalize();
          const above = upwardOffset(bondDir, bondRadius * 2.6);
          label.position.copy(centerVec.clone().lerp(vVec, 0.62)).add(above);
          group.add(label);
          labelSprites.push(label);
        }
      }
    });

    // Convex hull: translucent faces + edges styled like the main view's
    // polyhedron (also the only geometry for cages, which have no centre bonds).
    // Face material matches PolyhedraModule.renderPolyhedra's own params
    // (metalness 0 / roughness 1) rather than the atom/bond preset — that's
    // what the main view's polyhedra actually use.
    if (vertices.length >= 4) {
      try {
        const hullGeom = new ConvexGeometry(vertexVecs);
        const edges = new THREE.EdgesGeometry(hullGeom, 15);
        group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: edgeColor ?? 0x222222, transparent: true, opacity: 0.6 })));
        faceMaterial = new THREE.MeshStandardMaterial({
          color: faceColor ?? 0x3388ff, side: THREE.DoubleSide, metalness: 0, roughness: 1,
        });
        applyFaceOpacity(faceMaterial, opts.faceOpacity ?? faceOpacity ?? 0.4);
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

    // Angle indicators: an arc between the two bonds + the value on it, for the
    // angles the distortion metric is defined over (all pairs for CN4, cis
    // pairs for CN6). Trans (~180°) pairs are omitted — a near-constant 180°
    // on every axis would just clutter the view.
    if (centerVec) {
      // A bit bigger than "just clear of the centre atom sphere" — pushes the
      // arc (and the label riding on it) further out so neither reads as
      // overlapping the centre atom from any orientation.
      const arcR = bondSpan * 0.4;
      const arcTubeRadius = bondSpan * 0.014;
      for (const a of angles) {
        if (a.kind === 'trans') continue;
        const d1 = vertexVecs[a.i].clone().sub(centerVec).normalize();
        const d2 = vertexVecs[a.j].clone().sub(centerVec).normalize();
        const pts = arcPoints(centerVec, d1, d2, arcR);
        if (pts.length) {
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
          group.add(new THREE.Mesh(arcTubeGeom, new THREE.MeshBasicMaterial({ color: ANGLE_ACCENT, depthWrite: false })));
          // Sit right on the arc itself (a hair outside it) rather than pushed
          // out toward the hull — depth-testing (not spatial offset) is what
          // keeps this legible now, and a label glued to its own arc is much
          // easier to attribute at a glance than one floating further out.
          const mid = pts[Math.floor(pts.length / 2)];
          const outward = mid.clone().sub(centerVec).normalize();
          const label = makeLabelSprite(`${a.angleDeg.toFixed(1)}°`, {
            color: '#1a1300', bg: 'rgba(255,204,68,0.92)', bold: true, worldHeight: bondSpan * 0.1,
          });
          label.position.copy(centerVec.clone().addScaledVector(outward, arcR * 1.08));
          group.add(label);
          labelSprites.push(label);
        }
      }
    }

    // Orient the SAME as the main view's current camera (not a fixed canned
    // angle): copy its quaternion/up and re-derive a matching distance so the
    // selected polyhedron shows up rotated exactly as it currently appears in
    // the main 3D scene, re-centred on the polyhedron itself. Skipped on a
    // pure colour refresh (keepCamera) once already framed, so recolouring
    // doesn't snap the user's own orbit/zoom back to this auto-framed view.
    if (!opts.keepCamera || !hasFramed) {
      const dist = Math.max(2.5, maxRadius * 3.0);
      if (app.camera) {
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
  }

  /** Live-update just the polyhedron face opacity (the inspector's local
   *  slider) without rebuilding the whole scene. */
  function setFaceOpacity(opacity) {
    applyFaceOpacity(faceMaterial, opacity);
  }

  function dispose() {
    stop();
    disposeObject3D(group);
    renderer.dispose();
    controls.dispose();
    renderer.domElement.remove();
  }

  return { setDetail, setFaceOpacity, resize, start, stop, dispose, getCamera: () => camera };
}
