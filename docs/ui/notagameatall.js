// Interactive screen-space projection overlay for the 3D view.
//
// Every atoms-mesh instance is projected through the live camera into view
// pixels each frame (centre + on-screen disc radius). A probe at the bottom
// edge of the view emits pulses straight up; a pulse that reaches an
// instance's projected disc zero-scales that instance and its bond halves in
// the instanced meshes — renders nothing, no raycast hits, the same trick the
// Atoms-tab per-element visibility uses. The camera drifts slowly about the
// screen-up axis while the overlay runs and instances emit drops back down
// the view; the probe has a small retry budget. The run ends when no live
// instance is left or the budget is spent.
//
// Not a menu feature: toggled by the Shift+4+2 chord (physical key codes),
// wired in initProjectionOverlay() and registered from crystal-viewer.js next
// to the keyboard shortcuts. Escape also ends it. Nothing is persisted.
//
// Fully reversible and model-free: the instance matrices of the atoms and
// bonds meshes are snapshotted on start and written back verbatim on stop;
// the camera pose, the TrackballControls enabled flag and app.cameraPan are
// restored the same way. Nothing in fileBrowser.selectedStructure is ever
// touched, so a structure/frame rebuild mid-run simply ends the overlay —
// the fresh meshes already hold the true matrices.
//
// Everything the overlay draws retries on its own 2D canvas over #view (see
// styles/notagameatall.css); the three.js scene only ever sees the
// zero-scaled instances and the drifting camera. Probe/drop colours come
// from the theme tokens via getComputedStyle; the text/pulse ink is chosen
// against the SCENE background's luminance (see readContrast), since the
// overlay sits on the 3D view, not on a panel.

import * as THREE from '../external/three/three.module.js';
import { app, groups, fileBrowser, general } from '../state/store.js';
import { requestRender } from '../render/AnimateModule.js';

// ---- tuning ---------------------------------------------------------------

const PROBE_W = 40;            // CSS px
const PROBE_H = 20;
const PROBE_MARGIN = 26;       // gap between the probe's base and the view's bottom edge
const PROBE_SPEED = 440;       // px/s
const PULSE_SPEED = 820;     // px/s, upwards
const PULSE_W = 3;
const PULSE_H = 10;
const MAX_PULSES = 3;
const EMIT_COOLDOWN = 0.18;   // s
const DROP_W = 4;
const DROP_H = 10;
const RETRIES = 3;
const GRACE_S = 1.4;         // grace period after being hit
const DRIFT_RAD_PER_S = 0.22; // the camera's slow drift about the screen-up axis
const TALLY_PER_INSTANCE = 10;
const RETRY_BONUS = 50;        // per remaining life on a win
const OUTCOME_HOLD_S = 3.0;   // how long the end-of-run text stays up before auto-stop
const INTRO_HOLD_S = 3.0;

// ---- on-screen copy -------------------------------------------------------

const COPY = {
  note: 'A wild SPACE INVADERS appeared! ← → move · Space fires · Esc or Shift+4+2 to exit',
  title: 'SPACE INVADERS',
  intro: '← → move · Space fires · Esc quits',
  tally: 'SCORE',
  tallyLower: 'score',
  left: 'ATOMS',
  win: 'CRYSTAL CLEARED',
  winSub: 'symmetry has left the building',
  lose: 'GAME OVER',
  loseSub: 'the lattice endures',
};

// ---- state ----------------------------------------------------------------

