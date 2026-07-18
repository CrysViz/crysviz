/**
 * MDStreamPanel.js — Live binary WebSocket streaming for CrysViz.
 *
 * Receives binary frames from example_md.py (ws://localhost:8765) and
 * renders them with minimal overhead:
 *   - First frame: full rebuild via CrysViz pipeline (sets up InstancedMesh)
 *   - Subsequent frames: direct float writes to instance matrix only
 *     (skips hashing, periodic expansion, color/radius/emissive updates, bonds)
 *
 * Binary frame layout (matches pack_frame() in example_md.py):
 *   [0]  uint32  magic    = 0x4D445631
 *   [4]  uint32  nAtoms
 *   [8]  uint32  nBonds
 *   [12] uint32  nForces
 *   [16] uint32  flags    bit0=hasBonds bit1=hasForces bit2=hasOpacity bit3=hasCell
 *   [20] uint32  step
 *   [24] float32 sim_time
 *   [28] float32[9] cell  (36 bytes, row-major)
 *   [64] payload:
 *     positions   float32[nAtoms*3]
 *     elements    uint8[nAtoms]  (padded to 4-byte boundary)
 *     bonds       uint32[nBonds*2]  (if hasBonds)
 *     bond_order  uint8[nBonds]  padded  (if hasBonds)
 *     forces      float32[nAtoms*3]  (if hasForces)
 *     opacity     float32[nAtoms]    (if hasOpacity)
 */

import { fileBrowser, structureShip, general, groups } from '../../state/store.js';
import { Structure } from '../../model/index.js';
import { StructureContainer } from '../../model/index.js';
import { Atom } from '../../model/index.js';
import { Force } from '../../model/index.js';
import { updateForces, removeForces } from '../../render/index.js';
import { updateLattice } from '../../render/index.js';
import { rebuildAtoms } from '../../render/index.js';
import { createRow, selectLastAddedRow } from '../FileBrowswerPanel.js';
import { transpose3x3, invert3x3, matVec } from '../../atomistic/math.js';
import { generateCompactTimeUUID } from '../../utils/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAGIC  = 0x4D445631;
const WS_URL = 'ws://localhost:8765';

// Atomic number Z → element symbol (indices 1..118)
const ELEMENT_BY_Z = [
  '',
  'H','He','Li','Be','B','C','N','O','F','Ne',
  'Na','Mg','Al','Si','P','S','Cl','Ar','K','Ca',
  'Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn',
  'Ga','Ge','As','Se','Br','Kr','Rb','Sr','Y','Zr',
  'Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn',
  'Sb','Te','I','Xe','Cs','Ba','La','Ce','Pr','Nd',
  'Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb',
  'Lu','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg',
  'Tl','Pb','Bi','Po','At','Rn','Fr','Ra','Ac','Th',
  'Pa','U','Np','Pu','Am','Cm','Bk','Cf','Es','Fm',
  'Md','No','Lr','Rf','Db','Sg','Bh','Hs','Mt','Ds',
  'Rg','Cn','Nh','Fl','Mc','Lv','Ts','Og',
];

// ── Module state ──────────────────────────────────────────────────────────────

let ws              = null;
let pendingFrame    = null;
let renderScheduled = false;
let liveContainer   = null;
let liveStructure   = null;
let prevNAtoms      = -1;
let prevCellKey     = '';   // detect cell changes for lattice box updates

// FPS counter
let frameCount = 0;
let fpsTime    = performance.now();
let fps        = 0;

// DOM refs set by addMDStreamPanel()
let panelElements = null;

// ── Binary frame parser ───────────────────────────────────────────────────────

