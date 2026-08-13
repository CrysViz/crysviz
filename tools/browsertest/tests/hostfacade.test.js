// Browser host protocol smoke/contract coverage. The manifest requests are
// fulfilled in-page so this remains a deterministic browser test fixture.
'use strict';
const H = require('../harness');

const POSCAR = `Si\n1.0\n3 0 0\n0 3 0\n0 0 3\nSi\n1\nDirect\n0 0 0\n`;

function makeTrajectoryFixture() {
  const descriptor = [
    { name: 'positions', shape: [1, 1, 3], itemsize: 8, offset: 0 },
    { name: 'cells', shape: [1, 3, 3], itemsize: 8, offset: 0 },
    { name: 'numbers', shape: [1, 1], itemsize: 8, offset: 0 },
  ];
  let header;
  let dataStart = 0;
  for (;;) {
    descriptor[0].offset = dataStart;
    descriptor[1].offset = dataStart + 24;
    descriptor[2].offset = dataStart + 96;
    header = Buffer.from(JSON.stringify({ metadata: { symbols: ['Si'] }, descriptor }));
    if (header.length === dataStart) break;
    dataStart = header.length;
  }
  const bytes = Buffer.alloc(dataStart + 104);
  header.copy(bytes);
  [0.1, 0.2, 0.3].forEach((value, i) => bytes.writeDoubleLE(value, dataStart + i * 8));
  [3, 0, 0, 0, 3, 0, 0, 0, 3].forEach((value, i) => bytes.writeDoubleLE(value, dataStart + 24 + i * 8));
  bytes.writeDoubleLE(14, dataStart + 96);
  return bytes;
}
const TRAJECTORY = makeTrajectoryFixture();

async function waitForHostFailure(page) {
  const terminal = await H.waitFor(page, () => {
    const closed = window.__hostEvents?.some((record) => record.event === 'closed');
    const error = window.__hostEvents?.find((record) => record.event === 'error')?.data;
    return closed && error ? { error } : null;
  }, { timeout: 90000, interval: 100 });
  if (!terminal) throw new Error('host failure did not reach its terminal state');
  return terminal;
}

