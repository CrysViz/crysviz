// Asymmetric unit / "irreducible wedge" (ui/BackendPanel/asuGeometry.js,
// render/AsymmetricUnitModule.js, the Symmetry panel's card).
//
// The centrepiece is the all-settings invariant sweep: every one of the 527
// space-group settings in data/symmetry_basics.json is turned into a
// polyhedron and checked against four things that are true of a correct
// asymmetric unit and would each break differently if the half-space
// intersection were wrong.
//
//   volume == 1/n_symops   the wedge is exactly the fraction of the cell the
//                          symmetry operations tile it into. Catches a sign or
//                          offset-convention error, which a merely plausible
//                          shape would hide.
//   closed surface         every edge shared by exactly two faces. Catches a
//                          missed vertex (which opens a hole).
//   V - E + F == 2         catches spurious extra vertices, which a volume
//                          check alone can miss.
//   outward winding        every triangle's normal points away from the body,
//                          so the hull shades as a solid rather than inside-out.
//
// The other half is the symmetrise-first rule: a conventional cell is in
// general rotated and axis-permuted relative to the loaded one, so the button
// transforms the structure into the conventional cell BEFORE drawing. The
// wedge must therefore always end up in the same frame as the cell on screen
// (no context box, no note), and asking for it twice must not pile up
// duplicate structures.
'use strict';
const H = require('../harness');

async function openSymmetry(page) {
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('symmetry');
  });
  await page.waitForTimeout(1500); // wasm init + rebuild of the panel body
}