function parseFrame(buffer) {
  const view = new DataView(buffer);

  if (view.getUint32(0, true) !== MAGIC) return null;

  const nAtoms  = view.getUint32(4,  true);
  const nBonds  = view.getUint32(8,  true);
  const flags   = view.getUint32(16, true);
  const step    = view.getUint32(20, true);

  const hasBonds  = !!(flags & 0x01);
  const hasForces = !!(flags & 0x02);

  // Cell (float32[9], row-major, bytes 28-63)
  const lattice = [
    [view.getFloat32(28, true), view.getFloat32(32, true), view.getFloat32(36, true)],
    [view.getFloat32(40, true), view.getFloat32(44, true), view.getFloat32(48, true)],
    [view.getFloat32(52, true), view.getFloat32(56, true), view.getFloat32(60, true)],
  ];

  let offset = 64;

  // Cartesian positions
  const cartPositions = new Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    cartPositions[i] = [
      view.getFloat32(offset,      true),
      view.getFloat32(offset + 4,  true),
      view.getFloat32(offset + 8,  true),
    ];
    offset += 12;
  }

  // Elements (uint8 atomic numbers, padded to 4-byte boundary)
  const elements = new Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    elements[i] = ELEMENT_BY_Z[view.getUint8(offset + i)] || 'X';
  }
  offset += nAtoms + (4 - (nAtoms % 4)) % 4;

  // Skip bonds (CrysViz recomputes its own)
  if (hasBonds) {
    offset += nBonds * 8;
    offset += nBonds + (4 - (nBonds % 4)) % 4;
  }

  // Forces (eV/Å, Cartesian)
  let forces = null;
  if (hasForces) {
    forces = new Array(nAtoms);
    for (let i = 0; i < nAtoms; i++) {
      forces[i] = [
        view.getFloat32(offset,      true),
        view.getFloat32(offset + 4,  true),
        view.getFloat32(offset + 8,  true),
      ];
      offset += 12;
    }
  }

  return { nAtoms, step, lattice, cartPositions, elements, forces };
}

// ── Math helpers ──────────────────────────────────────────────────────────────

// Cartesian → fractional, wrapped to [0,1)
function cartToFracWrapped(cartPositions, lattice) {
  const invL = invert3x3(transpose3x3(lattice));
  return cartPositions.map(r => {
    const f = matVec(invL, r);
    return [((f[0] % 1) + 1) % 1, ((f[1] % 1) + 1) % 1, ((f[2] % 1) + 1) % 1];
  });
}

function cellKey(lattice) {
  return lattice.flat().map(v => v.toFixed(4)).join(',');
}

// ── Fast position update (bypasses CrysViz pipeline entirely) ─────────────────
//
// After the first rebuild the InstancedMesh has N instances (one per atom,
// no periodic images). The 4×4 column-major instance matrix layout is:
//   [0  4  8  12]
//   [1  5  9  13]   ← 12,13,14 are the translation components
//   [2  6  10 14]
//   [3  7  11 15]
// Scale (atom radius) lives at 0,5,10 and was set on rebuild — untouched here.

function fastUpdatePositions(cartPositions, lattice, elements, forces) {
  const mesh = groups.atomsMesh;
  if (!mesh) return;

  const n = cartPositions.length;
  // Hiding an atom mid-stream shrinks the mesh (rebuildAtoms filters it out)
  // without changing the streamed atom count this function otherwise assumes
  // 1:1 with mesh instances — bail rather than write past/misalign the
  // now-smaller instance buffer. The next atom-count-changed frame (or any
  // full rebuild) re-syncs prevNAtoms and resumes the fast path normally.
  if (mesh.count !== n) return;
  const arr = mesh.instanceMatrix.array;

  // Direct float writes — skip color, radius, emissive, hashing, periodic expansion
  for (let i = 0; i < n; i++) {
    const off = i * 16;
    arr[off + 12] = cartPositions[i][0];
    arr[off + 13] = cartPositions[i][1];
    arr[off + 14] = cartPositions[i][2];
  }
  mesh.instanceMatrix.needsUpdate = true;

  // Keep wrapped.cart in sync so updateForces() knows where atoms are
  const wrapped = liveStructure.periodic?.wrapped;
  if (wrapped?.cart) {
    const cart = wrapped.cart;
    for (let i = 0; i < n; i++) {
      cart[i][0] = cartPositions[i][0];
      cart[i][1] = cartPositions[i][1];
      cart[i][2] = cartPositions[i][2];
    }
  }

  // Update lattice box only when cell actually changes (NVT: never; NPT: each step)
  const ck = cellKey(lattice);
  if (ck !== prevCellKey) {
    prevCellKey = ck;
    liveStructure.lattice = lattice.map(r => [...r]);
    updateLattice();
  }

  // Forces (optional — only if user has enabled the Forces toggle)
  if (forces && general.forcesActive) {
    liveStructure.forces = forces.map(v => new Force({ vector: v }));
    updateForces();
  }
}