/** @type {any} */
const S = {
  active: false,
  view: null,
  canvas: null,
  ctx: null,
  banner: null,
  raf: 0,
  lastT: 0,
  elapsed: 0,
  w: 0, h: 0, dpr: 1,
  probe: { x: 0 },
  keys: { left: false, right: false, emit: false },
  emitCooldown: 0,
  dropTimer: 0,
  pulses: /** @type {{x:number,y:number,py:number}[]} */ ([]),
  drops: /** @type {{x:number,y:number}[]} */ ([]),
  particles: /** @type {{x:number,y:number,vx:number,vy:number,life:number,max:number,color:string,size:number}[]} */ ([]),
  // Per atoms-mesh instance: alive flag + this frame's screen-space disc.
  alive: /** @type {Uint8Array|null} */ (null),
  sx: /** @type {Float32Array|null} */ (null),
  sy: /** @type {Float32Array|null} */ (null),
  sr: /** @type {Float32Array|null} */ (null),
  aliveCount: 0,
  totalCount: 0,
  tally: 0,
  retries: RETRIES,
  graceUntil: 0,
  outcome: /** @type {'win'|'lose'|null} */ (null),
  outcomeAt: 0,
  atomsMesh: null,
  bondsMesh: null,
  atomsBackup: /** @type {Float32Array|null} */ (null),
  bondsBackup: /** @type {Float32Array|null} */ (null),
  cameraBackup: null,
  controlsWereEnabled: true,
  colors: { probe: '', drop: '', ink: '', paper: '' },
  font: '',
};

// Scratch objects for the per-frame projection (no per-instance allocation).
const _pos = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _color = new THREE.Color();

// ---- overlay DOM ----------------------------------------------------------

function ensureOverlay() {
  if (S.canvas) return true;
  const view = document.getElementById('view');
  if (!view) return false;
  S.view = view;

  const canvas = document.createElement('canvas');
  canvas.className = 'cv-proj-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  view.appendChild(canvas);
  S.canvas = canvas;
  S.ctx = canvas.getContext('2d');

  // Same amber banner shell as the other hidden modes (warningBanners.css),
  // in its own stacking slot below Disco's.
  const banner = document.createElement('div');
  banner.className = 'cv-warning-banner cv-proj-overlay-note';
  banner.textContent = COPY.note;
  view.appendChild(banner);
  S.banner = banner;
  return true;
}

function readTheme() {
  const cs = getComputedStyle(S.view);
  const tok = (name) => cs.getPropertyValue(name).trim() || cs.color;
  S.colors.probe = tok('--ok-bright');
  S.colors.drop = tok('--danger-bright');
  S.font = cs.getPropertyValue('--font-mono').trim() || cs.fontFamily;
  readContrast();
}

/** The HUD sits on the 3D scene, not on a panel, so its text colour follows
 *  the SCENE background (theme default, or whatever the background picker
 *  set) rather than the panel's --fg tokens: near-white ink on a dark scene,
 *  near-black on a light one, with the opposite shade as a thin halo so it
 *  stays legible across the atoms themselves. Cheap; re-read every frame so
 *  a theme/background switch mid-run is picked up. */
function readContrast() {
  const bg = app.scene?.background;
  let lum = 1;
  if (bg?.isColor) {
    lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b; // linear-light, hence the low threshold below
  } else if (general.defaultBackgroundColor != null) {
    _color.set(general.defaultBackgroundColor);
    lum = 0.2126 * _color.r + 0.7152 * _color.g + 0.0722 * _color.b;
  }
  const dark = lum < 0.18;
  const inkV = dark ? 245 : 18;
  const paperV = dark ? 18 : 245;
  S.colors.ink = `rgb(${inkV} ${inkV} ${inkV} / 0.95)`;
  S.colors.paper = `rgb(${paperV} ${paperV} ${paperV} / 0.75)`;
}

function syncCanvasSize() {
  const w = S.view.clientWidth;
  const h = S.view.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w === S.w && h === S.h && dpr === S.dpr) return;
  S.w = w; S.h = h; S.dpr = dpr;
  S.canvas.width = Math.max(1, Math.round(w * dpr));
  S.canvas.height = Math.max(1, Math.round(h * dpr));
  S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.probe.x = Math.min(Math.max(S.probe.x, PROBE_W / 2), w - PROBE_W / 2);
}

// ---- mesh bookkeeping -------------------------------------------------------

