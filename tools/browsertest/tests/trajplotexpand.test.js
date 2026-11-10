// Trajectory plot ⛶ (fullscreen) and the options row in a narrow pane.
//
// The expanded .trajPlot is position:fixed. Any ancestor with a transform /
// filter / backdrop-filter becomes its containing block instead of the
// viewport — and a MAIN-docked Trajectory panel lives inside #ui, whose
// backdrop-filter did exactly that: the "fullscreen" plot rendered clipped and
// scrolling inside the side panel. SideDock.expandSplitItem now tags #ui as
// well so panelWindow.css lifts that filter for the duration. The card also
// carried its compact wash (--chrome-1) into fullscreen, which read as
// see-through over the scrim; expanded it uses the opaque --panel-bg.
//
// Separately, .trajOptions never wrapped, so in a narrow side-dock pane the
// "Recenter each step" label broke into three lines and the row overflowed;
// controls now wrap as whole units.
'use strict';
const H = require('../harness');

const TRAJ = [
  '2', 'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0 0 0 1 0 0', 'C 1.3 0 0 2 0 0',
  '2', 'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0.02 0 0 5 0 0', 'C 1.32 0 0 6 0 0',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    const { openPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    const { sideDockPanel, refreshSideDock, closeExpandedSplitItem } = await import('./ui/panels/SideDock.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    await cv.loadStructure(traj, 'expand.xyz');
    openPanel('trajectory');
    await wait(400);
    // The card is built with the panel (Plotly loads into it lazily); make the
    // host visible so the card takes part in layout regardless of plot data.
    document.getElementById('trajPlotHost').style.display = 'block';

    const trappingAncestors = (el) => {
      const out = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        const vals = [cs.transform, cs.filter, cs.backdropFilter, cs.contain, cs.perspective];
        if (vals.some((v) => v && v !== 'none')) out.push(`${p.tagName}#${p.id}`);
      }
      return out;
    };
    const alphaOf = (rgb) => {
      const m = /rgba?\(([^)]+)\)/.exec(rgb);
      if (!m) return null;
      const parts = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      return parts.length >= 4 ? parts[3] : 1;
    };
    const expandAndMeasure = async () => {
      const root = document.querySelector('.trajPlot');
      root.querySelector('button[title="Expand"]').click();
      await wait(200);
      const r = root.getBoundingClientRect();
      const cs = getComputedStyle(root);
      const uiTagged = document.getElementById('ui')?.classList.contains('cv-has-expanded-item') ?? null;
      const out = {
        expanded: root.classList.contains('expanded'),
        coversViewport: Math.abs(r.width - innerWidth * 0.9) < 2 && Math.abs(r.height - innerHeight * 0.9) < 2
          && Math.abs(r.left - innerWidth * 0.05) < 2 && Math.abs(r.top - innerHeight * 0.05) < 2,
        trapping: trappingAncestors(root),
        bgAlpha: alphaOf(cs.backgroundColor),
        uiTagged,
      };
      closeExpandedSplitItem();
      await wait(100);
      out.uiUntagged = !(document.getElementById('ui')?.classList.contains('cv-has-expanded-item'));
      out.collapsedBack = !root.classList.contains('expanded');
      return out;
    };

    const panelEl = document.querySelector('.cv-panel[data-panel-id="trajectory"]');
    const mainDocked = { inUi: !!panelEl?.closest('#ui'), ...(await expandAndMeasure()) };

    // Narrow side dock: the options row must wrap whole controls, never
    // break a label's own text, and never overflow the panel body.
    sideDockPanel(getPanel('trajectory'));
    document.documentElement.style.setProperty('--split-pane-fraction', '0.22');
    refreshSideDock?.();
    await wait(400);
    const opts = document.querySelector('.trajOptions');
    const body = document.querySelector('.cv-panel[data-panel-id="trajectory"] .cv-panel-body');
    const labels = [...opts.querySelectorAll('.trajOpt')].filter((l) => getComputedStyle(l).display !== 'none');
    // Line boxes of a label's OWN text (not its select/input): a label whose
    // text broke across lines yields several client rects for that text.
    const textLines = (label) => {
      let lines = 0;
      for (const node of label.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        lines = Math.max(lines, tops.size);
      }
      return lines;
    };
    const rowLayout = {
      paneWidth: body.clientWidth,
      wraps: getComputedStyle(opts).flexWrap,
      noHorizontalOverflow: opts.scrollWidth <= opts.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1,
      labelTextLines: labels.map((l) => textLines(l)),
      maxLabelTextLines: Math.max(...labels.map((l) => textLines(l))),
      rows: new Set(labels.map((l) => Math.round(l.getBoundingClientRect().top))).size,
    };
    const sideDocked = await expandAndMeasure();

    return { mainDocked, rowLayout, sideDocked };
  }, TRAJ);

  H.check('main-docked ⛶: #ui is tagged and no ancestor traps the fixed plot',
    res.mainDocked.inUi && res.mainDocked.uiTagged === true && res.mainDocked.trapping.length === 0,
    JSON.stringify(res.mainDocked));
  H.check('main-docked ⛶: the plot covers the 90vw×90dvh fullscreen box',
    res.mainDocked.expanded && res.mainDocked.coversViewport, JSON.stringify(res.mainDocked));
  H.check('expanded plot has an opaque background',
    res.mainDocked.bgAlpha === 1 && res.sideDocked.bgAlpha === 1,
    JSON.stringify({ main: res.mainDocked.bgAlpha, side: res.sideDocked.bgAlpha }));
  H.check('closing untags #ui and collapses the card',
    res.mainDocked.uiUntagged && res.mainDocked.collapsedBack, JSON.stringify(res.mainDocked));
  H.check('side-docked ⛶ still covers the viewport, untrapped',
    res.sideDocked.expanded && res.sideDocked.coversViewport && res.sideDocked.trapping.length === 0,
    JSON.stringify(res.sideDocked));
  H.check('narrow pane: options wrap as whole controls (no multi-line labels, no overflow)',
    res.rowLayout.wraps === 'wrap' && res.rowLayout.noHorizontalOverflow && res.rowLayout.maxLabelTextLines === 1
      && res.rowLayout.rows >= 2,
    JSON.stringify(res.rowLayout));

  // Plotly comes from a CDN; without egress that single fetch fails with
  // ERR_TUNNEL_CONNECTION_FAILED, which is the sandbox, not the panel.
  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED/.test(e));
  H.check('no page errors', real.length === 0, real[0] || '');
  await H.finish(browser);
})().catch(H.crash);
