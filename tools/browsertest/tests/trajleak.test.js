// A deleted trajectory row must release its trajectory. Two leaks this pins:
// io/ReadeXYZModule.js started a Web Worker per .xyz load and never terminated
// it, and the worker's onmessage closure kept the parsed TrajectoryContainer
// alive; and StructureInputModule logged every loaded container (and file
// text) to the console, which DevTools keeps alive (so did a stray
// console.warn(selectedStructure) in crystal-viewer's loadStructure). Also the
// global id registry (usedIDs): the .xyz reader registered one id per atom per
// frame and a deleted row never gave its ids back. And the Trajectory panel:
// deleting a row did not rebuild it, so its transport handlers kept driving
// (and holding) the deleted trajectory — covered by a short MD run, which opens
// the panel on its trajectory, then deleting that row. Loads three
// trajectories, plays them, deletes the rows, runs and deletes the MD, takes a
// heap snapshot (CDP, Chromium only) and expects no TrajectoryContainer and no
// frame's Atoms left; on failure prints the retainer path.
'use strict';
const H = require('../harness');
(async () => {
  const { browser, page } = await H.launchApp();
  const ids = await page.evaluate(async () => {
    const n = 4, frames = 10, a = 5.43;
    const base = [[0,0,0],[0,.5,.5],[.5,0,.5],[.5,.5,0],[.25,.25,.25],[.25,.75,.75],[.75,.25,.75],[.75,.75,.25]];
    const L = (n*a).toFixed(4); const sites = [];
    for (let i=0;i<n;i++) for (let j=0;j<n;j++) for (let k=0;k<n;k++) for (const f of base) sites.push([(f[0]+i)*a,(f[1]+j)*a,(f[2]+k)*a]);
    const parts = [];
    for (let t=0;t<frames;t++){ parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
      sites.forEach((p,s)=>parts.push(`Si ${(p[0]+0.08*Math.sin(.5*t+1.3*s)).toFixed(4)} ${(p[1]).toFixed(4)} ${(p[2]).toFixed(4)}`)); }
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, usedIDs } = await import('./state/store.js');
    const idle = usedIDs.size;
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    for (let k = 0; k < 3; k++) {
      await cv.loadStructure(parts.join('\n'), `leak${k}.xyz`);
      await new Promise((r) => setTimeout(r, 1500));
      const c = structureShip.container[structureShip.container.length - 1];
      for (let f = 0; f < frames; f++) showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
    }
    for (let k = 0; k < 3; k++) {
      const rows = document.querySelectorAll('#objectTable tbody tr');
      rows[rows.length - 1].querySelector('.delete').click();
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 1000));
    const after = usedIDs.size;
    // A short NEP MD run on the selected structure, then delete its row.
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'nep';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('mdStepsInput').value = '12';
    const stride = document.getElementById('mdSaveStrideInput');
    if (stride) stride.value = '4';
    const before = structureShip.container.length;
    const btn = document.getElementById('mdStartBtn');
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    while (btn.disabled) await new Promise((r) => setTimeout(r, 100));
    const mdRan = structureShip.container.length === before + 1;
    const playerOpen = !!document.getElementById('playPauseBtn');
    const rows = document.querySelectorAll('#objectTable tbody tr');
    rows[rows.length - 1].querySelector('.delete').click();
    await new Promise((r) => setTimeout(r, 1000));
    return { idle, after, atomsPerFrame: sites.length, mdRan, playerOpen };
  });
  H.check('the MD run made a trajectory and the Trajectory panel showed it', ids.mdRan && ids.playerOpen,
    JSON.stringify(ids));
  H.check('the id registry is back to its idle size after the rows are deleted',
    ids.after <= ids.idle, JSON.stringify(ids));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  let chunks = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  const snap = JSON.parse(chunks.join(''));
  chunks = null;
  const m = snap.snapshot.meta;
  const NF = m.node_fields.length, EF = m.edge_fields.length;
  const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
  const nTypes = m.node_types[0], eTypes = m.edge_types[0];
  const nName = m.node_fields.indexOf('name'), nEdgeCount = m.node_fields.indexOf('edge_count'), nType = m.node_fields.indexOf('type'), nId = m.node_fields.indexOf('id');
  const eType = m.edge_fields.indexOf('type'), eName = m.edge_fields.indexOf('name_or_index'), eTo = m.edge_fields.indexOf('to_node');
  const nodeCount = nodes.length / NF;
  // build reverse edges
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let i = 0, e = 0; i < nodeCount; i++) { firstEdge[i] = e; e += nodes[i * NF + nEdgeCount] * EF; }
  firstEdge[nodeCount] = edges.length;
  const rev = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < nodeCount; i++) {
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
      const to = edges[e + eTo] / NF;
      const et = eTypes[edges[e + eType]];
      if (et === 'weak') continue;
      const name = (et === 'element' || et === 'hidden') ? `[${edges[e + eName]}]` : strings[edges[e + eName]];
      rev[to].push([i, name, et]);
    }
  }
  const label = (i) => `${nTypes[nodes[i * NF + nType]]}:${strings[nodes[i * NF + nName]].slice(0, 60)}`;
  // find TrajectoryContainer objects
  const targets = [];
  for (let i = 0; i < nodeCount; i++) if (strings[nodes[i * NF + nName]] === 'TrajectoryContainer' && nTypes[nodes[i * NF + nType]] === 'object') targets.push(i);
  console.log('TrajectoryContainer objects alive:', targets.length);
  H.check('no TrajectoryContainer survives deleting its row (3 loads played, 1 MD run; all deleted)', targets.length === 0,
    `${targets.length} alive`);
  // For each, BFS to a GC root (synthetic root node 0), print shortest path
  for (const t of targets) {
    const prev = new Map([[t, null]]); const q = [t]; let found = null;
    while (q.length && !found) {
      const x = q.shift();
      for (const [p, name, et] of rev[x]) {
        if (prev.has(p)) continue;
        prev.set(p, [x, name, et]);
        if (p === 0 || nTypes[nodes[p * NF + nType]] === 'synthetic') { found = p; break; }
        q.push(p);
      }
    }
    const pathOut = [];
    let cur = found;
    while (cur != null && cur !== t) { const [child, name] = prev.get(cur); pathOut.push(`${label(cur)} --${name}--> `); cur = child; }
    console.log(`container ${t} retained via:\n  ` + pathOut.join('\n  ') + label(t));
  }
  let atomObjects = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (strings[nodes[i * NF + nName]] === 'Atom' && nTypes[nodes[i * NF + nType]] === 'object') atomObjects++;
  }
  // The default structure has a handful of atoms; a retained trajectory frame
  // (or a structure kept by a console log) brings 512.
  H.check('no trajectory frame\'s Atom objects survive deleting the rows', atomObjects < ids.atomsPerFrame,
    `${atomObjects} Atom objects alive`);
  let workers = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (strings[nodes[i * NF + nName]] === 'Worker' && nTypes[nodes[i * NF + nType]] === 'native') workers++;
  }
  console.log(`  native Worker objects: ${workers}`);
  H.check('the three .xyz parse workers are gone (only the long-lived pools remain)', workers <= 6, `${workers} Worker objects`);
  await H.finish(browser);
})();