/** Zero the rotation/scale block of instance `i` in an instanceMatrix array —
 *  the translation stays so a later projection of a dead atom is still
 *  well-defined even though it never draws. */
function zeroInstance(array, i) {
  const o = i * 16;
  for (let k = 0; k < 12; k++) array[o + k] = 0;
}

function snapshotMeshes() {
  S.atomsMesh = groups.atomsMesh;
  S.bondsMesh = groups.bondsMesh;
  S.atomsBackup = Float32Array.from(S.atomsMesh.instanceMatrix.array);
  S.bondsBackup = S.bondsMesh?.instanceMatrix ? Float32Array.from(S.bondsMesh.instanceMatrix.array) : null;

  const n = S.atomsMesh.count;
  S.alive = new Uint8Array(n);
  S.sx = new Float32Array(n);
  S.sy = new Float32Array(n);
  S.sr = new Float32Array(n);
  const a = S.atomsMesh.instanceMatrix.array;
  let alive = 0;
  for (let i = 0; i < n; i++) {
    // The sphere matrices are pure scale+translate (SphereGeometry radius 1),
    // so m[0] IS the radius; a zero-scaled instance is already invisible
    // (hidden element, hide mode) and never a target.
    if (a[i * 16] > 1e-6) { S.alive[i] = 1; alive++; }
  }
  S.aliveCount = alive;
  S.totalCount = alive;
}

function restoreMeshes() {
  // Only write back into the very meshes we snapshotted — a rebuild mid-run
  // replaced them with fresh ones that already carry the true matrices.
  if (S.atomsMesh && groups.atomsMesh === S.atomsMesh && S.atomsBackup
      && S.atomsMesh.instanceMatrix.array.length === S.atomsBackup.length) {
    S.atomsMesh.instanceMatrix.array.set(S.atomsBackup);
    S.atomsMesh.instanceMatrix.needsUpdate = true;
  }
  if (S.bondsMesh && groups.bondsMesh === S.bondsMesh && S.bondsBackup
      && S.bondsMesh.instanceMatrix.array.length === S.bondsBackup.length) {
    S.bondsMesh.instanceMatrix.array.set(S.bondsBackup);
    S.bondsMesh.instanceMatrix.needsUpdate = true;
  }
  S.atomsMesh = null;
  S.bondsMesh = null;
  S.atomsBackup = null;
  S.bondsBackup = null;
}

function meshesStillOurs() {
  return S.atomsMesh && groups.atomsMesh === S.atomsMesh
    && S.atomsMesh.instanceMatrix.array.length === S.alive.length * 16;
}

/** Kill atom instance `i`: zero its sphere and every bond half that ends on
 *  it (structure.bondMapping is keyed by atoms-mesh instance index, the same
 *  map DiscoModule recolours through), and burst some particles. */
function retireInstance(i) {
  if (!S.alive[i]) return;
  S.alive[i] = 0;
  S.aliveCount--;
  S.tally += TALLY_PER_INSTANCE;

  const mesh = S.atomsMesh;
  zeroInstance(mesh.instanceMatrix.array, i);
  mesh.instanceMatrix.needsUpdate = true;

  const bonds = S.bondsMesh;
  const halves = fileBrowser.selectedStructure?.bondMapping?.[i];
  if (bonds?.instanceMatrix && halves && groups.bondsMesh === bonds) {
    const b = bonds.instanceMatrix.array;
    for (const h of halves) {
      if (Number.isInteger(h) && (h + 1) * 16 <= b.length) zeroInstance(b, h);
    }
    bonds.instanceMatrix.needsUpdate = true;
  }

  let color = S.colors.ink;
  if (mesh.instanceColor) {
    mesh.getColorAt(i, _color);
    color = `#${_color.getHexString()}`;
  }
  spawnDebris(S.sx[i], S.sy[i], Math.max(3, S.sr[i]), color);
}

// ---- projection -------------------------------------------------------------