// The button's handler fetches the 8.9 MB dataset on first use, so the wedge
// appears well after the click returns.
async function waitForWedge(page, wanted) {
  return H.waitFor(page, `(async () => {
    const { groups } = await import('./state/store.js');
    return ${wanted ? '!!groups.asuGroup' : '!groups.asuGroup'};
  })()`, { timeout: 60000, interval: 500 });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await openSymmetry(page);

  // --- the card is there ------------------------------------------------
  const card = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('#cvPanelBody-symmetry .sym-card-title')]
      .map((t) => t.textContent.trim());
    const btn = document.getElementById('showAsuBtn');
    return {
      titles,
      label: btn?.textContent.trim(),
      resultHidden: document.getElementById('asuResult')?.hidden,
    };
  });
  H.check('Symmetry panel has an "Asymmetric unit" card',
    card.titles.includes('Asymmetric unit'), card.titles.join(' | '));
  H.check('its button starts on "Show Asymmetric Unit"',
    card.label === 'Show Asymmetric Unit', card.label);
  H.check('the result block starts hidden', card.resultHidden === true);

  const blank = await H.shotCanvas(page, 'asu_off');

  // --- switching it on ---------------------------------------------------
  await H.clickById(page, 'showAsuBtn');
  const appeared = await waitForWedge(page, true);
  H.check('clicking the button puts a wedge group in the scene', appeared);

  const shown = await page.evaluate(async () => {
    const { groups, app } = await import('./state/store.js');
    const render = await import('./render/index.js');
    const group = groups.asuGroup;
    let meshes = 0;
    let triangles = 0;
    group?.traverse((o) => {
      if (!o.isMesh) return;
      meshes += 1;
      const pos = o.geometry?.getAttribute?.('position');
      if (o.geometry?.type === 'BufferGeometry' && pos && !o.geometry.index) {
        triangles += pos.count / 3;
      }
    });
    const box = document.getElementById('asuResult');
    return {
      inScene: !!group && app.scene.children.includes(group),
      meshes,
      triangles,
      visible: render.isAsymmetricUnitVisible(),
      needsCellBox: render.asymmetricUnitNeedsCellBox(),
      label: document.getElementById('showAsuBtn').textContent.trim(),
      active: document.getElementById('showAsuBtn').classList.contains('sym-btn-active'),
      boxHidden: box.hidden,
      boxText: box.textContent.replace(/\s+/g, ' ').trim(),
      // The wedge hull's own colour must be the theme's --asu-color, not a
      // hardcoded one — that is the whole point of routing it through
      // ThemeManager (STYLE.md's rule: no colour outside docs/themes/).
      token: getComputedStyle(document.documentElement)
        .getPropertyValue('--asu-color').trim(),
      hullHex: (() => {
        let hex = null;
        group?.traverse((o) => {
          if (o.isMesh && o.material?.type === 'MeshStandardMaterial' && !hex) {
            hex = '#' + o.material.color.getHexString();
          }
        });
        return hex;
      })(),
      hasNote: !!box.querySelector('.sym-asu-note'),
      status: document.getElementById('calcResult').textContent.trim(),
      rows: document.querySelectorAll('#objectTable tbody tr').length,
    };
  });

  H.check('the wedge group is attached to the scene', shown.inScene);
  H.check('it holds a triangulated hull plus outline cylinders',
    shown.meshes > 1 && shown.triangles >= 4,
    `${shown.meshes} meshes, ${shown.triangles} hull triangles`);
  H.check('isAsymmetricUnitVisible() agrees', shown.visible === true);
  H.check('the button flips to "Hide Asymmetric Unit" and marks itself active',
    shown.label === 'Hide Asymmetric Unit' && shown.active,
    `${shown.label} / active=${shown.active}`);
  H.check('the hull is painted the theme\'s --asu-color',
    !!shown.token && shown.hullHex === shown.token.toLowerCase(),
    `token ${shown.token} vs hull ${shown.hullHex}`);

  // --- what the panel says ----------------------------------------------
  H.check('the result block reports the wedge as a fraction of the cell',
    /1\/\d+ of the cell/.test(shown.boxText), shown.boxText.slice(0, 160));
  H.check('it prints both condition strings',
    shown.boxText.includes('Asymmetric unit')
    && shown.boxText.includes('Shape only (drawn)'),
    shown.boxText.slice(0, 200));
  // The conditions are inequalities: "<=" reaching the DOM as text (rather
  // than being swallowed as a bogus tag) is the escaping working.
  H.check('the inequalities survive escaping into the DOM',
    /[<>]=/.test(shown.boxText), shown.boxText.slice(0, 200));
  H.check('the conventional-cell note appears exactly when the cell box does',
    shown.hasNote === shown.needsCellBox,
    `note=${shown.hasNote} cellBox=${shown.needsCellBox}`);
  // YBCO's conventional cell has a and b swapped (moyo sorts Pmmm's axes), so
  // this is a structure that DID need transforming — and having been
  // transformed, it must need no context box at all.
  H.check('YBCO is symmetrised first, so the wedge shares the frame on screen',
    shown.needsCellBox === false && shown.hasNote === false,
    `cellBox=${shown.needsCellBox} note=${shown.hasNote}`);
  H.check('and the status line says the structure was symmetrised',
    /symmetris/i.test(shown.status), shown.status);

  // --- it actually changes pixels ---------------------------------------
  const withWedge = await H.shotCanvas(page, 'asu_on');
  const before = H.nonUniformFraction(blank);
  const after = H.nonUniformFraction(withWedge);
  H.check('the wedge draws something on the canvas', after > before,
    `drawn fraction ${before.toFixed(4)} -> ${after.toFixed(4)}`);

  // --- switching it off --------------------------------------------------
  await H.clickById(page, 'showAsuBtn');
  const cleared = await waitForWedge(page, false);
  const off = await page.evaluate(async () => {
    const render = await import('./render/index.js');
    const box = document.getElementById('asuResult');
    return {
      visible: render.isAsymmetricUnitVisible(),
      label: document.getElementById('showAsuBtn').textContent.trim(),
      boxHidden: box.hidden,
      boxEmpty: box.innerHTML.trim() === '',
    };
  });
  H.check('clicking again removes the group from the scene', cleared);
  H.check('and resets the button and result block',
    !off.visible && off.label === 'Show Asymmetric Unit' && off.boxHidden && off.boxEmpty,
    JSON.stringify(off));

  // --- a wedge must not outlive the structure it describes ---------------
  await H.clickById(page, 'showAsuBtn');
  await waitForWedge(page, true);
  await H.loadDefaultStructure(page, 'defaultPOSCAR5', 'Si primitive');
  const afterSwitch = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    cv.updateVisualization({});
    const render = await import('./render/index.js');
    return { group: !!groups.asuGroup, visible: render.isAsymmetricUnitVisible() };
  });
  H.check('loading another structure drops the previous structure\'s wedge',
    !afterSwitch.group && !afterSwitch.visible, JSON.stringify(afterSwitch));

  // --- a primitive cell: symmetrised, then the wedge --------------------
  // Si diamond primitive is the case the symmetrise-first rule exists for.
  // Its own cell is not the cell the wedge is defined in, and the difference
  // is not a subtle one: the conventional cell is a 5.43 A cube holding 8
  // atoms, the primitive one a rhombohedron holding 2.
  const beforeRows = await page.evaluate(
    () => document.querySelectorAll('#objectTable tbody tr').length
  );
  const primitiveAtoms = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.selectedStructure.atoms.length;
  });
  H.check('the loaded Si cell is the primitive one (2 atoms)',
    primitiveAtoms === 2, `${primitiveAtoms} atoms`);

  await H.clickById(page, 'showAsuBtn');
  await waitForWedge(page, true);
  const primitive = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const render = await import('./render/index.js');
    let cylinders = 0;
    groups.asuGroup?.traverse((o) => {
      if (o.isMesh && o.geometry?.type === 'CylinderGeometry') cylinders += 1;
    });
    const box = document.getElementById('asuResult');
    const s = fileBrowser.selectedStructure;
    return {
      needsCellBox: render.asymmetricUnitNeedsCellBox(),
      hasNote: !!box.querySelector('.sym-asu-note'),
      cylinders,
      atoms: s.atoms.length,
      // The conventional Si cell is cubic with a = 5.43; the primitive one has
      // no zero off-diagonal at all, so this tells them apart outright.
      lattice: s.lattice.map((r) => r.map((v) => +v.toFixed(3))),
      rows: document.querySelectorAll('#objectTable tbody tr').length,
      name: fileBrowser.fileData[fileBrowser.selectedRowIndex]?.name ?? '',
      status: document.getElementById('calcResult').textContent.trim(),
      text: box.textContent.replace(/\s+/g, ' ').trim(),
    };
  });

  H.check('asking for the wedge symmetrises the primitive cell first',
    primitive.atoms === 8 && primitive.rows === beforeRows + 1,
    `${primitive.atoms} atoms, ${beforeRows} -> ${primitive.rows} rows`);
  H.check('the new structure is the conventional 5.43 A cube',
    JSON.stringify(primitive.lattice)
      === JSON.stringify([[5.43, 0, 0], [0, 5.43, 0], [0, 0, 5.43]]),
    JSON.stringify(primitive.lattice));
  H.check('it is committed under a visible sym_conv_ name, not swapped in silently',
    primitive.name.startsWith('sym_conv_'), primitive.name);
  H.check('and the status line says so', /symmetris/i.test(primitive.status),
    primitive.status);
  // The whole point of transforming: the wedge and the cell on screen are now
  // the same frame, so there is nothing to disambiguate.
  H.check('the wedge needs no context box once the frames agree',
    primitive.needsCellBox === false && primitive.hasNote === false
    && primitive.cylinders < 12,
    `cellBox=${primitive.needsCellBox} note=${primitive.hasNote} `
    + `cylinders=${primitive.cylinders}`);
  // Fd-3m has 192 operations in its conventional cell. Reporting 1/192 rather
  // than 1/48 is the load-bearing consequence of using the conventional cell.
  H.check('the wedge is 1/192 of the conventional cell, not of the primitive one',
    primitive.text.includes('1/192 of the cell'), primitive.text.slice(0, 160));

  // --- asking twice must not pile up structures -------------------------
  await H.clickById(page, 'showAsuBtn');   // hide
  await waitForWedge(page, false);
  await H.clickById(page, 'showAsuBtn');   // show again
  await waitForWedge(page, true);
  const twice = await page.evaluate(async () => {
    const render = await import('./render/index.js');
    return {
      rows: document.querySelectorAll('#objectTable tbody tr').length,
      visible: render.isAsymmetricUnitVisible(),
      status: document.getElementById('calcResult').textContent.trim(),
    };
  });
  H.check('a structure that is already conventional is not symmetrised again',
    twice.rows === primitive.rows && twice.visible,
    `${primitive.rows} -> ${twice.rows} rows, visible=${twice.visible}`);
  H.check('and the second time says nothing about symmetrising',
    !/symmetris/i.test(twice.status), twice.status);

  // --- colour picker and opacity slider ---------------------------------
  // Both must repaint what is already drawn rather than rebuild it: a slider
  // drag emits a change per pixel of travel.
  const painted = await page.evaluate(async () => {
    const { groups, general } = await import('./state/store.js');
    const render = await import('./render/index.js');

    const hull = () => {
      let mesh = null;
      groups.asuGroup?.traverse((o) => {
        if (o.isMesh && o.material?.type === 'MeshStandardMaterial' && !mesh) mesh = o;
      });
      return mesh;
    };
    const before = { group: groups.asuGroup, geometry: hull()?.geometry };

    general.asuColor = '#22cc88';
    general.asuColorUserSet = true;
    general.asuOpacity = 0.7;
    render.refreshAsuAppearance();

    const after = hull();
    // Every part of the wedge takes the colour, not just the hull.
    let allTinted = true;
    groups.asuGroup?.traverse((o) => {
      if (o.isMesh && '#' + o.material.color.getHexString() !== '#22cc88') allTinted = false;
    });

    return {
      hullHex: '#' + after.material.color.getHexString(),
      hullOpacity: after.material.opacity,
      transparent: after.material.transparent,
      allTinted,
      sameGroup: groups.asuGroup === before.group,
      sameGeometry: after.geometry === before.geometry,
    };
  });
  H.check('the colour picker repaints the whole wedge',
    painted.hullHex === '#22cc88' && painted.allTinted,
    `${painted.hullHex} allTinted=${painted.allTinted}`);
  H.check('the opacity slider reaches the hull material through the pipeline policy',
    painted.hullOpacity === 0.7 && painted.transparent === true,
    `opacity=${painted.hullOpacity} transparent=${painted.transparent}`);
  H.check('neither rebuilds geometry',
    painted.sameGroup && painted.sameGeometry,
    `group=${painted.sameGroup} geometry=${painted.sameGeometry}`);

  // A hand-picked colour must outrank the palette's on a theme change.
  const themed = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const tm = await import('./ui/ThemeManager.js');
    tm.applySceneFromCSS();
    const pinned = general.asuColor;
    general.asuColorUserSet = false;   // what the picker's Reset does
    tm.applySceneFromCSS();
    return { pinned, released: general.asuColor };
  });
  H.check('a hand-picked wedge colour survives a theme re-read',
    themed.pinned === '#22cc88', themed.pinned);
  H.check('and Reset hands it back to the palette',
    themed.released === '#a05cd6', themed.released);

  // --- highlighting the atoms inside the wedge --------------------------
  const offState = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const render = await import('./render/index.js');
    return {
      on: render.isAsuAtomHighlightOn(),
      mesh: !!groups.asuHaloMesh,
      counts: render.asuAtomsInside(),
    };
  });
  H.check('the highlight is off by default and computes nothing',
    !offState.on && !offState.mesh && offState.counts.instances === 0,
    JSON.stringify(offState));

  const highlighted = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const math = await import('./math/index.js');
    const geom = await import('./ui/BackendPanel/asuGeometry.js');
    const wyck = await import('./ui/addToStructureModule/WyckoffProjector.js');
    const render = await import('./render/index.js');

    document.getElementById('asuHighlightChk').click();

    const structure = fileBrowser.selectedStructure;
    const cart = structure.periodic.visibleWrapped.cart;

    // Independent recomputation, from the dataset rather than from anything
    // the module cached: this is what checks the plumbing between the wedge's
    // inequalities, the conventional lattice and the drawn instances. The
    // Hall number is read back from the panel rather than assumed — Fd-3m has
    // two origin choices with genuinely different wedges (525 wants y<=1/8,
    // 526 wants y<=0), and picking the wrong one silently tests nothing.
    const hall = Number(document.getElementById('asuResult').dataset.hallNumber);
    const entry = wyck.getSpaceGroupEntryByHallNumber(hall);
    const halfSpaces = geom.halfSpacesFromCuts(entry.asu.shape_only_cuts);
    const toFrac = math.invert3x3(math.transpose3x3(structure.lattice));

    // Same lattice-translation search the module does: this wedge lies at
    // y <= 0 while the atoms are wrapped into [0,1), so a literal test finds
    // nothing and the feature would look broken.
    let expected = 0;
    const sources = new Set();
    let literal = 0;
    for (let i = 0; i < cart.length; i += 1) {
      const f = math.multiplyMatVec(toFrac, cart[i]);
      if (geom.containsFractional(halfSpaces, f[0], f[1], f[2])) literal += 1;
      let inside = false;
      for (let tx = -2; tx <= 2 && !inside; tx += 1) {
        for (let ty = -2; ty <= 2 && !inside; ty += 1) {
          for (let tz = -2; tz <= 2 && !inside; tz += 1) {
            inside = geom.containsFractional(halfSpaces, f[0] + tx, f[1] + ty, f[2] + tz);
          }
        }
      }
      if (!inside) continue;
      expected += 1;
      sources.add(structure.periodic.visibleWrapped.srcIndex?.[i] ?? i);
    }

    return {
      hall,
      counts: render.asuAtomsInside(),
      expectedInstances: expected,
      expectedAtoms: sources.size,
      literal,
      meshCount: groups.asuHaloMesh?.count ?? -1,
      backSide: groups.asuHaloMesh?.material?.side === 1, // THREE.BackSide
      haloAt: Array.from(groups.asuHaloMesh.instanceMatrix.array.slice(12, 15)),
      status: document.getElementById('calcResult').textContent.trim(),
      totalInstances: cart.length,
    };
  });
  H.check('turning it on rings exactly the instances the inequalities select',
    highlighted.counts.instances === highlighted.expectedInstances
    && highlighted.meshCount === highlighted.expectedInstances
    && highlighted.expectedInstances > 0,
    `mesh=${highlighted.meshCount} module=${highlighted.counts.instances} `
    + `independent=${highlighted.expectedInstances} of ${highlighted.totalInstances}`);
  // Fd-3m's origin-choice-2 wedge sits entirely at y <= 0 while these atoms
  // are wrapped into [0,1), so a literal test finds nothing. This is the case
  // that proves membership is tested modulo lattice translation — without it
  // the highlight would come up empty here and for ~40% of all settings.
  H.check('a wedge outside the [0,1) box still finds its atoms',
    highlighted.literal === 0 && highlighted.counts.instances > 0,
    `literal=${highlighted.literal} with-translation=${highlighted.counts.instances}`);
  // Si is one orbit on a special position, so its atom sits exactly ON the
  // wedge boundary — the case where an unpadded translation search rounds the
  // only matching translation away and silently finds nothing.
  H.check('Si diamond has exactly one atom in its asymmetric unit',
    highlighted.counts.atoms === 1, `${highlighted.counts.atoms} atoms`);
  H.check('and counts distinct atoms, not their periodic images',
    highlighted.counts.atoms === highlighted.expectedAtoms
    && highlighted.counts.atoms <= highlighted.counts.instances,
    `${highlighted.counts.atoms} atoms / ${highlighted.counts.instances} instances`);
  H.check('the halo is a back-faced shell, so it reads as a ring not a bag',
    highlighted.backSide === true);
  H.check('the panel reports how many atoms are inside',
    /\d+ atoms? inside the wedge/.test(highlighted.status), highlighted.status);

  // Atom positions change — under MD, or an edit. The wedge stays put and the
  // membership has to follow it.
  const afterMove = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    const math = await import('./math/index.js');
    const geom = await import('./ui/BackendPanel/asuGeometry.js');
    const wyck = await import('./ui/addToStructureModule/WyckoffProjector.js');
    const render = await import('./render/index.js');

    // Shift every atom along x by a half cell. Deliberately NOT one of the
    // fcc centring translations ((0,1/2,1/2) and friends): those map diamond
    // onto itself, so the membership would rightly not budge and the check
    // would prove nothing.
    // Replace the array rather than writing into it: Structure.js deep-freezes
    // the snapshot it takes of the atoms, and its shallow copy shares each
    // atom's `position` array, so an in-place element write silently no-ops.
    const structure = fileBrowser.selectedStructure;
    for (const atom of structure.atoms) {
      atom.position = [(atom.position[0] + 0.5) % 1, atom.position[1], atom.position[2]];
    }
    cv.updateVisualization({ reRenderAtoms: true, reRenderBonds: true });

    const hall = Number(document.getElementById('asuResult').dataset.hallNumber);
    const halfSpaces = geom.halfSpacesFromCuts(
      wyck.getSpaceGroupEntryByHallNumber(hall).asu.shape_only_cuts
    );
    const cart = structure.periodic.visibleWrapped.cart;
    const toFrac = math.invert3x3(math.transpose3x3(structure.lattice));
    let expected = 0;
    for (let i = 0; i < cart.length; i += 1) {
      const f = math.multiplyMatVec(toFrac, cart[i]);
      let inside = false;
      for (let tx = -2; tx <= 2 && !inside; tx += 1) {
        for (let ty = -2; ty <= 2 && !inside; ty += 1) {
          for (let tz = -2; tz <= 2 && !inside; tz += 1) {
            inside = geom.containsFractional(halfSpaces, f[0] + tx, f[1] + ty, f[2] + tz);
          }
        }
      }
      if (inside) expected += 1;
    }
    return {
      counts: render.asuAtomsInside(),
      meshCount: groups.asuHaloMesh?.count ?? -1,
      expected,
      haloAt: Array.from(groups.asuHaloMesh.instanceMatrix.array.slice(12, 15)),
    };
  });
  H.check('membership still matches the inequalities once the atoms have moved',
    afterMove.counts.instances === afterMove.expected
    && afterMove.meshCount === afterMove.expected,
    `module ${afterMove.counts.instances} / independent ${afterMove.expected}`);
  // The count can legitimately come out the same — what proves the highlight
  // tracked the move is that the ring is drawn somewhere else.
  H.check('and the rings moved with them',
    afterMove.haloAt.some((v, i) => Math.abs(v - highlighted.haloAt[i]) > 1e-6),
    `${highlighted.haloAt.map((v) => v.toFixed(2))} -> `
    + `${afterMove.haloAt.map((v) => v.toFixed(2))}`);

  // The Wyckoff editor moves atoms without touching the cell, so it redraws
  // with reRenderLattice: false. The wedge geometry rightly does not rebuild
  // there — but the membership must still be re-asked, or the rings sit where
  // the atoms used to be and newly-entered atoms are never picked up.
  //
  // Compared against an independent recomputation rather than against "the
  // rings moved": on a structure this symmetric a shift can land a DIFFERENT
  // atom exactly where the old one was, so a stale highlight can look correct
  // by coincidence. The check also asserts the expected answer actually
  // differs from the pre-move one, so it reports itself inconclusive rather
  // than passing vacuously.
  const lattUntouched = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    const math = await import('./math/index.js');
    const geom = await import('./ui/BackendPanel/asuGeometry.js');
    const wyck = await import('./ui/addToStructureModule/WyckoffProjector.js');

    const halo = () => {
      const mesh = groups.asuHaloMesh;
      if (!mesh) return [];
      const out = [];
      for (let i = 0; i < mesh.count; i += 1) {
        out.push(Array.from(mesh.instanceMatrix.array.slice(i * 16 + 12, i * 16 + 15))
          .map((v) => +v.toFixed(4)).join(','));
      }
      return out.sort();
    };

    const before = halo();

    const structure = fileBrowser.selectedStructure;
    for (const atom of structure.atoms) {
      atom.position = [(atom.position[0] + 0.25) % 1, atom.position[1], atom.position[2]];
    }
    // Exactly the flags applyWyckoffOrbitPosition uses (SymmetryEditModule.js).
    cv.updateVisualization({
      reRenderAtoms: true, reRenderBonds: true, reRenderLattice: false,
    });

    const hall = Number(document.getElementById('asuResult').dataset.hallNumber);
    const halfSpaces = geom.halfSpacesFromCuts(
      wyck.getSpaceGroupEntryByHallNumber(hall).asu.shape_only_cuts
    );
    const cart = structure.periodic.visibleWrapped.cart;
    const toFrac = math.invert3x3(math.transpose3x3(structure.lattice));
    const expected = [];
    for (let i = 0; i < cart.length; i += 1) {
      const f = math.multiplyMatVec(toFrac, cart[i]);
      let inside = false;
      for (let tx = -2; tx <= 2 && !inside; tx += 1) {
        for (let ty = -2; ty <= 2 && !inside; ty += 1) {
          for (let tz = -2; tz <= 2 && !inside; tz += 1) {
            inside = geom.containsFractional(halfSpaces, f[0] + tx, f[1] + ty, f[2] + tz);
          }
        }
      }
      if (inside) expected.push(cart[i].map((v) => +v.toFixed(4)).join(','));
    }
    return { before, after: halo(), expected: expected.sort() };
  });

  H.check('the move actually changes which atoms the wedge holds (else inconclusive)',
    JSON.stringify(lattUntouched.expected) !== JSON.stringify(lattUntouched.before),
    `before ${JSON.stringify(lattUntouched.before)} expected ${JSON.stringify(lattUntouched.expected)}`);
  H.check('an atom move that leaves the cell alone still re-asks the membership',
    JSON.stringify(lattUntouched.after) === JSON.stringify(lattUntouched.expected),
    `rings ${JSON.stringify(lattUntouched.after)} vs `
    + `independent ${JSON.stringify(lattUntouched.expected)}`);

  // Hiding the wedge must take the halo with it — there is nothing to be
  // inside of any more.
  const afterHide = await page.evaluate(async () => {
    document.getElementById('showAsuBtn').click();
    const { groups } = await import('./state/store.js');
    const render = await import('./render/index.js');
    return {
      mesh: !!groups.asuHaloMesh,
      counts: render.asuAtomsInside(),
      stillOn: render.isAsuAtomHighlightOn(),
    };
  });
  H.check('hiding the wedge drops the halo but remembers the toggle',
    !afterHide.mesh && afterHide.counts.instances === 0 && afterHide.stillOn,
    JSON.stringify(afterHide));

  // --- the rings only go where an atom is actually drawn ----------------
  await H.clickById(page, 'showAsuBtn');
  await waitForWedge(page, true);
  const ringGates = await page.evaluate(async () => {
    const { groups, general } = await import('./state/store.js');
    const render = await import('./render/index.js');
    const { CutModes } = await import('./model/Plane.js');
    const count = () => render.asuAtomsInside().instances;
    const out = { base: count() };

    general.atomCutPlanes = [{ enabled: true, x: 1, y: 0, z: 0, r: -1000, side: CutModes.ALONGN }];
    render.updateAtomCutPlaneState();
    out.cut = count();
    general.atomCutPlanes = [];
    render.updateAtomCutPlaneState();
    out.uncut = count();

    const showAtoms = document.getElementById('showAtoms');
    showAtoms.checked = false;
    showAtoms.dispatchEvent(new Event('change'));
    out.atomsOff = count();
    showAtoms.checked = true;
    showAtoms.dispatchEvent(new Event('change'));
    out.atomsOn = count();

    const opacity = groups.atomsMesh.geometry.attributes.instanceOpacity;
    const saved = Array.from(opacity.array);
    opacity.array.fill(0.1);
    render.updateAsuAtomHighlight();
    out.faded = count();
    opacity.array.set(saved);
    render.updateAsuAtomHighlight();
    out.unfaded = count();
    return out;
  });
  H.check('cut-away atoms lose their rings, and get them back',
    ringGates.base > 0 && ringGates.cut === 0 && ringGates.uncut === ringGates.base,
    JSON.stringify(ringGates));
  H.check('"Show Atoms" off takes the rings with it',
    ringGates.atomsOff === 0 && ringGates.atomsOn === ringGates.base, JSON.stringify(ringGates));
  H.check('faded atoms (focus regions, per-atom alpha) are not ringed',
    ringGates.faded === 0 && ringGates.unfaded === ringGates.base, JSON.stringify(ringGates));

  // --- the SVG vector export carries the wedge and its rings -------------
  const svg = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, groups } = await import('./state/store.js');
    const { buildVectorStructure, estimateVectorPrimitiveCount } =
      await import('./render/SvgSceneVector.js');
    const view = document.getElementById('view');
    const width = view.clientWidth;
    const height = view.clientHeight;
    const cam = app.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const project = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse);
      const p = new THREE.Vector3(x, y, z).project(cam);
      return { x: (p.x * 0.5 + 0.5) * width, y: (0.5 - p.y * 0.5) * height, depth: -v.z };
    };
    const radiusPx = (x, y, z, r) => {
      const a = project(x, y, z);
      const b = project(x + right.x * r, y + right.y * r, z + right.z * r);
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    const out = buildVectorStructure({ project, radiusPx, width, height, idPrefix: 'asu-' });
    let triangles = 0;
    let cylinders = 0;
    groups.asuGroup.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry.type === 'CylinderGeometry') cylinders += 1;
      else triangles += o.geometry.getAttribute('position').count / 3;
    });
    return {
      counts: out.counts,
      triangles,
      cylinders,
      halos: groups.asuHaloMesh?.count ?? 0,
      hasFace: out.body.includes('class="asu-face"'),
      hasRing: out.body.includes('class="asu-ring"'),
      estimate: estimateVectorPrimitiveCount(),
      emitted: Object.values(out.counts).reduce((a, b) => a + b, 0),
    };
  });
  H.check('SVG export draws every hull triangle and outline cylinder',
    svg.hasFace && svg.counts.asuFaces === svg.triangles && svg.counts.asuEdges === svg.cylinders,
    JSON.stringify(svg));
  H.check('and rings every in-wedge atom',
    svg.hasRing && svg.halos > 0 && svg.counts.asuRings === svg.halos, JSON.stringify(svg));
  H.check('the primitive estimate still bounds what was emitted',
    svg.estimate >= svg.emitted, `${svg.estimate} >= ${svg.emitted}`);

  // --- a changed cell: followed under the Wyckoff lock, dropped otherwise --
  const strained = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const render = await import('./render/index.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    const structure = fileBrowser.selectedStructure;
    const hullExtent = () => {
      let max = 0;
      groups.asuGroup?.traverse((o) => {
        if (o.material?.type !== 'MeshStandardMaterial') return;
        o.geometry.computeBoundingBox();
        max = o.geometry.boundingBox.max.length();
      });
      return max;
    };
    await sym.activateWyckoffMode(structure);
    const before = hullExtent();
    sym.applyWyckoffLattice(structure.lattice.map((row) => row.map((v) => v * 1.1)));
    const after = hullExtent();
    const visible = render.isAsymmetricUnitVisible();
    sym.deactivateWyckoffMode(structure);
    return { ratio: after / before, visible };
  });
  H.check('a Wyckoff-locked strain keeps the wedge and scales it with the cell',
    strained.visible && Math.abs(strained.ratio - 1.1) < 1e-3, JSON.stringify(strained));

  const deformed = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const render = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    const saved = structure.lattice.map((row) => [...row]);
    // In place, as a variable-cell trajectory frame or an EOS point does,
    // and through the fast-frame hook rather than updateVisualization.
    structure.lattice = saved.map((row, i) => row.map((v) => (i === 0 ? v * 1.05 : v)));
    render.refreshAsymmetricUnitIfStale();
    const out = {
      group: !!groups.asuGroup,
      halo: !!groups.asuHaloMesh,
      visible: render.isAsymmetricUnitVisible(),
      label: document.getElementById('showAsuBtn').textContent.trim(),
      boxHidden: document.getElementById('asuResult').hidden,
    };
    structure.lattice = saved;
    const cv = await import('./core/crystal-viewer.js');
    cv.updateVisualization({});
    return out;
  });
  H.check('any other change of cell drops the wedge and its rings',
    !deformed.group && !deformed.halo && !deformed.visible, JSON.stringify(deformed));
  H.check('and the panel goes back to offering "Show"',
    deformed.label === 'Show Asymmetric Unit' && deformed.boxHidden, JSON.stringify(deformed));

  // --- dropped by a selection change the panel did not make --------------
  await H.clickById(page, 'showAsuBtn');
  await waitForWedge(page, true);
  await H.clickById(page, 'getPrimBtn');
  await waitForWedge(page, false);
  const afterPrim = await page.evaluate(() => ({
    label: document.getElementById('showAsuBtn').textContent.trim(),
    boxHidden: document.getElementById('asuResult').hidden,
  }));
  H.check('Prim. Cell selects a new row, and the button follows the dropped wedge',
    afterPrim.label === 'Show Asymmetric Unit' && afterPrim.boxHidden, JSON.stringify(afterPrim));
  await page.evaluate(async () => {
    const render = await import('./render/index.js');
    render.setAsuAtomHighlight(false);
    document.getElementById('asuHighlightChk').checked = false;
  });

  // --- every space-group setting, four invariants ------------------------
  const sweep = await page.evaluate(async () => {
    const geom = await import('./ui/BackendPanel/asuGeometry.js');
    const wyck = await import('./ui/addToStructureModule/WyckoffProjector.js');
    const data = await wyck.loadSymmetryData();

    const fails = [];
    let checked = 0;

    for (const entry of data.spacegroups) {
      const tag = `${entry.it_number} ${entry.hm_short} (${entry.hall})`;
      const poly = geom.polyhedronFromHalfSpaces(
        geom.halfSpacesFromCuts(entry.asu.shape_only_cuts)
      );
      if (!poly.vertices.length) { fails.push(`${tag}: empty`); continue; }

      const volume = geom.polyhedronVolume(poly);
      if (Math.abs(volume - 1 / entry.n_symops) > 1e-12) {
        fails.push(`${tag}: volume ${volume} != 1/${entry.n_symops}`);
        continue;
      }

      const uses = new Map();
      for (const face of poly.faces) {
        for (let t = 0; t < face.loop.length; t += 1) {
          const a = face.loop[t];
          const b = face.loop[(t + 1) % face.loop.length];
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          uses.set(key, (uses.get(key) || 0) + 1);
        }
      }
      const openEdge = [...uses.values()].find((n) => n !== 2);
      if (openEdge !== undefined) {
        fails.push(`${tag}: an edge is used ${openEdge}x — surface not closed`);
        continue;
      }

      const V = poly.vertices.length;
      const E = poly.edges.length;
      const F = poly.faces.length;
      if (V - E + F !== 2) {
        fails.push(`${tag}: Euler ${V}-${E}+${F} = ${V - E + F}`);
        continue;
      }

      const centre = [0, 0, 0];
      for (const v of poly.vertices) {
        centre[0] += v[0] / V; centre[1] += v[1] / V; centre[2] += v[2] / V;
      }
      let inward = false;
      for (const [ia, ib, ic] of poly.triangles) {
        const A = poly.vertices[ia];
        const B = poly.vertices[ib];
        const C = poly.vertices[ic];
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const n = [
          u[1] * w[2] - u[2] * w[1],
          u[2] * w[0] - u[0] * w[2],
          u[0] * w[1] - u[1] * w[0],
        ];
        const d = [A[0] - centre[0], A[1] - centre[1], A[2] - centre[2]];
        if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] <= 0) { inward = true; break; }
      }
      if (inward) { fails.push(`${tag}: inward-wound triangle`); continue; }

      checked += 1;
    }

    // Every Hall number must reach a row, or some structures would have no
    // wedge at all. The 527 rows cover all 530 between them.
    const missing = [];
    for (let hall = 1; hall <= 530; hall += 1) {
      if (!geom.asymmetricUnitForHallNumber(hall)) missing.push(hall);
    }

    return { total: data.spacegroups.length, checked, fails, missing };
  });

  H.check(`all ${sweep.total} space-group settings pass the four invariants`,
    sweep.fails.length === 0 && sweep.checked === sweep.total,
    sweep.fails.length ? sweep.fails.slice(0, 5).join(' ; ') : `${sweep.checked} ok`);
  H.check('all 530 Hall numbers resolve to a wedge',
    sweep.missing.length === 0,
    sweep.missing.length ? `missing ${sweep.missing.slice(0, 10).join(',')}` : '');

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