(async () => {
  const first = await H.launchApp();
  const { browser, page, errors } = first;
  H.check('host test startup has no harness errors', errors.length === 0, errors.join(' | '));
  const completeBodies = [];
  const failureCompletions = [];
  const inputOrder = [];
  let signalFirstInputRequested;
  const firstInputRequested = new Promise((resolve) => { signalFirstInputRequested = resolve; });
  let releaseFirstInput;
  const firstInputRelease = new Promise((resolve) => { releaseFirstInput = resolve; });

  // Observe the first history mutation and subscribe as soon as the early
  // facade exists. This makes the test cover the pre-core startup boundary,
  // rather than only inspecting the settled URL.
  await page.addInitScript(() => {
    window.__hostScrubObserved = false;
    window.__hostEvents = [];
    window.__bridgeCalls = [];
    window.__bridgeReplacementCalls = 0;
    const replaceState = window.history.replaceState.bind(window.history);
    window.history.replaceState = (state, title, url) => {
      if (window.location.search.includes('_crysviz_manifest')
        && !String(url || '').includes('_crysviz_manifest')) {
        window.__hostScrubObserved = true;
      }
      return replaceState(state, title, url);
    };
    const watchHost = () => {
      const host = window.crysvizHost;
      if (host && !window.__hostSubscribed) {
        window.__hostSubscribed = true;
        const originalReceiver = (capability, record) => {
          window.__bridgeCalls.push({ capability, record });
          return Promise.reject(new Error('bridge rejection must stay private'));
        };
        window.pywebview = { api: { receive_event: originalReceiver } };
        window.dispatchEvent(new Event('pywebviewready'));
        window.pywebview = { api: {
          receive_event: () => { window.__bridgeReplacementCalls += 1; },
        } };
        host.subscribe((record) => {
          window.__hostEvents.push(record);
          if (Object.isFrozen(record)) {
            try { if (record.data) record.data.name = 'subscriber mutation'; } catch { /* frozen */ }
          }
          window.__hostEventsJsonSafe = window.__hostEventsJsonSafe !== false
            && (() => { try { JSON.stringify(record); return true; } catch { return false; } })();
          window.__hostEventsImmutable = window.__hostEventsImmutable !== false
            && record.data?.name !== 'subscriber mutation';
        });
      }
      if (!window.__hostSubscribed) window.setTimeout(watchHost, 0);
    };
    watchHost();
  });

  await page.route('**/_crysviz/manifest/capability{,/complete}', async (route) => {
    if (route.request().method() === 'POST') {
      completeBodies.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        bridgeCapability: 'bridge-capability',
        inputs: [
          { url: '/host/input-a', name: 'manifest-a', format: 'vasp' },
          { url: '/host/input-b', name: 'manifest-b', format: 'vasp' },
          { url: '/host/input-traj', name: 'binary trajectory', format: 'traj', binary: true },
        ],
      }),
    });
  });
  await page.route('**/host/input-a', async (route) => {
    signalFirstInputRequested();
    await firstInputRelease;
    inputOrder.push('manifest-a');
    await route.fulfill({ status: 200, body: POSCAR });
  });
  await page.route('**/host/input-b', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    inputOrder.push('manifest-b');
    await route.fulfill({ status: 200, body: POSCAR });
  });
  await page.route('**/host/input-traj', (route) => route.fulfill({ status: 200, body: TRAJECTORY }));

  const origin = await page.evaluate(() => location.origin);
  await page.goto(`${origin}/index.html?_crysviz_manifest=capability&state=invalid#load-file=ignored|ignored`, { waitUntil: 'load', timeout: 90000 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first host input was not requested')), 10000);
    firstInputRequested.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  let deferredPanels;
  try {
    deferredPanels = await page.evaluate(async () => {
      const { getPanel } = await import('./ui/panels/PanelManager.js');
      const { getActiveStructure } = await import('./state/structures.js');
      const visual = getPanel('visual');
      const features = getPanel('features');
      return {
        hasActiveStructure: !!getActiveStructure(),
        visualBuilt: visual?.built,
        visualHidden: visual?.el.hidden,
        featuresBuilt: features?.built,
        featuresHidden: features?.el.hidden,
      };
    });
  } finally {
    releaseFirstInput();
  }
  const hostReady = await H.waitFor(page,
    () => window.__hostEvents?.some((record) => record.event === 'ready'),
    { timeout: 90000, interval: 100 });
  if (!hostReady) throw new Error(`host did not become ready: ${JSON.stringify(await page.evaluate(() => window.__hostEvents))}`);

  const bootstrap = await page.evaluate(async () => {
    const events = [];
    const host = window.crysvizHost;
    const off = host.subscribe((record) => events.push(record));
    const listed = await host.dispatch({ command: 'list_structures' });
    off();
    return {
      descriptor: Object.getOwnPropertyDescriptor(window, 'crysvizHost'),
      frozen: Object.isFrozen(host),
      events,
      listed,
      url: location.href,
      earlyEvents: window.__hostEvents,
      scrubObserved: window.__hostScrubObserved,
      eventsJsonSafe: window.__hostEventsJsonSafe,
      eventsImmutable: window.__hostEventsImmutable,
      earlyEventsFrozen: window.__hostEvents.every((record) => Object.isFrozen(record)),
      moduleScripts: [...document.scripts]
        .filter((script) => script.type === 'module')
        .map((script) => script.getAttribute('src')),
      earlyExports: Object.keys(await import('./host/early.js')),
      bridgeCalls: window.__bridgeCalls,
      bridgeReplacementCalls: window.__bridgeReplacementCalls,
    };
  });
  H.check('host facade is frozen', bootstrap.frozen);
  H.check('host facade is non-enumerable, read-only, non-configurable',
    bootstrap.descriptor && !bootstrap.descriptor.enumerable
      && !bootstrap.descriptor.writable && !bootstrap.descriptor.configurable);
  H.check('early module is the sole HTML module entry point',
    bootstrap.moduleScripts.length === 1 && /\/host\/early\.js$/.test(bootstrap.moduleScripts[0])
      && bootstrap.earlyExports.length === 0);
  H.check('manifest query capability is scrubbed at the earliest observable point',
    bootstrap.scrubObserved && !bootstrap.url.includes('_crysviz_manifest'));
  H.check('structure-dependent persistent panels defer construction until the first structure',
    !deferredPanels.hasActiveStructure
      && !deferredPanels.visualBuilt && deferredPanels.visualHidden
      && !deferredPanels.featuresBuilt && deferredPanels.featuresHidden,
    JSON.stringify(deferredPanels));
  H.check('manifest inputs load in order and ready is replayed',
    bootstrap.listed.ok
      && bootstrap.listed.result.map((e) => e.name).join(',') === 'manifest-a,manifest-b,binary trajectory'
      && bootstrap.listed.result[2].frames === 1
      && bootstrap.events.some((e) => e.event === 'ready'));
  H.check('host manifest takes precedence over shared state and legacy hash',
    bootstrap.listed.ok && bootstrap.listed.result.length === 3
      && !bootstrap.listed.result.some((entry) => entry.name === 'ignored'));
  H.check('ready follows every delayed ordered load',
    inputOrder.join(',') === 'manifest-a,manifest-b'
      && bootstrap.earlyEvents.filter((e) => e.event === 'structure_loaded').map((e) => e.data.name).join(',')
        === 'manifest-a,manifest-b,binary trajectory'
      && bootstrap.earlyEvents.at(-1)?.event === 'ready');
  H.check('subscriber event snapshots are immutable and JSON-safe',
    bootstrap.eventsJsonSafe && bootstrap.eventsImmutable && bootstrap.earlyEventsFrozen,
    JSON.stringify({
      jsonSafe: bootstrap.eventsJsonSafe,
      immutable: bootstrap.eventsImmutable,
      frozen: bootstrap.earlyEventsFrozen,
    }));
  H.check('pywebview captures the original receiver and handles rejection',
    bootstrap.bridgeCalls.length > 0
      && bootstrap.bridgeCalls.every((call) => call.capability === 'bridge-capability')
      && bootstrap.bridgeCalls.some((call) => call.record.event === 'ready')
      && bootstrap.bridgeReplacementCalls === 0
      && !errors.some((entry) => entry.includes('bridge-capability')));
  H.check('manifest completion acknowledges success',
    completeBodies.length === 1 && completeBodies[0].ok === true, JSON.stringify(completeBodies));

  const outputCapability = 'output-capability-123456789012345678901234';
  const outputBodies = [];
  const outputRoute = `${origin}/_crysviz/output/${outputCapability}`;
  await page.route(outputRoute, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    outputBodies.push({
      contentType: await route.request().headerValue('content-type'),
      body: route.request().postDataBuffer(),
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  const protocol = await page.evaluate(async () => {
    const host = window.crysvizHost;
    const before = await host.dispatch({ command: 'list_structures' });
    const first = before.result[0];
    const select = await host.dispatch({ command: 'select', args: { id: first.id, frame: 0 } });
    const positionBefore = (await import('./state/structures.js')).getActiveStructure().atoms[0].position.slice();
    const invalid = await host.dispatch({ command: 'update_fractional_positions', args: {
      positions: [[0, 0, Number.NaN]],
    } });
    const positionAfterInvalid = (await import('./state/structures.js')).getActiveStructure().atoms[0].position.slice();
    const committed = await host.dispatch({ command: 'update_fractional_positions', args: {
      positions: [[0.1, 0.2, 0.3]], commit: true,
    } });
    const rejected = await host.dispatch({ command: 'not_allowed' });
    const payload = '<img src=x onerror="window.__hostInjected=1">';
    const loaded = await host.dispatch({ command: 'load', args: { name: payload, data: 'Si\n1.0\n3 0 0\n0 3 0\n0 0 3\nSi\n1\nDirect\n0 0 0\n', format: 'vasp' } });
    const { captureState } = await import('./ui/ShareModule.js');
    const sessionState = captureState();
    const sessionLoaded = await host.dispatch({ command: 'load', args: {
      name: 'host-session.crysviz',
      data: JSON.stringify({ format: 'crysviz', ...sessionState }),
    } });
    const { app } = await import('./state/store.js');
    const cameraAfterSession = {
      position: app.camera.position.toArray(),
      target: app.controls.target.toArray(),
      zoom: app.camera.zoom,
    };
    const { getActiveStructure } = await import('./state/structures.js');
    const activeBeforeLattice = getActiveStructure();
    const oldLattice = activeBeforeLattice.lattice.map((row) => [...row]);
    const invalidLatticeShape = await host.dispatch({ command: 'update_lattice', args: {
      lattice: [[3, 0, 0], [0, 3, 0]],
    } });
    const latticeAfterShape = getActiveStructure().lattice.map((row) => [...row]);
    const invalidLatticeNonfinite = await host.dispatch({ command: 'update_lattice', args: {
      lattice: [[3, 0, 0], [0, 3, 0], [0, 0, Number.NaN]],
    } });
    const latticeAfterNonfinite = getActiveStructure().lattice.map((row) => [...row]);
    const invalidLatticeSingular = await host.dispatch({ command: 'update_lattice', args: {
      lattice: [[3, 0, 0], [0, 3, 0], [6, 0, 0]],
    } });
    const latticeAfterSingular = getActiveStructure().lattice.map((row) => [...row]);
    const positioned = await host.dispatch({ command: 'update_fractional_positions', args: {
      positions: [[0.2, 0.3, 0.4]], commit: true,
    } });
    const latticeBeforeUpdate = getActiveStructure();
    const fractionalBeforeLattice = latticeBeforeUpdate.atoms.map((atom) => atom.position.slice());
    const originalLatticeBeforeUpdate = latticeBeforeUpdate.original.lattice.map((row) => [...row]);
    const cameraBeforeLattice = {
      position: app.camera.position.toArray(),
      target: app.controls.target.toArray(),
      zoom: app.camera.zoom,
    };
    const newLattice = [[3, 0.2, 0], [0, 3, 0.1], [0.3, 0, 3]];
    const expectedCartesian = [0.2 * 3 + 0.3 * 0 + 0.4 * 0.3,
      0.2 * 0.2 + 0.3 * 3 + 0.4 * 0,
      0.2 * 0 + 0.3 * 0.1 + 0.4 * 3];
    const { groups, general } = await import('./state/store.js');
    general.showPolyhedra = true;
    const polyhedraBuildBefore = general.polyhedraBuildCounter || 0;
    const previousPolyhedraGroup = groups.polyhedraGroup;
    const pipeline = app.pipeline;
    const originalPipelineRender = pipeline.render;
    let postCompletionFrameObserved = false;
    let paintedPolyhedraGroup = null;
    pipeline.render = (...args) => {
      if (groups.polyhedraGroup !== previousPolyhedraGroup) {
        postCompletionFrameObserved = true;
        paintedPolyhedraGroup = groups.polyhedraGroup;
      }
      return originalPipelineRender.apply(pipeline, args);
    };
    const updatedLattice = await host.dispatch({ command: 'update_lattice', args: {
      lattice: newLattice,
    } });
    await new Promise((resolve) => {
      const deadline = performance.now() + 1000;
      const observe = () => {
        if (postCompletionFrameObserved || performance.now() >= deadline) resolve();
        else requestAnimationFrame(observe);
      };
      observe();
    });
    pipeline.render = originalPipelineRender;
    const polyhedraBuildAfter = general.polyhedraBuildCounter || 0;
    const updatedStructure = getActiveStructure();
    const latticeMeshPosition = groups.latticeGroup?.children[0]?.position.toArray() || null;
    const atomMatrix = groups.atomsMesh?.instanceMatrix.array;
    const updatedState = {
      lattice: updatedStructure.lattice.map((row) => [...row]),
      fractional: updatedStructure.atoms.map((atom) => atom.position.slice()),
      originalLattice: updatedStructure.original.lattice.map((row) => [...row]),
      periodicCartesian: updatedStructure.periodic.visibleWrapped?.cart?.[0] || null,
      atomTranslation: atomMatrix ? [...atomMatrix.slice(12, 15)] : null,
      latticeMeshPosition,
      camera: {
        position: app.camera.position.toArray(),
        target: app.controls.target.toArray(),
        zoom: app.camera.zoom,
      },
    };
    const { createBrowserHost } = await import('./host/BrowserHost.js');
    const throwingController = createBrowserHost({
      updateLattice: () => {
        const unsafe = { secret: 'not-json-safe' };
        unsafe.self = unsafe;
        throw Object.assign(new Error('injected lattice callback failure'), { details: unsafe });
      },
    });
    const throwingLattice = await throwingController.dispatchInternal({ command: 'update_lattice', args: {
      lattice: newLattice,
    } });
    const fallbackController = createBrowserHost({
      applyFrameFast: () => { throw new Error('injected fast path failure'); },
      commitPositions: () => true,
    });
    const unavailableLattice = await fallbackController.dispatchInternal({ command: 'update_lattice', args: {
      lattice: newLattice,
    } });
    let releaseAsyncLattice;
    const asyncLatticeGate = new Promise((resolve) => { releaseAsyncLattice = resolve; });
    const asyncController = createBrowserHost({
      updateLattice: async () => {
        await asyncLatticeGate;
        return true;
      },
    });
    const pendingAsyncLattice = asyncController.dispatchInternal({ command: 'update_lattice', args: {
      lattice: newLattice,
    } });
    const asyncLatticePendingState = await Promise.race([
      pendingAsyncLattice.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    releaseAsyncLattice();
    const asyncLattice = await pendingAsyncLattice;
    let releaseAsyncRejection;
    const asyncRejectionGate = new Promise((resolve) => { releaseAsyncRejection = resolve; });
    const asyncRejectingController = createBrowserHost({
      updateLattice: async () => {
        await asyncRejectionGate;
        throw new Error('async lattice callback failure');
      },
    });
    const pendingAsyncRejection = asyncRejectingController.dispatchInternal({ command: 'update_lattice', args: {
      lattice: newLattice,
    } });
    const asyncRejectionPendingState = await Promise.race([
      pendingAsyncRejection.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    releaseAsyncRejection();
    const asyncRejection = await pendingAsyncRejection;
    const fallback = await fallbackController.dispatchInternal({ command: 'update_fractional_positions', args: {
      positions: [[0.15, 0.25, 0.35]],
    } });
    const beforeCamera = {
      position: (await import('./state/store.js')).app.camera.position.toArray(),
      target: (await import('./state/store.js')).app.controls.target.toArray(),
    };
    const beforeRadius = Math.hypot(
      beforeCamera.position[0] - beforeCamera.target[0],
      beforeCamera.position[1] - beforeCamera.target[1],
      beforeCamera.position[2] - beforeCamera.target[2],
    );
    const rotated = await host.dispatch({ command: 'rotate_camera', args: { angleDegrees: 18, axis: 'y' } });
    const afterCamera = { position: app.camera.position.toArray(), target: app.controls.target.toArray() };
    const afterRadius = Math.hypot(
      afterCamera.position[0] - afterCamera.target[0],
      afterCamera.position[1] - afterCamera.target[1],
      afterCamera.position[2] - afterCamera.target[2],
    );
    const raytrace = await host.dispatch({ command: 'set_render_pipeline', args: { pipelineId: 'raytrace' } });
    const raytraceState = {
      select: document.getElementById('renderPipelineMenu')?.value,
      tracerBody: document.body.classList.contains('tracer-pipeline'),
      warningVisible: document.getElementById('raytraceWarningModal')?.hidden === false,
    };
    const unknownPipeline = await host.dispatch({ command: 'set_render_pipeline', args: { pipelineId: 'unknown' } });
    const raster = await host.dispatch({ command: 'set_render_pipeline', args: { pipelineId: 'forward' } });
    const saved = await host.dispatch({ command: 'save_image', args: {
      width: 320, height: 240, margin: 16, transparent: false, structureOnly: true,
      outputUrl: `${location.origin}/_crysviz/output/output-capability-123456789012345678901234`,
    } });
    const invalidOutput = await host.dispatch({ command: 'save_image', args: {
      width: 320, height: 240, margin: 0, transparent: false, structureOnly: false,
      outputUrl: `${location.origin}/_crysviz/output/output-capability-123456789012345678901234?alias=1`,
    } });
    return {
      before,
      select,
      invalid,
      positionBefore,
      positionAfterInvalid,
      committed,
      rejected,
      loaded,
      sessionLoaded,
      sessionCamera: sessionState.camera,
      cameraAfterSession,
      oldLattice,
      invalidLatticeShape,
      latticeAfterShape,
      invalidLatticeNonfinite,
      latticeAfterNonfinite,
      invalidLatticeSingular,
      latticeAfterSingular,
      positioned,
      fractionalBeforeLattice,
      originalLatticeBeforeUpdate,
      cameraBeforeLattice,
      newLattice,
      expectedCartesian,
      polyhedraBuildBefore,
      polyhedraBuildAfter,
      polyhedraFrameObserved: postCompletionFrameObserved && paintedPolyhedraGroup === groups.polyhedraGroup,
      updatedLattice,
      updatedState,
      throwingLattice,
      unavailableLattice,
      asyncLatticePendingState,
      asyncLattice,
      asyncRejectionPendingState,
      asyncRejection,
      fallback,
      rotated, beforeCamera, afterCamera, beforeRadius, afterRadius,
      raytrace, raytraceState, unknownPipeline, raster, saved, invalidOutput,
      injected: window.__hostInjected === 1,
      injectedNodes: document.querySelectorAll('img[src="x"], img[onerror]').length,
      textName: [...document.querySelectorAll('.name-inner')].some((el) => el.textContent === payload),
    };
  });
  H.check('list/select use stable opaque IDs',
    protocol.before.result.every((entry) => /^structure-\d+$/.test(entry.id)) && protocol.select.ok);
  H.check('invalid coordinates reject without mutation',
    !protocol.invalid.ok && protocol.invalid.error.code === 'INVALID_POSITIONS'
      && JSON.stringify(protocol.positionBefore) === JSON.stringify(protocol.positionAfterInvalid));
  H.check('commit path reports fast path and rebuild',
    protocol.committed.ok && protocol.committed.result.atomCount === 1
      && protocol.committed.result.rebuilt === true);
  H.check('allowlist rejects arbitrary commands',
    !protocol.rejected.ok && protocol.rejected.error.code === 'UNKNOWN_COMMAND');
  H.check('filename is text-only with no injected DOM',
    protocol.loaded.ok && !protocol.injected && protocol.injectedNodes === 0 && protocol.textName);
  H.check('non-plain .crysviz load returns its new container',
    protocol.sessionLoaded.ok && /^structure-\d+$/.test(protocol.sessionLoaded.result.id)
      && protocol.sessionLoaded.result.name === 'host-session.crysviz');
  H.check('session camera survives awaited .crysviz restoration',
    protocol.sessionLoaded.ok
      && JSON.stringify(protocol.cameraAfterSession.position) === JSON.stringify(protocol.sessionCamera.position)
      && JSON.stringify(protocol.cameraAfterSession.target) === JSON.stringify(protocol.sessionCamera.target));
  H.check('invalid lattice requests reject without mutation',
    !protocol.invalidLatticeShape.ok && protocol.invalidLatticeShape.error.code === 'INVALID_LATTICE'
      && !protocol.invalidLatticeNonfinite.ok && protocol.invalidLatticeNonfinite.error.code === 'INVALID_LATTICE'
      && !protocol.invalidLatticeSingular.ok && protocol.invalidLatticeSingular.error.code === 'INVALID_LATTICE'
      && JSON.stringify(protocol.oldLattice) === JSON.stringify(protocol.latticeAfterShape)
      && JSON.stringify(protocol.oldLattice) === JSON.stringify(protocol.latticeAfterNonfinite)
      && JSON.stringify(protocol.oldLattice) === JSON.stringify(protocol.latticeAfterSingular));
  H.check('valid lattice update rebuilds geometry while preserving fractional data and camera',
    protocol.positioned.ok && protocol.updatedLattice.ok && protocol.updatedLattice.result === true
      && JSON.stringify(protocol.updatedState.lattice) === JSON.stringify(protocol.newLattice)
      && JSON.stringify(protocol.updatedState.fractional) === JSON.stringify(protocol.fractionalBeforeLattice)
      && JSON.stringify(protocol.updatedState.originalLattice) === JSON.stringify(protocol.originalLatticeBeforeUpdate)
      && protocol.updatedState.periodicCartesian.every((value, index) => Math.abs(value - protocol.expectedCartesian[index]) < 1e-9)
      && protocol.updatedState.atomTranslation.every((value, index) => Math.abs(value - protocol.expectedCartesian[index]) < 1e-6)
      && protocol.updatedState.latticeMeshPosition.every((value, index) => Math.abs(value - protocol.newLattice[0][index] / 2) < 1e-9)
      && protocol.polyhedraBuildAfter > protocol.polyhedraBuildBefore
      && protocol.polyhedraFrameObserved
      && JSON.stringify(protocol.updatedState.camera) === JSON.stringify(protocol.cameraBeforeLattice),
    JSON.stringify({
      positioned: protocol.positioned,
      updatedLattice: protocol.updatedLattice,
      expectedCartesian: protocol.expectedCartesian,
      polyhedraBuildBefore: protocol.polyhedraBuildBefore,
      polyhedraBuildAfter: protocol.polyhedraBuildAfter,
      polyhedraFrameObserved: protocol.polyhedraFrameObserved,
      updatedState: protocol.updatedState,
      cameraBeforeLattice: protocol.cameraBeforeLattice,
    }));
  H.check('lattice callback failure is normalized and JSON-safe',
    !protocol.throwingLattice.ok
      && protocol.throwingLattice.error.code === 'LATTICE_SYNC_FAILED'
      && protocol.throwingLattice.error.details?.cause?.message === 'injected lattice callback failure'
      && protocol.throwingLattice.error.details?.cause?.details?.self === '[Circular]'
      && !Object.prototype.hasOwnProperty.call(protocol.throwingLattice.error.details?.cause || {}, 'stack')
      && (() => { try { JSON.stringify(protocol.throwingLattice); return true; } catch { return false; } })(),
    JSON.stringify(protocol.throwingLattice));
  H.check('lattice update reports unavailable callback',
    !protocol.unavailableLattice.ok
      && protocol.unavailableLattice.error.code === 'COMMAND_UNAVAILABLE');
  H.check('lattice update awaits async callback completion and rejection',
    protocol.asyncLatticePendingState === 'pending'
      && protocol.asyncLattice.ok && protocol.asyncLattice.result === true
      && protocol.asyncRejectionPendingState === 'pending'
      && !protocol.asyncRejection.ok
      && protocol.asyncRejection.error.code === 'LATTICE_SYNC_FAILED'
      && protocol.asyncRejection.error.details?.cause?.message === 'async lattice callback failure');
  H.check('thrown fast path falls back to a full synchronization',
    protocol.fallback.ok && protocol.fallback.result.fastPathApplied === false
      && protocol.fallback.result.rebuilt === true
      && protocol.fallback.result.fallbackReason === 'FAST_PATH_FAILED');
  H.check('controller camera rotation preserves target and orbit radius',
    protocol.rotated.ok
      && protocol.beforeCamera.target.every((value, index) => Math.abs(value - protocol.afterCamera.target[index]) < 1e-9)
      && Math.abs(protocol.beforeRadius - protocol.afterRadius) < 1e-6
      && protocol.beforeCamera.position.some((value, index) => Math.abs(value - protocol.afterCamera.position[index]) > 1e-6));
  H.check('controller pipeline selection synchronizes UI without warning',
    protocol.raytrace.ok && protocol.raytrace.result === 'raytrace'
      && protocol.raytraceState.select === 'raytrace'
      && protocol.raytraceState.tracerBody && !protocol.raytraceState.warningVisible);
  H.check('controller rejects unknown pipeline and returns to raster',
    !protocol.unknownPipeline.ok && protocol.unknownPipeline.error.code === 'INVALID_PIPELINE'
      && protocol.raster.ok && protocol.raster.result === 'forward');
  const pngBody = outputBodies[0]?.body;
  H.check('controller PNG capture uploads a nontrivial PNG to the exact output route',
    protocol.saved.ok && protocol.saved.result.contentType === 'image/png'
      && outputBodies.length === 1 && outputBodies[0].contentType === 'image/png'
      && pngBody && pngBody.length > 32
      && pngBody.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    JSON.stringify({
      saved: protocol.saved,
      uploads: outputBodies.length,
      contentType: outputBodies[0]?.contentType,
      bytes: pngBody?.length,
    }));
  H.check('controller rejects invalid output URL without upload',
    !protocol.invalidOutput.ok && protocol.invalidOutput.error.code === 'INVALID_OUTPUT_URL'
      && outputBodies.length === 1);

  const deferredPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await deferredPage.addInitScript(() => {
    localStorage.setItem('panelLayout', JSON.stringify({
      version: 4,
      dockOrder: [],
      panels: { visual: { dock: 'left', closed: true, collapsed: false, bar: false } },
      rightDock: { order: [], front: null, collapsed: false, fraction: null, side: 'right' },
    }));
  });
  await deferredPage.goto(`${origin}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await deferredPage.waitForTimeout(5000);
  const deferredPanel = await deferredPage.evaluate(async () => {
    const before = {
      contentBuilt: !!document.getElementById('colorControlsGroup'),
      selectPresent: !!document.getElementById('renderPipelineMenu'),
    };
    const dispatched = await window.crysvizHost.dispatch({
      command: 'set_render_pipeline', args: { pipelineId: 'raytrace' },
    });
    const beforeOpen = {
      bodyTracer: document.body.classList.contains('tracer-pipeline'),
      warningVisible: document.getElementById('raytraceWarningModal')?.hidden === false,
    };
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('visual');
    return {
      before, dispatched, beforeOpen,
      afterOpen: {
        select: document.getElementById('renderPipelineMenu')?.value,
        rtControls: document.getElementById('rtControlsBlock')?.style.display,
        groundReflect: document.getElementById('rtGroundReflect')?.closest('.control-row')?.style.display,
        renderStyle: document.getElementById('renderStyleMenu')?.closest('.control-row')?.style.display,
      },
    };
  });
  H.check('closed Visual panel defers content construction',
    !deferredPanel.before.contentBuilt && !deferredPanel.before.selectPresent);
  H.check('controller pipeline selection updates deferred Visual body state without warning',
    deferredPanel.dispatched.ok && deferredPanel.beforeOpen.bodyTracer && !deferredPanel.beforeOpen.warningVisible);
  H.check('opening deferred Visual builds truthful tracer controls',
    deferredPanel.afterOpen.select === 'raytrace'
      && deferredPanel.afterOpen.rtControls === 'block'
      && deferredPanel.afterOpen.groundReflect === 'grid'
      && deferredPanel.afterOpen.renderStyle === 'none', JSON.stringify(deferredPanel.afterOpen));
  await deferredPage.close();

  const vendored = await page.evaluate(async () => {
    const response = await fetch('./external/socket.io/socket.io.esm.min.js');
    return response.ok && !(performance.getEntriesByType('resource') || [])
      .some((entry) => entry.name.includes('cdnjs.cloudflare.com/socket.io'));
  });
  H.check('Socket.IO startup dependency is locally vendored', vendored);
  H.check('successful host bootstrap has no harness errors', errors.length === 0, errors.join(' | '));

  await page.unroute('**/_crysviz/manifest/capability{,/complete}');
  const emptyManifestCompletions = [];
  await page.route('**/_crysviz/manifest/empty{,/complete}', async (route) => {
    if (route.request().method() === 'POST') {
      emptyManifestCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, inputs: [] }),
    });
  });
  await page.goto(`${origin}/index.html?_crysviz_manifest=empty`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  const emptyManifest = await page.evaluate(async () => {
    const dispatch = await window.crysvizHost.dispatch({ command: 'list_structures' });
    return {
      dispatch,
      defaultName: dispatch.ok ? dispatch.result[0]?.name : null,
    };
  });
  H.check('empty host manifest loads the built-in default authoritatively',
    emptyManifest.dispatch.ok && emptyManifest.dispatch.result.length === 1
      && emptyManifest.defaultName === 'Si'
      && emptyManifestCompletions.length === 1 && emptyManifestCompletions[0].ok === true);
  await page.unroute('**/_crysviz/manifest/empty{,/complete}');

  await page.route('**/_crysviz/manifest/failing{,/complete}', async (route) => {
    if (route.request().method() === 'POST') {
      failureCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else {
      await route.fulfill({ status: 503, body: 'unavailable' });
    }
  });
  await page.goto(`${origin}/index.html?_crysviz_manifest=failing`, { waitUntil: 'load', timeout: 90000 });
  await waitForHostFailure(page);
  const failedBootstrap = await page.evaluate(async () => {
    const host = window.crysvizHost;
    const dispatch = await host.dispatch({ command: 'list_structures' });
    const { getContainers } = await import('./state/structures.js');
    return {
      structureCount: getContainers().length,
      dispatchCode: dispatch.error?.code || null,
      hostError: window.__hostEvents?.find((record) => record.event === 'error')?.data || null,
    };
  });
  H.check('authoritative host failure does not fall through to default',
    failedBootstrap.structureCount === 0
      && ['NOT_READY', 'VIEWER_CLOSED'].includes(failedBootstrap.dispatchCode)
      && /Could not fetch host manifest/.test(failedBootstrap.hostError?.message || ''),
    JSON.stringify(failedBootstrap));
  H.check('authoritative host failure posts unsuccessful completion',
    failureCompletions.length === 1 && failureCompletions[0].ok === false,
    JSON.stringify(failureCompletions));

  await page.unroute('**/_crysviz/manifest/failing{,/complete}');
  const dynamicFailureCompletions = [];
  await page.route('**/_crysviz/manifest/dynamic-failure{,/complete}', async (route) => {
    if (route.request().method() === 'POST') {
      dynamicFailureCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, inputs: [] }),
    });
  });
  await page.route('**/core/crystal-viewer.js', (route) =>
    route.fulfill({ status: 404, body: 'intentional dynamic import failure' }));
  await page.goto(`${origin}/index.html?_crysviz_manifest=dynamic-failure`, { waitUntil: 'load', timeout: 90000 });
  await waitForHostFailure(page);
  const dynamicFailure = await page.evaluate(async () => {
    const dispatch = await window.crysvizHost.dispatch({ command: 'list_structures' });
    const { getContainers } = await import('./state/structures.js');
    return {
      structureCount: getContainers().length,
      dispatchCode: dispatch.error?.code || null,
      hostError: window.__hostEvents?.find((record) => record.event === 'error')?.data || null,
    };
  });
  H.check('dynamic core import failure closes host and completes once',
    dynamicFailure.structureCount === 0
      && ['NOT_READY', 'VIEWER_CLOSED'].includes(dynamicFailure.dispatchCode)
      && !!dynamicFailure.hostError?.message
      && dynamicFailureCompletions.length === 1
      && dynamicFailureCompletions[0].ok === false,
    JSON.stringify({ dynamicFailure, completions: dynamicFailureCompletions }));
  await page.unroute('**/core/crystal-viewer.js');
  await page.unroute('**/_crysviz/manifest/dynamic-failure{,/complete}');

  const redirectCompletions = [];
  await page.route('**/_crysviz/manifest/redirect-manifest{,/complete}', async (route) => {
    if (route.request().method() === 'POST') {
      redirectCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({ status: 302, headers: { location: 'https://example.invalid/manifest' } });
  });
  await page.goto(`${origin}/index.html?_crysviz_manifest=redirect-manifest`, { waitUntil: 'load', timeout: 90000 });
  await waitForHostFailure(page);
  H.check('manifest redirect is rejected and completed exactly once',
    redirectCompletions.length === 1 && redirectCompletions[0].ok === false,
    JSON.stringify(redirectCompletions));

  await page.unroute('**/_crysviz/manifest/redirect-manifest{,/complete}');
  const inputRedirectCompletions = [];
  let redirectedInputFetched = false;
  await page.route('**/_crysviz/manifest/input-redirect{,/complete}', async (route) => {
    if (route.request().method() === 'POST') {
      inputRedirectCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, inputs: [{ url: '/host/input-redirect', name: 'redirected-input' }] }),
    });
  });
  await page.route('**/host/input-redirect', async (route) => {
    redirectedInputFetched = true;
    await route.fulfill({ status: 302, headers: { location: 'https://example.invalid/input' } });
  });
  await page.goto(`${origin}/index.html?_crysviz_manifest=input-redirect`, { waitUntil: 'load', timeout: 90000 });
  await waitForHostFailure(page);
  H.check('input redirect is rejected without a successful load',
    redirectedInputFetched && inputRedirectCompletions.length === 1 && inputRedirectCompletions[0].ok === false,
    JSON.stringify({ redirectedInputFetched, completions: inputRedirectCompletions }));

  // The legacy loader splits before decoding. An encoded pipe and percent sign
  // therefore remain legal filename characters and are decoded exactly once.
  await page.goto(`${origin}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  const hashResult = await page.evaluate(async (poscar) => {
    const filename = '100%|pipe.vasp';
    const encoded = `${encodeURIComponent(filename)}|${encodeURIComponent(btoa(poscar))}`;
    history.replaceState({}, document.title, `${location.pathname}#load-file=${encoded}`);
    const { loadFromFilePath } = await import('./io/FileURLLoader.js');
    const loaded = await loadFromFilePath();
    const names = [...document.querySelectorAll('.name-inner')].map((el) => el.textContent);
    return { loaded, filename, found: names.includes(filename), hash: location.hash };
  }, POSCAR);
  H.check('legacy hash decodes encoded percent and pipe once',
    hashResult.loaded && hashResult.found && hashResult.hash === '');
  await page.unroute(outputRoute);
  await H.finish(browser);
})().catch(H.crash);