/** Refresh the screen-space disc (centre + radius, CSS px) of every live
 *  atom instance from the current camera. */
function projectTargets() {
  const cam = app.camera;
  const mesh = S.atomsMesh;
  cam.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  _right.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  const a = mesh.instanceMatrix.array;
  const halfW = S.w / 2;
  const halfH = S.h / 2;
  for (let i = 0; i < S.alive.length; i++) {
    if (!S.alive[i]) continue;
    const o = i * 16;
    const r = a[o];
    _pos.set(a[o + 12], a[o + 13], a[o + 14]).applyMatrix4(mesh.matrixWorld);
    _edge.copy(_pos).addScaledVector(_right, r);
    _pos.project(cam);
    _edge.project(cam);
    const x = (_pos.x + 1) * halfW;
    const y = (1 - _pos.y) * halfH;
    S.sx[i] = x;
    S.sy[i] = y;
    S.sr[i] = Math.hypot((_edge.x - _pos.x) * halfW, (_edge.y - _pos.y) * halfH);
  }
}

// ---- camera drift -----------------------------------------------------------

function snapshotCamera() {
  const cam = app.camera;
  S.cameraBackup = {
    position: cam.position.clone(),
    quaternion: cam.quaternion.clone(),
    up: cam.up.clone(),
    zoom: cam.zoom,
    target: app.controls?.target?.clone() ?? null,
    pan: { ...app.cameraPan },
  };
}

function restoreCamera() {
  const b = S.cameraBackup;
  if (!b) return;
  const cam = app.camera;
  cam.position.copy(b.position);
  cam.quaternion.copy(b.quaternion);
  cam.up.copy(b.up);
  cam.zoom = b.zoom;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  if (b.target && app.controls?.target) app.controls.target.copy(b.target);
  app.cameraPan.x = b.pan.x;
  app.cameraPan.y = b.pan.y;
  S.cameraBackup = null;
}

/** Rotate the camera about the structure centre around the screen's up axis
 *  — same construction as AnimateModule's auto-rotation, so the pan-offset
 *  bookkeeping there keeps working. */
function drift(dt) {
  const cam = app.camera;
  const target = app.controls?.target;
  if (!target) return;
  _up.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
  _q.setFromAxisAngle(_up, DRIFT_RAD_PER_S * dt);
  cam.position.sub(target).applyQuaternion(_q).add(target);
  cam.quaternion.premultiply(_q);
  cam.updateMatrixWorld(true);
}

// ---- overlay objects -------------------------------------------------------------

function spawnDebris(x, y, r, color) {
  const n = Math.min(26, 8 + Math.round(r));
  for (let k = 0; k < n; k++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 60 + Math.random() * 180;
    S.particles.push({
      x, y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      life: 0,
      max: 0.45 + Math.random() * 0.4,
      color,
      size: 2 + Math.random() * 2,
    });
  }
}

function emit() {
  if (S.outcome || S.emitCooldown > 0 || S.pulses.length >= MAX_PULSES) return;
  const y = S.h - PROBE_MARGIN - PROBE_H - 2;
  S.pulses.push({ x: S.probe.x, y, py: y });
  S.emitCooldown = EMIT_COOLDOWN;
}

function emitDrop() {
  if (!S.aliveCount) return;
  // Pick a random live atom (uniform over the survivors).
  let pick = Math.floor(Math.random() * S.aliveCount);
  for (let i = 0; i < S.alive.length; i++) {
    if (!S.alive[i]) continue;
    if (pick-- === 0) {
      if (S.sy[i] < S.h - PROBE_MARGIN - PROBE_H) S.drops.push({ x: S.sx[i], y: S.sy[i] + S.sr[i] });
      return;
    }
  }
}

function probeRect() {
  return {
    x: S.probe.x - PROBE_W / 2,
    y: S.h - PROBE_MARGIN - PROBE_H,
    w: PROBE_W,
    h: PROBE_H,
  };
}