// ── First-frame / atom-count-changed rebuild ───────────────────────────────────
//
// Calls the CrysViz pipeline once to create the InstancedMesh.
// Periodic images and bonds are disabled so the mesh has exactly N instances
// and atoms are addressed directly by index in fastUpdatePositions().

function fullRebuild(nAtoms, lattice, cartPositions, elements, forces) {
  prevNAtoms = nAtoms;

  const frac  = cartToFracWrapped(cartPositions, lattice);
  const atoms = elements.map((el, i) => new Atom({
    element:  el,
    position: [...frac[i]],
    uuid:     generateCompactTimeUUID(),
  }));
  const forceObjs = forces ? forces.map(v => new Force({ vector: [...v] })) : [];

  // Build a wrapped object directly — no runPeriodicWrapped call needed.
  // showPeriodic=false path returns exactly N atoms anyway, but computing
  // a hash over 3N floats every frame is the expensive part we skip here.
  const wrapped = {
    elements: [...elements],
    frac:     frac.map(f => [...f]),
    cart:     cartPositions.map(p => [...p]),
    srcIndex: elements.map((_, i) => i),
  };

  liveStructure = new Structure({
    elements:       [...elements],
    uniqueElements: [...new Set(elements)],
    lattice:        lattice.map(r => [...r]),
    atoms,
    forces: forceObjs,
    periodic: { hash: 'live', wrapped },
  });

  if (!liveContainer) {
    liveContainer = new StructureContainer({ fileName: 'live_md' });
    liveContainer.structures = [liveStructure];
    structureShip.container.push(liveContainer);
    const row = createRow({ name: 'live_md', traj: 1, step: 1 });
    document.querySelector('#objectTable tbody').appendChild(row);
    fileBrowser.fileData.push({ name: 'live_md', traj: 1, step: 1 });
    selectLastAddedRow();
  } else {
    liveContainer.structures[0] = liveStructure;
    fileBrowser.selectedStructure = liveStructure;
  }

  // Temporarily disable periodic images and bonds so the mesh has exactly N instances
  const savedPeriodic = general.showPeriodic;
  const savedBonds    = general.showBonds;
  general.showPeriodic = false;
  general.showBonds    = false;

  rebuildAtoms(1.0);
  // Don't call rebuildBonds — bonds are off during live streaming

  general.showPeriodic = savedPeriodic;
  general.showBonds    = savedBonds;

  // Hide bonds mesh if it exists from a previous structure
  if (groups.bondsMesh) groups.bondsMesh.visible = false;

  prevCellKey = cellKey(lattice);
  updateLattice();

  if (forces && general.forcesActive) {
    liveStructure.forces = forces.map(v => new Force({ vector: [...v] }));
    updateForces();
  } else {
    removeForces();
  }
}

// ── Main frame dispatcher ─────────────────────────────────────────────────────

function applyParsedFrame({ nAtoms, step, lattice, cartPositions, elements, forces }) {
  if (!liveStructure || prevNAtoms !== nAtoms) {
    fullRebuild(nAtoms, lattice, cartPositions, elements, forces);
  } else {
    fastUpdatePositions(cartPositions, lattice, elements, forces);
  }

  // FPS counter
  frameCount++;
  const now = performance.now();
  if (now - fpsTime >= 600) {
    fps = Math.round((frameCount * 1000) / (now - fpsTime));
    frameCount = 0;
    fpsTime = now;
    updatePanelStats(step, nAtoms, fps);
  } else {
    if (panelElements?.stepEl) panelElements.stepEl.textContent = step;
  }
}

// ── Drop-frame render scheduler ───────────────────────────────────────────────

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    const buf = pendingFrame;
    pendingFrame = null;
    if (!buf) return;
    const parsed = parseFrame(buf);
    if (parsed) applyParsedFrame(parsed);
  });
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('connected', `Connected to ${WS_URL}`);
  };

  ws.onmessage = (e) => {
    pendingFrame = e.data;   // drop-frame: always overwrite, never queue
    scheduleRender();
  };

  ws.onclose = () => {
    setStatus('disconnected', 'Disconnected');
  };

  ws.onerror = () => {
    setStatus('error', 'Cannot connect — is example_md.py running?');
  };
}

