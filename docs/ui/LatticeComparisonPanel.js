import { latticeParameters } from '../math/index.js';
import { registerPanel, removePanel } from './panels/PanelManager.js';
import { general } from '../state/store.js';

function percentDiff(v1, v2) { return Math.abs(v2 - v1) / v1; }

// Per-popup bookkeeping (its blocks container + the live block refs), keyed
// by the popup element rather than stashed as ad-hoc properties on it.
const popupState = new WeakMap();

// Render one block's radar plot + table, comparing the main lattice against
// one overlay structure's lattice.
function renderLatticeComparisonContent(L1_matrix, L2_matrix, canvas, table, content, toggleBtn) {
  // Compute parameters and differences
  const p1 = latticeParameters(L1_matrix);
  const p2 = latticeParameters(L2_matrix);
  const keys = ["a", "b", "c", "alpha", "beta", "gamma", "volume"];
  const diffs = keys.map(k => percentDiff(p1[k], p2[k]));
  const maxDiff = Math.max(...diffs) * 1.2 || 0.1;
  const axisLabels = ["a", "b", "c", "α", "β", "γ", "V"];

  // --- Update Table ---
  let tbody = table.querySelector("tbody");
  if (!tbody) {
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
  }
  while (tbody.rows.length > 0) {
    tbody.deleteRow(0);
  }

  // Add new rows to tbody
  keys.forEach((k, i) => {
    const row = tbody.insertRow();
    const parameter = axisLabels[i];
    const v1 = p1[k].toFixed(2);
    const v2 = p2[k].toFixed(2);
    const diffPercent = (diffs[i] * 100).toFixed(2) + "%";

    [parameter, v1, v2, diffPercent].forEach(val => {
      const cell = row.insertCell();
      cell.textContent = val;
      cell.className = "lcmp-table-cell";
    });
  });

  // --- Update Canvas (Radar Plot) ---
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Canvas context not found!");
    return;
  }

  // Set canvas dimensions explicitly. The displayed box size (320x320) is a
  // constant set once via .lcmp-radar-canvas at creation (buildComparisonBlock);
  // only the backing-buffer resolution genuinely depends on the live dpi, so
  // only that stays here, re-applied on every render.
  const dpi = window.devicePixelRatio || 1;
  const displayWidth = 320;
  const displayHeight = 320;
  canvas.width = displayWidth * dpi;
  canvas.height = displayHeight * dpi;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Center and radius
  const center = { x: canvas.width / 2, y: canvas.height / 2 };
  const radius = Math.min(canvas.width, canvas.height) / 2 - 50;

  // Draw grid
  ctx.strokeStyle = "#666";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.font = `${12 * dpi}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let level = 1; level <= 5; level++) {
    const r = (radius * level) / 5;
    const tickValue = (level / 5) * maxDiff * 100;
    ctx.beginPath();
    for (let i = 0; i < keys.length; i++) {
      const angle = (i / keys.length) * 2 * Math.PI - Math.PI / 2;
      const x = center.x + Math.cos(angle) * r;
      const y = center.y + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#aaa";
    ctx.fillText(
      tickValue.toFixed(1) + "%",
      center.x + Math.cos(-Math.PI / 2) * r,
      center.y + Math.sin(-Math.PI / 2) * r
    );
  }

  // Draw axes
  ctx.strokeStyle = "#fff";
  for (let i = 0; i < keys.length; i++) {
    const angle = (i / keys.length) * 2 * Math.PI - Math.PI / 2;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    const labelX = center.x + Math.cos(angle) * (radius + 22);
    const labelY = center.y + Math.sin(angle) * (radius + 22);
    ctx.fillStyle = "#fff";
    ctx.fillText(axisLabels[i], labelX, labelY);
  }

  // Draw polygon
  ctx.beginPath();
  diffs.forEach((val, i) => {
    const angle = (i / keys.length) * 2 * Math.PI - Math.PI / 2;
    const r = (val / maxDiff) * radius;
    const x = center.x + Math.cos(angle) * r;
    const y = center.y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(9, 140, 50, 0.4)";
  ctx.fill();
  ctx.strokeStyle = "rgba(9, 140, 50, 0.9)";
  ctx.lineWidth = 4;
  ctx.stroke();
}

// One radar-plot + collapsible-table block per overlay structure, appended
// into the popup's (scrollable) blocks container.
function buildComparisonBlock(container) {
  const block = document.createElement("div");
  block.className = "lattice-comparison-block lcmp-block";

  const heading = document.createElement("div");
  heading.className = "lcmp-heading";
  block.appendChild(heading);

  const canvas = document.createElement("canvas");
  canvas.className = "lcmp-radar-canvas";
  block.appendChild(canvas);

  const collapsible = document.createElement("div");
  collapsible.className = "lcmp-collapsible";
  block.appendChild(collapsible);

  const toggleBtn = document.createElement("button");
  // Starts expanded — the comparison details are the point of this popup, so
  // hiding them by default just added an extra click most users would take anyway.
  toggleBtn.textContent = "Hide details ▲";
  toggleBtn.className = "lcmp-toggle-btn";
  collapsible.appendChild(toggleBtn);

  const content = document.createElement("div");
  content.style.display = "block";
  content.className = "lcmp-content";
  collapsible.appendChild(content);

  const table = document.createElement("table");
  table.className = "lcmp-table";
  content.appendChild(table);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Parameter", "Main", "Overlay", "% Diff"].forEach(t => {
    const th = document.createElement("th");
    th.textContent = t;
    th.className = "lcmp-table-head";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(document.createElement("tbody"));

  toggleBtn.addEventListener("click", () => {
    if (content.style.display === "none") {
      content.style.display = "block";
      toggleBtn.textContent = "Hide details ▲";
    } else {
      content.style.display = "none";
      toggleBtn.textContent = "Show details ▼";
    }
  });

  container.appendChild(block);
  return { block, heading, canvas, table, content, toggleBtn };
}

export function createLatticeComparisonPopup() {
  // Remove existing popup (if any)
  removePanel('latticeComparison');

  // Roughly centered default position (the panel window is freely draggable).
  const anchor = {
    left: Math.max(8, Math.round(window.innerWidth / 2 - 180)),
    top: Math.max(8, Math.round(window.innerHeight / 2 - 280)),
  };

  const panelWindow = registerPanel({
    id: 'latticeComparison',
    title: 'Lattice Comparison',
    lifecycle: 'persistent',
    infoMd: './data/latticeComparisonInfo.md',
    closable: true,
    persist: false,
    onClose() {
      // Closing the window also turns the comparison-panel toggle off, so
      // structure/frame changes stop re-creating the popup.
      general.comparisonActive = false;
      const cb = /** @type {HTMLInputElement|null} */ (document.getElementById('showLatticeComparison'));
      if (cb) cb.checked = false;
    },
    defaults: { docked: false, collapsed: false, anchor },
  });

  // Inner wrapper keeps the historical id so update/remove lookups work. One
  // block per overlay structure is appended into blocksContainer — the
  // wrapper's own overflow makes any number of blocks scrollable.
  const popup = document.createElement("div");
  popup.id = "latticeComparisonPopup";
  popup.className = "lcmp-popup";
  panelWindow.body.appendChild(popup);

  const blocksContainer = document.createElement("div");
  popup.appendChild(blocksContainer);

  popupState.set(popup, { blocksContainer, blockRefs: [] });

  return popup;
}

/**
 * Render one lattice-overlay block per entry in `comparisons`, stacked in the
 * (scrollable) popup — creating it first if it doesn't exist yet, and adding/
 * removing blocks in place to match the current overlay list on later calls.
 * @param {number[][]} L1_matrix Main structure's lattice.
 * @param {Array<{label: string, lattice: number[][]}>} comparisons One entry
 *   per overlaid structure.
 */
export function updateLatticeComparisonPanel(L1_matrix, comparisons) {
  let popup = document.getElementById("latticeComparisonPopup");
  if (!popup) popup = createLatticeComparisonPopup();

  const { blocksContainer: container, blockRefs: refs } = popupState.get(popup);

  while (refs.length < comparisons.length) refs.push(buildComparisonBlock(container));
  while (refs.length > comparisons.length) refs.pop().block.remove();

  comparisons.forEach((cmp, i) => {
    refs[i].heading.textContent = cmp.label;
    renderLatticeComparisonContent(L1_matrix, cmp.lattice, refs[i].canvas, refs[i].table, refs[i].content, refs[i].toggleBtn);
  });
}

/**
 * Removes the lattice comparison popup (its unified panel window).
 *  */
  export function removeLatticeComparisonPopup() {
      removePanel('latticeComparison');
  }
