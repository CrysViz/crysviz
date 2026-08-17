// Polyhedra volume histogram: the distribution of convex-hull volumes (Å³)
// across the structure's coordination polyhedra, one bar series per polyhedron
// category (BaO12, TiO6, ...). Built on the SAME pipeline as
// PolyhedraConnectivityHistogram.js — the shared Plotly helper
// (histogramPlotly.js), data pushed from polyhedraAnalysisHub.js on every
// 'crysviz:polyhedra-rebuilt' — plus a bin-width slider (volumes span a wide
// range) and a drill-down list of individual polyhedra. Clicking a bar or a
// list row highlights the polyhedra it represents in the 3D view (click again
// to clear); unlike the bond/connectivity charts, the highlight targets the
// POLYHEDRA themselves (highlightPolyhedraIn3D), not atoms or bonds.
//
// One representative per physical polyhedron is plotted (periodic-image copies
// share a volume — see computePolyhedraVolumes), and the highlight expands each
// back to all its copies when "Link periodic copies" is on.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/SideDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
  togglePlotTheme,
} from './histogramPlotly.js';
import { highlightPolyhedraIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { subscribePolyhedraAnalysis } from './polyhedraAnalysisHub.js';

const PANEL_ID = 'polyhedraVolumeHistogram';
const PLOT_ID = 'polyhedraVolumePlot';
const HOVER_LIST_CAP = 8; // longest a bin's hover list gets before "+N more"

let volumes = []; // latest computePolyhedraVolumes() rows
let view = null;

subscribePolyhedraAnalysis((data) => {
  volumes = data.volumes ?? [];
  view?.redraw();
});

/** Bins the volumes into a grouped histogram — one series per category so
 *  different polyhedron types read apart, each bar's customdata carrying the
 *  keys of the polyhedra it covers (for the click-to-highlight). */
function computeGroups(binWidth) {
  if (!volumes.length) return [];
  const maxVol = Math.max(...volumes.map((v) => v.volume));
  const binCount = Math.max(1, Math.ceil(maxVol / binWidth) || 1);
  const xLabels = Array.from({ length: binCount }, (_, i) =>
    `${(i * binWidth).toFixed(1)}–${((i + 1) * binWidth).toFixed(1)}`);

  const cats = [...new Set(volumes.map((v) => v.catLabel ?? '—'))].sort();
  return cats.map((cat) => {
    const y = new Array(binCount).fill(0);
    const keys = Array.from({ length: binCount }, () => []);
    const lines = Array.from({ length: binCount }, () => []);
    for (const v of volumes) {
      if ((v.catLabel ?? '—') !== cat) continue;
      let idx = Math.floor(v.volume / binWidth);
      idx = Math.max(0, Math.min(binCount - 1, idx));
      y[idx] += 1;
      keys[idx].push(v.key);
      lines[idx].push(`${v.label}: ${v.volume.toFixed(2)} Å³`);
    }
    const customdata = keys.map((list) => ({ keys: list }));
    const hovertext = lines.map((list, i) => {
      if (!list.length) return `${xLabels[i]}<br>0 polyhedra`;
      const shown = list.slice(0, HOVER_LIST_CAP);
      const more = list.length - shown.length;
      const body = shown.join('<br>') + (more > 0 ? `<br>+${more} more` : '');
      return `${xLabels[i]} (${list.length} polyhedr${list.length === 1 ? 'on' : 'a'})<br>${body}`;
    });
    return { label: cat, x: xLabels, y, customdata, hovertext };
  }).filter((g) => g.y.some((c) => c > 0));
}

function makeClickHandler() {
  let lastKey = null;
  return (customdata, point) => {
    const key = `${point.data.name}|${point.pointIndex}`;
    if (key === lastKey) {
      clearAllHighlights();
      lastKey = null;
      return;
    }
    if (customdata?.keys?.length) {
      highlightPolyhedraIn3D(customdata.keys);
      lastKey = key;
    }
  };
}

/** Scrollable drill-down list of individual polyhedra, sorted by volume. */
function buildPolyList(container) {
  container.innerHTML = '';

  if (!volumes.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No polyhedra found.';
    empty.className = 'pc-list-empty';
    container.appendChild(empty);
    return;
  }

  let lastRow = null;
  [...volumes].sort((a, b) => a.volume - b.volume).forEach((v) => {
    const row = document.createElement('div');
    row.className = 'pc-row';

    const label = document.createElement('span');
    label.textContent = `${v.label} · ${v.catLabel ?? ''}`.trim();
    label.className = 'pc-row-label';

    const badge = document.createElement('span');
    badge.textContent = `${v.volume.toFixed(2)} Å³`;
    badge.className = 'pc-row-badge';

    row.append(label, badge);
    row.addEventListener('click', () => {
      if (lastRow === row) {
        clearAllHighlights();
        row.classList.remove('is-selected');
        lastRow = null;
        return;
      }
      lastRow?.classList.remove('is-selected');
      highlightPolyhedraIn3D([v.key]);
      row.classList.add('is-selected');
      lastRow = row;
    });
    container.appendChild(row);
  });
}

export function removePolyhedraVolumeHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Polyhedra window's "Volume" button): opens the
 *  window — right-dock front tab by default, or wherever the user last dragged
 *  it — creating it on first use. */
export function addPolyhedraVolumeHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Polyhedra Volume',
    lifecycle: 'persistent',
    infoMd: './data/polyhedraVolumeHistogramInfo.md',
    closable: true,
    onClose() { view = null; resizeObserver?.disconnect(); clearHistogramPlot(PLOT_ID); },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="polyhedra-volume-histogram-item">
            <h4>Polyhedra Volume</h4>
            <div class="pvh-controls-row">
              <label><span class="pvh-ctrl-text">Bin width</span>
                <input type="range" min="0.2" max="5" step="0.2" value="1" class="pvh-width-slider">
                <span class="pvh-width-label">1.0 Å³</span>
              </label>
            </div>
            <div id="${PLOT_ID}" class="split-item-body"></div>
            <div id="pvhList" class="pc-list"></div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions">
              <button type="button" class="split-item-action-btn" data-split-action="theme" title="Toggle light/dark">🌓</button>
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
            </div>
          </div>
        </div>
      `;

      const widthSlider = /** @type {HTMLInputElement} */ (body.querySelector('.pvh-width-slider'));
      const widthLabel = body.querySelector('.pvh-width-label');
      const onBarClick = makeClickHandler();
      let expanded = false;

      function redraw() {
        const binWidth = parseFloat(widthSlider.value);
        renderGroupedHistogram(PLOT_ID, { groups: computeGroups(binWidth), xTitle: 'Volume (Å³)', yTitle: 'Polyhedra', isExpanded: expanded })
          .then(() => onHistogramBarClick(PLOT_ID, onBarClick));
        buildPolyList(body.querySelector('#pvhList'));
      }

      widthSlider.addEventListener('input', () => {
        widthLabel.textContent = `${parseFloat(widthSlider.value).toFixed(1)} Å³`;
        redraw();
      });

      body.addEventListener('click', (ev) => {
        const btn = /** @type {HTMLElement|null} */ (
          /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
        if (!btn) return;
        const action = btn.dataset.splitAction;
        if (action === 'theme') {
          togglePlotTheme(PLOT_ID);
          redraw();
        } else if (action === 'export') {
          exportHistogramPNG(PLOT_ID).catch((error) => console.error('Polyhedra volume histogram export failed:', error));
        } else if (action === 'expand') {
          expandSplitItem(btn.closest('.split-item'));
          expanded = true;
          redraw();
        } else if (action === 'close') {
          closeExpandedSplitItem();
          expanded = false;
          redraw();
        }
      });

      let lastWidth = body.clientWidth;
      resizeObserver = new ResizeObserver(() => {
        if (body.clientWidth === lastWidth || !body.clientWidth) return;
        lastWidth = body.clientWidth;
        resizeHistogramPlot(PLOT_ID);
      });
      resizeObserver.observe(body);

      view = { redraw };
      redraw();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 50 },
    },
  });
  openPanel(PANEL_ID);
}