function spendRetry() {
  S.retries--;
  S.graceUntil = S.elapsed + GRACE_S;
  const r = probeRect();
  spawnDebris(r.x + r.w / 2, r.y + r.h / 2, 12, S.colors.probe);
  S.drops.length = 0;
  if (S.retries <= 0) endRun('lose');
}

function endRun(outcome) {
  if (S.outcome) return;
  S.outcome = outcome;
  S.outcomeAt = S.elapsed;
  if (outcome === 'win') S.tally += S.retries * RETRY_BONUS;
  S.pulses.length = 0;
  S.drops.length = 0;
}

// ---- update ---------------------------------------------------------------------

function update(dt) {
  const fraction = S.totalCount ? S.aliveCount / S.totalCount : 0;

  if (!S.outcome) {
    // Probe
    const dir = (S.keys.right ? 1 : 0) - (S.keys.left ? 1 : 0);
    S.probe.x = Math.min(Math.max(S.probe.x + dir * PROBE_SPEED * dt, PROBE_W / 2), S.w - PROBE_W / 2);
    S.emitCooldown = Math.max(0, S.emitCooldown - dt);
    if (S.keys.emit) emit();

    // Targets
    drift(dt);
    projectTargets();

    // Drops: more often, and faster, as the live set thins out.
    S.dropTimer -= dt;
    if (S.dropTimer <= 0) {
      emitDrop();
      S.dropTimer = 0.45 + 1.3 * fraction + Math.random() * 0.4;
    }
  }

  // Pulses — swept vertical segment vs. the projected discs; the first atom
  // a pulse meets is the lowest one on screen it overlaps.
  for (let b = S.pulses.length - 1; b >= 0; b--) {
    const bl = S.pulses[b];
    bl.py = bl.y;
    bl.y -= PULSE_SPEED * dt;
    if (bl.y < -PULSE_H) { S.pulses.splice(b, 1); continue; }
    let hit = -1;
    let hitY = -Infinity;
    for (let i = 0; i < S.alive.length; i++) {
      if (!S.alive[i]) continue;
      const r = S.sr[i] + PULSE_W;
      const dx = S.sx[i] - bl.x;
      if (dx > r || dx < -r) continue;
      // Closest point on the swept segment [y, py] to the disc centre.
      const cy = Math.min(Math.max(S.sy[i], bl.y), bl.py);
      const dy = S.sy[i] - cy;
      if (dx * dx + dy * dy <= r * r && S.sy[i] > hitY) { hit = i; hitY = S.sy[i]; }
    }
    if (hit >= 0) {
      retireInstance(hit);
      S.pulses.splice(b, 1);
      if (S.aliveCount === 0) endRun('win');
    }
  }

  // Drops
  const probe = probeRect();
  const dropSpeed = 200 + 220 * (1 - fraction);
  for (let k = S.drops.length - 1; k >= 0; k--) {
    const bm = S.drops[k];
    bm.y += dropSpeed * dt;
    if (bm.y > S.h) { S.drops.splice(k, 1); continue; }
    if (!S.outcome && S.elapsed >= S.graceUntil
        && bm.x + DROP_W / 2 >= probe.x && bm.x - DROP_W / 2 <= probe.x + probe.w
        && bm.y + DROP_H / 2 >= probe.y && bm.y - DROP_H / 2 <= probe.y + probe.h) {
      S.drops.splice(k, 1);
      spendRetry();
    }
  }

  // Particles
  for (let p = S.particles.length - 1; p >= 0; p--) {
    const pt = S.particles[p];
    pt.life += dt;
    if (pt.life >= pt.max) { S.particles.splice(p, 1); continue; }
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += 160 * dt;
  }

  if (S.outcome && S.elapsed - S.outcomeAt >= OUTCOME_HOLD_S && !S.particles.length) {
    stopProjectionOverlay();
  }
}

// ---- draw -------------------------------------------------------------------------