function disconnectWS() {
  if (ws) { ws.close(); ws = null; }
  pendingFrame = null;
  setStatus('disconnected', 'Disconnected');
  // Keep liveStructure/liveContainer so the last frame stays visible
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(state, message) {
  if (!panelElements) return;
  if (panelElements.statusDot) {
    panelElements.statusDot.className = `md-stream-dot md-stream-dot--${state}`;
  }
  if (panelElements.statusMsg) panelElements.statusMsg.textContent = message;
}

function updatePanelStats(step, nAtoms, fps) {
  if (!panelElements) return;
  if (panelElements.stepEl)  panelElements.stepEl.textContent  = step;
  if (panelElements.atomsEl) panelElements.atomsEl.textContent = nAtoms;
  if (panelElements.fpsEl)   panelElements.fpsEl.textContent   = `${fps} fps`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addMDStreamPanel() {
  const panel = document.getElementById('BackendCalcPanel');
  panel.innerHTML = `
    <div class="atomistic-panel">
      <div class="atomistic-source-panel">
        <div class="atomistic-source-row">
          <span class="atomistic-source-label">Live MD Stream</span>
          <span class="md-stream-dot md-stream-dot--disconnected" id="mdStreamDot"></span>
        </div>
        <div class="atomistic-source-copy" id="mdStreamMsg"
             style="font-size:11px; color:var(--text-muted, #999); margin-top:4px;">
          Not connected. Start example_md.py, then click Connect.
        </div>
      </div>

      <div class="atomistic-body">

        <div class="atomistic-card atomistic-card-compact">
          <div class="atomistic-grid atomistic-grid-3 atomistic-grid-compact">
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
              <span style="font-size:10px;color:#888;">Step</span>
              <span id="mdStreamStep" style="font-size:13px;font-weight:600;">—</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
              <span style="font-size:10px;color:#888;">Atoms</span>
              <span id="mdStreamAtoms" style="font-size:13px;font-weight:600;">—</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
              <span style="font-size:10px;color:#888;">Viewer FPS</span>
              <span id="mdStreamFps" style="font-size:13px;font-weight:600;">—</span>
            </div>
          </div>
        </div>

        <div class="atomistic-button-row atomistic-button-row-compact">
          <button type="button" class="calcButton" id="mdStreamConnectBtn">Connect</button>
          <button type="button" class="calcButton" id="mdStreamDisconnectBtn">Disconnect</button>
        </div>

        <div class="atomistic-card atomistic-card-compact"
             style="font-size:11px;color:#888;line-height:1.8;">
          <div><code>python example_md.py</code> &nbsp;→ live preview</div>
          <div><code>python example_md.py sim</code> &nbsp;→ write trajectory</div>
          <div><code>python example_md.py play</code> &nbsp;→ stream at 30 fps</div>
          <div style="margin-top:6px;">Forces: enable via the Forces toggle in the main panel.</div>
        </div>

      </div>
    </div>

    <style>
      .md-stream-dot {
        width:10px; height:10px; border-radius:50%;
        display:inline-block; flex-shrink:0; vertical-align:middle;
      }
      .md-stream-dot--connected    { background:#4caf50; box-shadow:0 0 6px #4caf5088; }
      .md-stream-dot--disconnected { background:#555; }
      .md-stream-dot--error        { background:#f44336; box-shadow:0 0 6px #f4433688; }
    </style>
  `;

  panelElements = {
    statusDot: panel.querySelector('#mdStreamDot'),
    statusMsg:  panel.querySelector('#mdStreamMsg'),
    stepEl:     panel.querySelector('#mdStreamStep'),
    atomsEl:    panel.querySelector('#mdStreamAtoms'),
    fpsEl:      panel.querySelector('#mdStreamFps'),
  };

  panel.querySelector('#mdStreamConnectBtn').addEventListener('click', connectWS);
  panel.querySelector('#mdStreamDisconnectBtn').addEventListener('click', disconnectWS);
}

export function removeMDStreamPanel() {
  disconnectWS();
  liveStructure = null;
  liveContainer = null;
  prevNAtoms    = -1;
  prevCellKey   = '';
  const panel = document.getElementById('BackendCalcPanel');
  if (panel) panel.innerHTML = '';
  panelElements = null;
}
