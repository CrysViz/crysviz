// EOS computed from the in-browser potential: does the pressure scan hold?
//
// Driven with a synthetic potential (no NEP/MLIP wasm), so each check isolates
// one claim:
//   - runEOSScan relaxes cell+atoms onto each TARGET pressure (tension
//     included): measured pressure within tolerance, volume strictly
//     shrinking as the target pressure grows
//   - the energy minimum lands on the point whose pressure is nearest zero
//   - shouldStop aborts between points / mid-relax with partial results
//   - relaxCell:false regression: the fixed-cell mode still holds the lattice
//     against nonzero stress while atoms move
//   - ingestComputedScan feeds the panel: plots window opens, E-V fit runs,
//     the scan becomes ONE file-browser row (re-runs replace, not pile up)
//   - clicking an E-V data point shows that point's structure in the viewer
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // ---- 1. engine: runEOSScan against a synthetic potential ------------------
  const engine = await page.evaluate(async () => {
    const { snapshotCurrentStructure } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { runEOSScan } = await import('./eos/eosCompute.js');
    const { relaxUntilConverged, buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { latticeVolume } = await import('./math/index.js');

    const base = snapshotCurrentStructure();
    const V0 = latticeVolume(base.lattice);
    const frac0 = base.atoms.map((a) => [...a.position]);

    // Synthetic potential: E = k(V-V0)²/V0 with tension-positive hydrostatic
    // stress σ_ii = dE/dV, so pressureGPaFromStress = -dE/dV × 160.2 — a
    // positive target pressure must COMPRESS the cell below V0, a negative
    // one stretch it above. Plus springs pulling every atom to its base
    // fractional site SHIFTED by 0.1 Å in x, so the relaxer has real atomic
    // work to do at every point, not just cell scaling.
    const k = 5;       // eV per (fractional volume deviation)²·V0
    const kS = 1;      // eV/Å² spring constant
    const SHIFT = 0.1; // Å, along x
    const makeRunner = () => ({
      modelInfo: { name: 'synthetic', element_list: [...new Set(base.elements)] },
      compute(struct) {
        const V = latticeVolume(struct.lattice);
        const dEdVol = (2 * k * (V - V0)) / V0; // dE/dV of E_vol = k (V-V0)²/V0
        const L = struct.lattice;
        let energy = (k * (V - V0) ** 2) / V0;
        const forces = struct.positions.map((r, i) => {
          const f = frac0[i];
          const target = [
            f[0] * L[0][0] + f[1] * L[1][0] + f[2] * L[2][0] + SHIFT,
            f[0] * L[0][1] + f[1] * L[1][1] + f[2] * L[2][1],
            f[0] * L[0][2] + f[1] * L[1][2] + f[2] * L[2][2],
          ];
          const d = [target[0] - r[0], target[1] - r[1], target[2] - r[2]];
          energy += 0.5 * kS * (d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
          return [kS * d[0], kS * d[1], kS * d[2]];
        });
        return {
          total_energy: energy,
          energy_per_atom: energy / struct.positions.length,
          forces,
          stress: {
            matrix3x3: [[dEdVol, 0, 0], [0, dEdVol, 0], [0, 0, dEdVol]],
            available: true,
          },
        };
      },
    });
    // Stash for the UI half of the test (separate evaluate, same page).
    window.__eosSynthetic = { makeRunner, V0 };

    const pMinGPa = -5;
    const pMaxGPa = 40;
    const nPoints = 7;
    const tol = 0.2;
    const scan = await runEOSScan(makeRunner(), base, {
      nPoints, pMinGPa, pMaxGPa, maxSteps: 400, pressureTolGPa: tol,
    });

    // Ascending targets; result arrays are sorted by volume, i.e. targets
    // reversed (highest pressure = smallest volume first).
    const targets = Array.from({ length: nPoints },
      (_, i) => pMinGPa + ((pMaxGPa - pMinGPa) * i) / (nPoints - 1));
    const targetErr = Math.max(...scan.pressures.map(
      (p, i) => Math.abs(p - targets[nPoints - 1 - i])));
    const volumesAscending = scan.volumes.every((v, i) => i === 0 || v > scan.volumes[i - 1]);
    const pressuresDescending = scan.pressures.every((p, i) => i === 0 || p < scan.pressures[i - 1]);
    const tensionExpands = scan.volumes[nPoints - 1] > V0; // the -5 GPa point
    const compressionShrinks = scan.volumes[0] < V0;       // the +40 GPa point
    const minIdx = scan.energies.indexOf(Math.min(...scan.energies));
    const nearZeroIdx = scan.pressures.reduce(
      (best, p, i) => (Math.abs(p) < Math.abs(scan.pressures[best]) ? i : best), 0);
    // Did the relaxer satisfy the shifted springs (atoms really moved)?
    const p0 = scan.structures[3].atoms[0].position;
    const atomMoved = Math.hypot(
      p0[0] - frac0[0][0], p0[1] - frac0[0][1], p0[2] - frac0[0][2]) > 1e-4;

    // Stop once point 4 starts relaxing: exactly the three completed points
    // survive (the in-flight point is dropped) and the scan flags stopped.
    let stopFlag = false;
    const partial = await runEOSScan(makeRunner(), base, {
      nPoints, pMinGPa, pMaxGPa, maxSteps: 400,
      onProgress: (text) => { if (text.startsWith('point 4/')) stopFlag = true; },
      shouldStop: () => stopFlag,
    });

    // shouldStop mid-relax: converged:false + stopped:true.
    let relaxChecks = 0;
    const stoppedRelax = await relaxUntilConverged(makeRunner(), buildNEPStructure(makeRunner(), base), {
      relaxCell: false, shouldStop: () => { relaxChecks += 1; return relaxChecks > 2; },
    });

    // relaxCell:false regression (relaxer API unchanged): the fixed-cell mode
    // must hold a strongly stressed lattice (V ≈ 1.06 V0) bit-for-bit while
    // the atoms relax onto the shifted spring sites.
    const nep0 = buildNEPStructure(makeRunner(), base);
    const scaled = {
      lattice: nep0.lattice.map((r) => r.map((x) => x * 1.02)),
      positions: nep0.positions.map((r) => r.map((x) => x * 1.02)),
      types: [...nep0.types],
    };
    const fixed = await relaxUntilConverged(makeRunner(), scaled, { relaxCell: false, maxSteps: 200 });
    const latticeHeld = fixed.structure.lattice.every(
      (row, i) => row.every((x, j) => x === scaled.lattice[i][j]));
    const fixedAtomsMoved = Math.abs(fixed.structure.positions[0][0] - scaled.positions[0][0]) > 0.05;

    return {
      n: scan.volumes.length,
      nStruct: scan.structures.length,
      allConverged: scan.converged.length === nPoints && scan.converged.every(Boolean),
      stopped: scan.stopped,
      targetErr, tol,
      volumesAscending, pressuresDescending, tensionExpands, compressionShrinks,
      minIdx, nearZeroIdx,
      atomMoved,
      partial: { n: partial.volumes.length, stopped: partial.stopped },
      stoppedRelax: { converged: stoppedRelax.converged, stopped: stoppedRelax.stopped },
      fixedCell: { latticeHeld, fixedAtomsMoved, converged: fixed.converged },
    };
  });

  H.check('scan yields 7 points with 7 structures, all converged, not stopped',
    engine.n === 7 && engine.nStruct === 7 && engine.allConverged && engine.stopped === false,
    JSON.stringify(engine));
  H.check('measured pressure lands within tolerance of every target',
    engine.targetErr <= engine.tol + 1e-9, `max |P - target| = ${engine.targetErr}`);
  H.check('volume strictly shrinks as the target pressure grows',
    engine.volumesAscending && engine.pressuresDescending,
    `ascendingV ${engine.volumesAscending} descendingP ${engine.pressuresDescending}`);
  H.check('tension expands the cell, compression shrinks it (sign convention)',
    engine.tensionExpands && engine.compressionShrinks,
    `tension ${engine.tensionExpands} compression ${engine.compressionShrinks}`);
  H.check('energy minimum sits on the point with pressure nearest zero',
    engine.minIdx === engine.nearZeroIdx, `min at ${engine.minIdx}, P≈0 at ${engine.nearZeroIdx}`);
  H.check('the relax really moved the atoms onto the shifted spring sites', engine.atomMoved);
  H.check('shouldStop between points returns the completed points + stopped flag',
    engine.partial.n === 3 && engine.partial.stopped === true, JSON.stringify(engine.partial));
  H.check('shouldStop mid-relax reports stopped, not converged',
    engine.stoppedRelax.stopped === true && engine.stoppedRelax.converged === false,
    JSON.stringify(engine.stoppedRelax));
  H.check('relaxCell:false holds the lattice exactly while atoms relax under stress',
    engine.fixedCell.latticeHeld && engine.fixedCell.fixedAtomsMoved && engine.fixedCell.converged,
    JSON.stringify(engine.fixedCell));

  // ---- 2. UI: ingestComputedScan drives the panel + plots -------------------
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('eos').expand(); // build the controls (rebuild lifecycle)
  });
  await page.waitForTimeout(400);

  const ui = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const { snapshotCurrentStructure } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { runEOSScan } = await import('./eos/eosCompute.js');
    const { ingestComputedScan } = await import('./ui/EOSPanel.js');
    const { makeRunner } = window.__eosSynthetic;

    const base = snapshotCurrentStructure();
    const opts = { nPoints: 7, pMinGPa: -5, pMaxGPa: 40, maxSteps: 400 };
    await ingestComputedScan(await runEOSScan(makeRunner(), base, opts));
    // Re-run: must REPLACE the scan row, not add a second one.
    const scan = await runEOSScan(makeRunner(), base, opts);
    await ingestComputedScan(scan);

    const names = [...document.querySelectorAll('#objectTable tbody tr')]
      .map((r) => r.querySelector('.name-inner')?.textContent ?? '');
    const scanRows = names.filter((n) => /^EOS scan/.test(n));
    const evPlot = document.getElementById('ev-plot');
    const marker = (evPlot?.data ?? []).find((t) => t.mode === 'markers');
    const eosBody = document.getElementById('cvPanelBody-eos');
    return {
      plotsOpen: !getPanel('eosPlots').closed,
      nTraces: evPlot?.data?.length ?? 0,
      customdata: marker?.customdata ?? null,
      scanRows,
      names,
      scanVolumes: scan.volumes,
      resultsShown: !eosBody.querySelector('.eos-results').hidden,
      evV0Text: document.getElementById('eos-ev-V0')?.textContent ?? '',
      status: eosBody.querySelector('.eos-status').textContent,
      unitsReset: eosBody.querySelector('#eosEnergyUnits').value === 'eV',
      hasPressureInputs: !!eosBody.querySelector('#eosComputePMin')
        && !!eosBody.querySelector('#eosComputePMax'),
    };
  });

  H.check('ingest opens the EOS plots window', ui.plotsOpen);
  H.check('E-V chart drawn with data + fit traces', ui.nTraces >= 2, `traces ${ui.nTraces}`);
  H.check('data markers carry point-index customdata',
    Array.isArray(ui.customdata) && ui.customdata.length === 7 && ui.customdata[3] === 3,
    JSON.stringify(ui.customdata));
  H.check('the fit actually completed', ui.status === 'Fit complete.' && ui.resultsShown
    && ui.evV0Text.length > 0, `status "${ui.status}" V0 "${ui.evV0Text}"`);
  H.check('re-running the scan replaces its file-browser row (exactly one)',
    ui.scanRows.length === 1 && ui.scanRows[0] === 'EOS scan (nep)', JSON.stringify(ui.names));
  H.check('ingest reset the input units to computed (eV)', ui.unitsReset);
  H.check('the panel exposes the pressure-range inputs', ui.hasPressureInputs);

  // ---- 3. clicking an E-V point shows that structure ------------------------
  const clickPoint = async (idx) => page.evaluate(async (idx) => {
    const { fileBrowser } = await import('./state/store.js');
    const { latticeVolume } = await import('./math/index.js');
    const el = document.getElementById('ev-plot');
    const emitOk = typeof el.emit === 'function';
    if (emitOk) el.emit('plotly_click', { points: [{ customdata: idx }] });
    await new Promise((r) => setTimeout(r, 600));
    return {
      emitOk,
      volume: latticeVolume(fileBrowser.selectedStructure.lattice),
      rowName: fileBrowser.selectedRow?.querySelector('.name-inner')?.textContent ?? null,
      step: fileBrowser.selectedRow?.querySelector('input[type="number"]')?.value ?? null,
    };
  }, idx);

  const first = await clickPoint(0);
  H.check('clicking the smallest-volume (highest-P) point selects that scan frame',
    first.emitOk && first.rowName === 'EOS scan (nep)'
      && Math.abs(first.volume - ui.scanVolumes[0]) < 1e-6 && first.step === '1',
    JSON.stringify(first));
  const sixth = await clickPoint(5);
  H.check('clicking another point switches to its frame',
    Math.abs(sixth.volume - ui.scanVolumes[5]) < 1e-6 && sixth.step === '6',
    JSON.stringify(sixth));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
