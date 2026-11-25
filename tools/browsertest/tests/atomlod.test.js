// Atom level of detail (render/AtomLodModule.js): imposter atoms must draw,
// pick and occlude like the tessellated spheres they replace, and the
// view-dependent near-sphere set must follow the camera — real spheres for
// the atoms that are large on screen, none when everything is small.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const res = await page.evaluate(async () => {
    const { app, general, groups } = await import('./state/store.js');
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { renderFrameNow, atomLodStats } = await import('./render/index.js');
    const THREE = await import('./external/three/three.module.js');

    const settle = () => new Promise((r) => setTimeout(r, 400));
    const out = {};

    createSupercell(3, 3, 3);
    await settle();

    // Reference picking through the sphere mesh: the centre-of-screen ray.
    const ray = new THREE.Raycaster();
    const pick = () => {
      ray.setFromCamera(new THREE.Vector2(0, 0), app.camera);
      const hit = ray.intersectObject(groups.atomsMesh)[0];
      return hit ? { id: hit.instanceId, d: hit.distance } : null;
    };
    out.sphereMode = groups.atomsMesh.userData.imposter === false;
    out.sphereInstances = groups.atomsMesh.count;
    const spherePick = pick();

    // Switch to imposters through the setting the Visual panel drives.
    general.atomDetail = 'imposters';
    updateVisualization({ reRenderAtoms: true, reRenderBonds: false });
    await settle();
    const mesh = groups.atomsMesh;
    out.imposterMode = mesh.userData.imposter === true;
    out.quad = mesh.geometry.attributes.position.count === 4 && mesh.geometry.index.count === 6;
    out.instances = mesh.count;
    out.sameCount = mesh.count === out.sphereInstances;
    out.hasNear = !!mesh.userData.nearSpheres && mesh.userData.nearSpheres.parent === mesh;
    // Every instance buffer the rest of the app writes into is still there.
    out.attrs = ['instanceUUID', 'instanceElementIndex', 'instanceEmissive', 'instanceOpacity', 'instanceCutPlaneImmune']
      .every((name) => !!mesh.geometry.attributes[name]);

    // Picking: the analytic raycast must find the same atom the sphere mesh did.
    const imposterPick = pick();
    out.pick = { spherePick, imposterPick,
      same: !!spherePick && !!imposterPick && spherePick.id === imposterPick.id
        && Math.abs(spherePick.d - imposterPick.d) < 0.05 };

    // Zoomed out (the whole supercell fits): no atom is large on screen.
    renderFrameNow();
    await settle();
    renderFrameNow();
    const far = atomLodStats();
    out.far = { mode: far.mode, near: far.near, instances: far.instances, computeMs: far.computeMs };

    // Zoom in: move the camera to a few Å from the nearest atom along the
    // view ray — a handful of atoms now project larger than the threshold.
    // (The default camera is orthographic: distance does not scale atoms
    // there, the zoom factor does. A perspective camera moves in instead.)
    if (app.camera.isOrthographicCamera) {
      app.camera.zoom *= 12;
    } else {
      const target = imposterPick
        ? ray.ray.at(imposterPick.d, new THREE.Vector3())
        : new THREE.Vector3();
      const dir = app.camera.position.clone().sub(target).normalize();
      app.camera.position.copy(target).add(dir.multiplyScalar(6));
      app.camera.lookAt(target);
    }
    app.camera.updateMatrixWorld();
    app.camera.updateProjectionMatrix();
    renderFrameNow();
    await settle();
    renderFrameNow();
    const near = atomLodStats();
    out.near = { near: near.near, cap: near.nearCap, overflow: near.overflow, computeMs: near.computeMs };
    const nearMesh = mesh.userData.nearSpheres;
    out.nearMeshCount = nearMesh.count;
    // The near copies must be the main mesh's own instances: same matrix.
    let copyErr = 0;
    for (let j = 0; j < nearMesh.count; j++) {
      const i = nearMesh.userData.slotOf[j];
      for (let k = 0; k < 16; k++) {
        copyErr = Math.max(copyErr, Math.abs(nearMesh.instanceMatrix.array[j * 16 + k] - mesh.instanceMatrix.array[i * 16 + k]));
      }
    }
    out.copyErr = copyErr;
    out.lodNear = mesh.material.userData.lodNear;

    // Restore the zoom before the remaining mode switches (the screenshot
    // below zooms back in on its own).
    if (app.camera.isOrthographicCamera) { app.camera.zoom /= 12; app.camera.updateProjectionMatrix(); }

    // Back to spheres: the near child goes, the sphere geometry returns.
    general.atomDetail = 'spheres';
    updateVisualization({ reRenderAtoms: true, reRenderBonds: false });
    await settle();
    out.backToSpheres = groups.atomsMesh.userData.imposter === false
      && !groups.atomsMesh.userData.nearSpheres
      && groups.atomsMesh.geometry.attributes.position.count > 4;

    // 'auto' threshold: a structure above atomDetailImposterMin gets imposters.
    general.atomDetail = 'auto';
    general.atomDetailImposterMin = 100;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: false });
    await settle();
    out.autoImposters = groups.atomsMesh.userData.imposter === true;
    general.atomDetailImposterMin = 20000;
    return out;
  });

  console.log(`  ${res.instances} instances; far near=${res.far.near}, zoomed-in near=${res.near.near}/${res.near.cap}`);
  H.check('starts in sphere mode for a small structure', res.sphereMode);
  H.check('imposter mode: quad geometry, same instance count, near child present',
    res.imposterMode && res.quad && res.sameCount && res.hasNear, JSON.stringify({ quad: res.quad, sameCount: res.sameCount, hasNear: res.hasNear }));
  H.check('imposter mesh keeps every instance attribute', res.attrs);
  H.check('analytic raycast picks the same atom at the same distance', res.pick.same, JSON.stringify(res.pick));
  H.check('zoomed out: every atom is an imposter (no near spheres)', res.far.mode === 'imposters' && res.far.near === 0, JSON.stringify(res.far));
  H.check('zoomed in: some atoms are drawn as real spheres', res.near.near > 0 && res.nearMeshCount === res.near.near && !res.near.overflow, JSON.stringify(res.near));
  H.check('near spheres copy their instances exactly', res.copyErr === 0, `max err ${res.copyErr}`);
  H.check('the shader threshold is set while near spheres exist', res.lodNear > 0, String(res.lodNear));
  H.check('switching back to spheres removes the near child', res.backToSpheres);
  H.check('auto picks imposters above the instance threshold', res.autoImposters);

  // Pixels: an imposter scene must actually draw atoms (not a blank canvas).
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { recenterCamera } = await import('./ui/WindowAndSceneControls.js').catch(() => ({}));
    general.atomDetail = 'imposters';
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    if (typeof recenterCamera === 'function') recenterCamera();
  });
  await page.waitForTimeout(800);
  const shot = await H.shotCanvas(page, 'atomlod-imposters');
  const drawn = H.nonUniformFraction(shot);
  H.check('imposters render visible atoms', drawn > 0.05, `non-uniform fraction ${drawn.toFixed(3)}`);

  // Zoomed in: near spheres and imposters side by side must still draw.
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { renderFrameNow } = await import('./render/index.js');
    if (app.camera.isOrthographicCamera) { app.camera.zoom *= 12; app.camera.updateProjectionMatrix(); }
    renderFrameNow();
  });
  await page.waitForTimeout(800);
  const zoomShot = await H.shotCanvas(page, 'atomlod-zoomed');
  const zoomDrawn = H.nonUniformFraction(zoomShot);
  H.check('zoomed-in mix of near spheres and imposters renders', zoomDrawn > 0.05, `non-uniform fraction ${zoomDrawn.toFixed(3)}`);

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