/** Probe glyph (base slab, upper deck, stem) with its bottom-left corner at
 *  (x, y+h): the probe itself, and the tiny copies that count retries in
 *  the status line. Outlined in ink so the pale green
 *  reads on a light scene too. */
function drawProbeGlyph(ctx, x, y, w, h) {
  const rects = [
    [x, y + h * 0.7, w, h * 0.3],
    [x + w * 0.12, y + h * 0.42, w * 0.76, h * 0.3],
    [x + w * 0.44, y, w * 0.12, h * 0.44],
  ];
  ctx.fillStyle = S.colors.probe;
  for (const [rx, ry, rw, rh] of rects) ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = S.colors.ink;
  ctx.lineWidth = 1;
  for (const [rx, ry, rw, rh] of rects) ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
}

function drawProbe(ctx) {
  const r = probeRect();
  const blink = S.elapsed < S.graceUntil && Math.floor(S.elapsed * 12) % 2 === 0;
  if (blink || (S.outcome === 'lose')) return;
  drawProbeGlyph(ctx, r.x, r.y, r.w, r.h);
}

/** Ink text with a paper halo, so it reads over the scene AND over atoms. */
function haloText(ctx, text, x, y, px, weight = 600) {
  ctx.font = `${weight} ${px}px ${S.font}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, px / 6);
  ctx.strokeStyle = S.colors.paper;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = S.colors.ink;
  ctx.fillText(text, x, y);
}

/** One centred status line in the strip below the probe lane — the bottom
 *  corners belong to the axes gizmo (left) and the structure chip (right). */
function drawHud(ctx) {
  const y = S.h - PROBE_MARGIN / 2;
  const tally = `${COPY.tally} ${String(S.tally).padStart(4, '0')}`;
  const atoms = `${COPY.left} ${S.aliveCount}/${S.totalCount}`;
  ctx.font = `600 13px ${S.font}`;
  const tallyW = ctx.measureText(tally).width;
  const atomsW = ctx.measureText(atoms).width;
  const glyphW = 14;
  const glyphsW = RETRIES * (glyphW + 4);
  const gap = 22;
  const total = tallyW + gap + glyphsW + gap + atomsW;
  let x = S.w / 2 - total / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  haloText(ctx, tally, x, y, 13);
  x += tallyW + gap;
  for (let k = 0; k < S.retries; k++) drawProbeGlyph(ctx, x + k * (glyphW + 4), y - 5, glyphW, 10);
  x += glyphsW + gap;
  haloText(ctx, atoms, x, y, 13);
}

function drawCentreText(ctx, big, small) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  haloText(ctx, big, S.w / 2, S.h / 2 - 16, 28);
  if (small) haloText(ctx, small, S.w / 2, S.h / 2 + 16, 14, 500);
}

function draw() {
  const ctx = S.ctx;
  ctx.clearRect(0, 0, S.w, S.h);

  ctx.fillStyle = S.colors.ink;
  for (const b of S.pulses) ctx.fillRect(b.x - PULSE_W / 2, b.y - PULSE_H, PULSE_W, PULSE_H);

  ctx.strokeStyle = S.colors.ink;
  ctx.lineWidth = 1;
  for (const bm of S.drops) {
    const wiggle = Math.sin(S.elapsed * 30 + bm.y) * 1.5;
    const x = bm.x - DROP_W / 2 + wiggle;
    const y = bm.y - DROP_H / 2;
    ctx.fillStyle = S.colors.drop;
    ctx.fillRect(x, y, DROP_W, DROP_H);
    ctx.strokeRect(x + 0.5, y + 0.5, DROP_W - 1, DROP_H - 1);
  }

  for (const p of S.particles) {
    ctx.globalAlpha = 1 - p.life / p.max;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  drawProbe(ctx);
  drawHud(ctx);

  if (S.outcome === 'win') {
    drawCentreText(ctx, COPY.win, `${COPY.tallyLower} ${S.tally} · ${COPY.winSub}`);
  } else if (S.outcome === 'lose') {
    drawCentreText(ctx, COPY.lose, `${COPY.tallyLower} ${S.tally} · ${COPY.loseSub}`);
  } else if (S.elapsed < INTRO_HOLD_S) {
    ctx.globalAlpha = Math.min(1, (INTRO_HOLD_S - S.elapsed) / 0.6);
    drawCentreText(ctx, COPY.title, COPY.intro);
    ctx.globalAlpha = 1;
  }
}

// ---- loop ---------------------------------------------------------------------------

function frame(t) {
  if (!S.active) return;
  S.raf = requestAnimationFrame(frame);
  if (!meshesStillOurs()) {
    // Structure/frame rebuilt under us: the new meshes hold the true
    // matrices, so leave them alone and just pack up.
    stopProjectionOverlay({ restoreMeshes: false });
    return;
  }
  const dt = Math.min(0.05, S.lastT ? (t - S.lastT) / 1000 : 0);
  S.lastT = t;
  S.elapsed += dt;
  syncCanvasSize();
  update(dt);
  if (!S.active) return; // update() may have quit
  readContrast();
  draw();
  // The scene renders on demand: the drifting camera and the zero-scaled
  // instances need a real frame every tick while the overlay runs.
  requestRender();
}

// ---- input --------------------------------------------------------------------------

const OVERLAY_CODES = new Set(['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space', 'ArrowUp', 'KeyW', 'Escape']);

/** Capture-phase window listener so the overlay owns its keys while it runs:
 *  Space must not reach KeyboardShortcuts' Space-as-modifier tracking (or
 *  scroll the page), arrows must not reach TrackballControls, A/D must not
 *  switch its rotate/pan mode. Everything else passes through untouched. */
function onOverlayKey(event) {
  if (!S.active || !OVERLAY_CODES.has(event.code)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const down = event.type === 'keydown';
  event.preventDefault();
  event.stopPropagation();
  switch (event.code) {
    case 'ArrowLeft': case 'KeyA': S.keys.left = down; break;
    case 'ArrowRight': case 'KeyD': S.keys.right = down; break;
    case 'Space': case 'ArrowUp': case 'KeyW':
      S.keys.emit = down;
      if (down && !event.repeat) emit();
      break;
    case 'Escape':
      if (down && !event.repeat) stopProjectionOverlay();
      break;
  }
}

function releaseKeys() {
  S.keys.left = S.keys.right = S.keys.emit = false;
}

// ---- public API ---------------------------------------------------------------------

export function isProjectionOverlayActive() {
  return S.active;
}

/** Start the overlay over the current structure. No-op if already running
 *  or there is no live instance on screen. */
export function startProjectionOverlay() {
  if (S.active) return false;
  if (!groups.atomsMesh?.instanceMatrix || !app.camera || !groups.atomsMesh.count) return false;
  if (!ensureOverlay()) return false;

  snapshotMeshes();
  if (!S.aliveCount) { S.atomsBackup = null; S.bondsBackup = null; S.atomsMesh = null; S.bondsMesh = null; return false; }
  snapshotCamera();
  S.controlsWereEnabled = app.controls ? app.controls.enabled !== false : true;
  if (app.controls) app.controls.enabled = false; // the camera drifts on its own; a drag would fight it

  // A focused text field would otherwise eat the overlay's keys.
  const focused = /** @type {any} */ (document.activeElement);
  if (focused && focused !== document.body && typeof focused.blur === 'function') focused.blur();

  readTheme();
  S.w = S.h = 0; // force a size sync
  S.canvas.hidden = false;
  S.banner.style.display = 'block';
  syncCanvasSize();
  S.probe.x = S.w / 2;
  S.pulses.length = 0;
  S.drops.length = 0;
  S.particles.length = 0;
  releaseKeys();
  S.emitCooldown = 0;
  S.dropTimer = 2.0;
  S.tally = 0;
  S.retries = RETRIES;
  S.graceUntil = 0;
  S.outcome = null;
  S.elapsed = 0;
  S.lastT = 0;
  S.active = true;

  window.addEventListener('keydown', onOverlayKey, true);
  window.addEventListener('keyup', onOverlayKey, true);
  window.addEventListener('blur', releaseKeys);
  projectTargets();
  S.raf = requestAnimationFrame(frame);
  return true;
}

/** Stop the overlay and put everything back: instance matrices, camera pose,
 *  controls. `restoreMeshes:false` is for the mid-run-rebuild case, where
 *  the meshes we snapshotted are already gone. */
export function stopProjectionOverlay({ restoreMeshes: doRestore = true } = {}) {
  if (!S.active) return;
  S.active = false;
  cancelAnimationFrame(S.raf);
  S.raf = 0;
  window.removeEventListener('keydown', onOverlayKey, true);
  window.removeEventListener('keyup', onOverlayKey, true);
  window.removeEventListener('blur', releaseKeys);
  releaseKeys();

  if (doRestore) restoreMeshes();
  else { S.atomsMesh = null; S.bondsMesh = null; S.atomsBackup = null; S.bondsBackup = null; }
  restoreCamera();
  if (app.controls) app.controls.enabled = S.controlsWereEnabled;

  S.pulses.length = 0;
  S.drops.length = 0;
  S.particles.length = 0;
  if (S.ctx) S.ctx.clearRect(0, 0, S.w, S.h);
  if (S.canvas) S.canvas.hidden = true;
  if (S.banner) S.banner.style.display = 'none';
  requestRender();
}

export function toggleProjectionOverlay() {
  if (S.active) stopProjectionOverlay();
  else startProjectionOverlay();
}

/** Read-only snapshot for the browser tests. */
export function getProjectionOverlayState() {
  return {
    active: S.active,
    tally: S.tally,
    retries: S.retries,
    aliveCount: S.aliveCount,
    totalCount: S.totalCount,
    outcome: S.outcome,
  };
}

/** Test hook: park the probe under the lowest live atom on screen and emit —
 *  the hit then resolves through the normal per-frame collision path.
 *  Returns the targeted instance index, or -1. */
export function debugProbeLowestTarget() {
  if (!S.active || S.outcome) return -1;
  projectTargets();
  let best = -1;
  for (let i = 0; i < S.alive.length; i++) {
    if (S.alive[i] && (best < 0 || S.sy[i] > S.sy[best])) best = i;
  }
  if (best < 0) return -1;
  S.probe.x = Math.min(Math.max(S.sx[best], PROBE_W / 2), S.w - PROBE_W / 2);
  S.emitCooldown = 0;
  S.pulses.length = 0;
  emit();
  return best;
}

// ---- trigger: Shift+4+2 -------------------------------------------------------------

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Wire the chord. Physical keys (event.code), so it is the same two keys
 *  on every layout even though Shift+4 / Shift+2 type different glyphs on
 *  US, German and Swedish keyboards. Both digits must be down together with
 *  Shift; the press that completes the chord toggles, with the usual
 *  key-repeat and lost-keyup (blur) guards. */
export function initProjectionOverlay() {
  const digitsDown = { Digit2: false, Digit4: false };
  window.addEventListener('keydown', (event) => {
    if (!(event.code in digitsDown)) return;
    if (isEditableTarget(event.target)) return;
    digitsDown[event.code] = true;
    if (event.repeat || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (digitsDown.Digit2 && digitsDown.Digit4) {
      event.preventDefault();
      toggleProjectionOverlay();
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.code in digitsDown) digitsDown[event.code] = false;
  });
  window.addEventListener('blur', () => { digitsDown.Digit2 = false; digitsDown.Digit4 = false; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { digitsDown.Digit2 = false; digitsDown.Digit4 = false; }
  });
}
