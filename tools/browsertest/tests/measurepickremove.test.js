// Measuring: clicking an atom already picked for the measurement being made
// takes it out again (docs/data/measureInfo.md), and its glow with it; see
// ui/SceneInteraction.js onClickPick.
//
//   - Distance: pick A, click A again → nothing picked, nothing glows, no preview
//   - Distance: A, B still measures (and clears the picks)
//   - another periodic image of a picked atom is added, not removed
//   - a double-click counts as one click: on A it picks A, on picked A it drops
//     it, on the atom that finishes a distance it does not start the next one
//   - a touch double-tap the same (its second tap must not undo the first),
//     also when the second tap is handled late behind a slow frame
//   - Angle: A, B, click B again → only A left (and glowing); then C, D
//     measures the angle A–C–D, vertex C
//
// Each check waits for the state it expects rather than for a fixed time, and
// a double-tap's two taps go out in one page task: see doubleTap below.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  // Every visible instance's screen point, where a click really hits it.
  const pickable = () => page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, groups, fileBrowser } = await import('./state/store.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const rect = app.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    const out = [];
    for (let i = 0; i < w.cart.length; i++) {
      const p = new THREE.Vector3(...w.cart[i]).project(app.camera);
      if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) continue;
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), app.camera);
      const hit = ray.intersectObject(groups.atomsMesh)[0];
      if (hit?.instanceId !== i) continue;
      const x = rect.left + (p.x + 1) / 2 * rect.width, y = rect.top + (1 - p.y) / 2 * rect.height;
      if (document.elementFromPoint(x, y) !== app.renderer.domElement) continue; // under a window
      out.push({ i, src: w.srcIndex[i], x, y });
    }
    return out;
  });
  const state = () => page.evaluate(async () => {
    const { app, measurements, highlightHover, groups } = await import('./state/store.js');
    const glow = groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity;
    const glowing = [];
    for (let i = 0; i < groups.atomsMesh.count; i++) if (glow.getX(i) > 0) glowing.push(i);
    const angle = measurements.measureLines.find((l) => l.userData?.type === 'angle')?.userData;
    return {
      picked: measurements.selectedAtoms.map((a) => a.userData.instanceId),
      highlighted: [...(highlightHover.currentlyHighlightedAtomInstances ?? [])],
      glowing,
      measured: measurements.measureLabels.length,
      // The picking prompt as the scene holds it: its element reaches the DOM
      // only with the next rendered frame.
      preview: app.scene.children.filter((o) => o.element?.classList?.contains('measure-label-preview'))
        .map((o) => o.element.textContent),
      angle: angle ? [angle.atom1Ref?.atomIndex, angle.atom2Ref?.atomIndex, angle.atom3Ref?.atomIndex] : null,
    };
  });
  // The picks and the glow change inside the click's own handler, so the
  // state is normally there at once; polling only absorbs a slow page.
  const expectState = async (name, pred, extra = {}) => {
    let s = await state();
    for (const deadline = Date.now() + 5000; !pred(s) && Date.now() < deadline;) {
      await page.waitForTimeout(100);
      s = await state();
    }
    H.check(name, pred(s), JSON.stringify({ ...extra, ...s }));
    return s;
  };
  // Playwright gives every mouse.click a click count of 1 and dblclick 1 then
  // 2, so event.detail — what tells a double-click apart — needs no pacing.
  const click = (spot) => page.mouse.click(spot.x, spot.y);
  // A touch double-tap: two taps, each the canvas' own touch pointerdown +
  // pointerup as GestureArbiter/SceneInteraction see one (no click follows a
  // synthetic one), sent in ONE page task. Sent as two evaluates, the taps were
  // as far apart as the driver's round trip, which on a loaded machine passed
  // DOUBLE_TAP_MS (300 ms): the second then counted as a tap of its own and
  // undid the first (flaky "picks A (once)" / "drops it").
  // stallMs: block the page that long between the taps — a slow frame. The
  // events are made first, so the second tap carries the time it happened and
  // is handled late, as a real one queued behind the frame is.
  const doubleTap = (spot, pointerId, stallMs = 0) => page.evaluate(async ({ x, y, pointerId, stallMs }) => {
    const { app } = await import('./state/store.js');
    const canvas = app.renderer.domElement;
    const events = [pointerId, pointerId, pointerId + 1, pointerId + 1].map((id, k) => new PointerEvent(
      k % 2 ? 'pointerup' : 'pointerdown', {
        bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: k % 2 ? 0 : 1,
      }));
    // A synthetic pointer holds no capture to set or release (gesturearbiter.test.js).
    const { setPointerCapture, releasePointerCapture } = canvas;
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const handledAt = [];
    try {
      events.forEach((ev, k) => {
        if (k === 2) for (const end = performance.now() + stallMs; performance.now() < end;) { /* the slow frame */ }
        canvas.dispatchEvent(ev);
        if (k % 2) handledAt.push(performance.now());
      });
    } finally {
      canvas.setPointerCapture = setPointerCapture;
      canvas.releasePointerCapture = releasePointerCapture;
    }
    return {
      tapGapMs: Math.round(events[3].timeStamp - events[1].timeStamp),
      handledGapMs: Math.round(handledAt[1] - handledAt[0]),
    };
  }, { x: spot.x, y: spot.y, pointerId, stallMs });

  const spots = await pickable();
  const bySrc = new Map();
  for (const s of spots) if (!bySrc.has(s.src)) bySrc.set(s.src, s);
  const distinct = [...bySrc.values()];
  H.check('enough atoms to click', distinct.length >= 4, String(distinct.length));
  const [A, B, C, D] = distinct;
  // Two rendered images of one source atom, if the view has any.
  const twin = spots.find((s) => spots.some((t) => t.src === s.src && t.i !== s.i));
  const twinOther = twin && spots.find((t) => t.src === twin.src && t.i !== twin.i);

  // ---- Distance: pick A, click A again ------------------------------------------------
  await H.clickById(page, 'distanceModeBtn');
  await click(A);
  let s = await expectState('Distance: A picked, glowing, with its preview',
    (s) => s.picked.length === 1 && s.picked[0] === A.i && s.glowing.includes(A.i) && s.preview.length === 1);
  await click(A);
  s = await expectState('clicking A again removes it: nothing picked, nothing glows, no preview',
    (s) => s.picked.length === 0 && s.highlighted.length === 0 && s.glowing.length === 0 && s.preview.length === 0 && s.measured === 0);

  // ---- Distance: A, B still measures -------------------------------------------------
  await click(A);
  await click(B);
  s = await expectState('A then B measures a distance and clears the picks',
    (s) => s.measured === 1 && s.picked.length === 0 && s.glowing.length === 0);

  // ---- another periodic image of a picked atom is added --------------------------------
  if (twin) {
    await click(twin);
    await click(twinOther);
    s = await expectState('another image of the picked atom is added (a distance to its own image)',
      (s) => s.measured === 2 && s.picked.length === 0, { twin, twinOther });
  } else {
    console.log('  (no atom with two clickable images in this view; image check skipped)');
  }
  const measuredBefore = s.measured;

  // ---- a double-click counts as one click ------------------------------------------------
  await page.mouse.dblclick(A.x, A.y);
  s = await expectState('double-click on A picks A (once)',
    (s) => s.picked.length === 1 && s.picked[0] === A.i && s.glowing.includes(A.i));
  await page.mouse.dblclick(A.x, A.y);
  s = await expectState('double-click on picked A drops it (not dropped and re-picked)',
    (s) => s.picked.length === 0 && s.glowing.length === 0 && s.measured === measuredBefore);
  // The double-click that finishes a distance: its second click used to start
  // the next measurement on that atom.
  await click(A);
  await page.mouse.dblclick(B.x, B.y);
  s = await expectState('a double-click on the second atom measures once and leaves nothing picked',
    (s) => s.measured === measuredBefore + 1 && s.picked.length === 0 && s.glowing.length === 0);
  const measuredNow = s.measured;

  // ---- a touch double-tap the same ----------------------------------------------------------
  // (A double-tap ends by clearing the app's last tap, so the second pair
  // cannot pair with the first however soon it follows.)
  let gap = await doubleTap(A, 801);
  s = await expectState('touch double-tap on A picks A (once)',
    (s) => s.picked.length === 1 && s.picked[0] === A.i, gap);
  gap = await doubleTap(A, 803);
  s = await expectState('touch double-tap on picked A drops it (not dropped and re-picked)',
    (s) => s.picked.length === 0 && s.glowing.length === 0 && s.measured === measuredNow, gap);
  // The window is judged by when the taps happened, not when they were
  // handled: a second tap held up 400 ms by a slow frame is still the same
  // double-tap (judged by handling time it missed the 300 ms window, and its
  // pick undid the first tap's).
  gap = await doubleTap(A, 805, 400);
  s = await expectState('a double-tap whose second tap waits out a 400 ms frame still picks A once',
    (s) => s.picked.length === 1 && s.picked[0] === A.i, gap);
  gap = await doubleTap(A, 807, 400);
  s = await expectState('… and on picked A still drops it once',
    (s) => s.picked.length === 0 && s.measured === measuredNow, gap);
  // A minimum, not a guess at how long something takes: the app drops a mouse
  // click within 400 ms of a touch (GHOST_CLICK_DELAY, the synthetic click a
  // real tap is followed by), and the next section clicks.
  await page.waitForTimeout(600);

  // ---- Angle: A, B, click B again, then C, D ------------------------------------------------
  await H.clickById(page, 'angleModeBtn');
  await click(A);
  await click(B);
  await expectState('Angle: A and B picked and glowing',
    (s) => s.picked.join() === `${A.i},${B.i}` && s.glowing.includes(A.i) && s.glowing.includes(B.i));
  await click(B);
  await expectState('clicking B again leaves A alone picked and glowing, B dark, the preview asks for the vertex',
    (s) => s.picked.join() === `${A.i}` && s.glowing.includes(A.i) && !s.glowing.includes(B.i)
      && s.preview.length === 1 && /select vertex/.test(s.preview[0]));
  await click(C);
  await click(D);
  await expectState('then C, D measures the angle A–C–D (vertex C) and clears the picks',
    (s) => s.measured === measuredNow + 1 && JSON.stringify(s.angle) === JSON.stringify([A.src, C.src, D.src])
      && s.picked.length === 0 && s.glowing.length === 0,
    { A: A.src, C: C.src, D: D.src });

  await H.clickById(page, 'angleModeBtn');
  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
