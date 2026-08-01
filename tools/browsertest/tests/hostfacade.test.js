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

(async () => {
  const first = await H.launchApp();
  const { browser, page, errors } = first;
  H.check('host test startup has no harness errors', errors.length === 0, errors.join(' | '));
  const completeBodies = [];
  const failureCompletions = [];
  const inputOrder = [];

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

  await page.route('**/_crysviz/manifest/capability*', async (route) => {
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
  await page.waitForTimeout(4000);

  const bootstrap = await page.evaluate(async () => {
    const events = [];
    const host = window.crysvizHost;
    const off = host.subscribe((record) => events.push(record));
    const structures = (await host.dispatch({ command: 'list_structures' })).result;
    off();
    return {
      descriptor: Object.getOwnPropertyDescriptor(window, 'crysvizHost'),
      frozen: Object.isFrozen(host),
      events,
      structures,
      url: location.href,
      earlyEvents: window.__hostEvents,
      scrubObserved: window.__hostScrubObserved,
      eventsJsonSafe: window.__hostEventsJsonSafe,
      eventsImmutable: window.__hostEventsImmutable,
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
  H.check('manifest inputs load in order and ready is replayed',
    bootstrap.structures.map((e) => e.name).join(',') === 'manifest-a,manifest-b,binary trajectory'
      && bootstrap.structures[2].frames === 1
      && bootstrap.events.some((e) => e.event === 'ready'));
  H.check('host manifest takes precedence over shared state and legacy hash',
    bootstrap.structures.length === 3
      && !bootstrap.structures.some((entry) => entry.name === 'ignored'));
  H.check('ready follows every delayed ordered load',
    inputOrder.join(',') === 'manifest-a,manifest-b'
      && bootstrap.earlyEvents.filter((e) => e.event === 'structure_loaded').map((e) => e.data.name).join(',')
        === 'manifest-a,manifest-b,binary trajectory'
      && bootstrap.earlyEvents.at(-1)?.event === 'ready');
  H.check('subscriber event snapshots are immutable and JSON-safe',
    bootstrap.eventsJsonSafe && bootstrap.eventsImmutable
      && bootstrap.earlyEvents.every((record) => Object.isFrozen(record)));
  H.check('pywebview captures the original receiver and handles rejection',
    bootstrap.bridgeCalls.length > 0
      && bootstrap.bridgeCalls.every((call) => call.capability === 'bridge-capability')
      && bootstrap.bridgeCalls.some((call) => call.record.event === 'ready')
      && bootstrap.bridgeReplacementCalls === 0
      && !errors.some((entry) => entry.includes('bridge-capability')));
  H.check('manifest completion acknowledges success',
    completeBodies.length === 1 && completeBodies[0].ok === true, JSON.stringify(completeBodies));

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
    };
    const { createBrowserHost } = await import('./host/BrowserHost.js');
    const fallbackController = createBrowserHost({
      applyFrameFast: () => { throw new Error('injected fast path failure'); },
      commitPositions: () => true,
    });
    const fallback = await fallbackController.dispatchInternal({ command: 'update_fractional_positions', args: {
      positions: [[0.15, 0.25, 0.35]],
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
      fallback,
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
  H.check('thrown fast path falls back to a full synchronization',
    protocol.fallback.ok && protocol.fallback.result.fastPathApplied === false
      && protocol.fallback.result.rebuilt === true
      && protocol.fallback.result.fallbackReason === 'FAST_PATH_FAILED');

  const vendored = await page.evaluate(async () => {
    const response = await fetch('./external/socket.io/socket.io.esm.min.js');
    return response.ok && !(performance.getEntriesByType('resource') || [])
      .some((entry) => entry.name.includes('cdnjs.cloudflare.com/socket.io'));
  });
  H.check('Socket.IO startup dependency is locally vendored', vendored);
  H.check('successful host bootstrap has no harness errors', errors.length === 0, errors.join(' | '));

  await page.unroute('**/_crysviz/manifest/capability*');
  const emptyManifestCompletions = [];
  await page.route('**/_crysviz/manifest/empty*', async (route) => {
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
  await page.unroute('**/_crysviz/manifest/empty*');

  await page.route('**/_crysviz/manifest/failing*', async (route) => {
    if (route.request().method() === 'POST') {
      failureCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else {
      await route.fulfill({ status: 503, body: 'unavailable' });
    }
  });
  await page.goto(`${origin}/index.html?_crysviz_manifest=failing`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(1500);
  const failedBootstrap = await page.evaluate(async () => {
    const host = window.crysvizHost;
    const dispatch = await host.dispatch({ command: 'list_structures' });
    const { getContainers } = await import('./state/structures.js');
    return {
      structureCount: getContainers().length,
      dispatchCode: dispatch.error?.code || null,
      status: document.getElementById('status')?.textContent || '',
    };
  });
  H.check('authoritative host failure does not fall through to default',
    failedBootstrap.structureCount === 0
      && ['NOT_READY', 'VIEWER_CLOSED'].includes(failedBootstrap.dispatchCode)
      && /Could not fetch host manifest/.test(failedBootstrap.status));
  H.check('authoritative host failure posts unsuccessful completion',
    failureCompletions.length === 1 && failureCompletions[0].ok === false);

  await page.unroute('**/_crysviz/manifest/failing*');
  const dynamicFailureCompletions = [];
  await page.route('**/_crysviz/manifest/dynamic-failure*', async (route) => {
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
  await page.waitForTimeout(1200);
  const dynamicFailure = await page.evaluate(async () => {
    const dispatch = await window.crysvizHost.dispatch({ command: 'list_structures' });
    const { getContainers } = await import('./state/structures.js');
    return {
      structureCount: getContainers().length,
      dispatchCode: dispatch.error?.code || null,
      status: document.getElementById('status')?.textContent || '',
    };
  });
  H.check('dynamic core import failure closes host and completes once',
    dynamicFailure.structureCount === 0
      && ['NOT_READY', 'VIEWER_CLOSED'].includes(dynamicFailure.dispatchCode)
      && /Error:/.test(dynamicFailure.status)
      && dynamicFailureCompletions.length === 1
      && dynamicFailureCompletions[0].ok === false);
  await page.unroute('**/core/crystal-viewer.js');
  await page.unroute('**/_crysviz/manifest/dynamic-failure*');

  const redirectCompletions = [];
  await page.route('**/_crysviz/manifest/redirect-manifest*', async (route) => {
    if (route.request().method() === 'POST') {
      redirectCompletions.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({ status: 302, headers: { location: 'https://example.invalid/manifest' } });
  });
  await page.goto(`${origin}/index.html?_crysviz_manifest=redirect-manifest`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(1200);
  H.check('manifest redirect is rejected and completed exactly once',
    redirectCompletions.length === 1 && redirectCompletions[0].ok === false);

  await page.unroute('**/_crysviz/manifest/redirect-manifest*');
  const inputRedirectCompletions = [];
  let redirectedInputFetched = false;
  await page.route('**/_crysviz/manifest/input-redirect*', async (route) => {
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
  await page.waitForTimeout(1200);
  H.check('input redirect is rejected without a successful load',
    redirectedInputFetched && inputRedirectCompletions.length === 1 && inputRedirectCompletions[0].ok === false);

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
  await H.finish(browser);
})().catch(H.crash);
