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

  // --- a primitive cell: the wedge belongs to the CONVENTIONAL cell ------
  // Si diamond primitive is the case the decision "conventional cell always"
  // exists for — its own cell is not the cell the wedge is defined in, so the
  // wedge has to bring that conventional cell along and say so.
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
    return {
      needsCellBox: render.asymmetricUnitNeedsCellBox(),
      hasNote: !!box.querySelector('.sym-asu-note'),
      cylinders,
      atoms: fileBrowser.selectedStructure.atoms.length,
      text: box.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  H.check('a primitive cell is recognised as not the conventional cell',
    primitive.needsCellBox === true && primitive.atoms === 2,
    `needsCellBox=${primitive.needsCellBox} atoms=${primitive.atoms}`);
  H.check('so the conventional cell box is drawn (12 extra cylinders) '
    + 'and the panel explains it',
    primitive.cylinders >= 12 + 6 && primitive.hasNote,
    `${primitive.cylinders} cylinders, note=${primitive.hasNote}`);
  // Fd-3m has 192 operations in its conventional cell; the primitive cell on
  // screen has 2 atoms. Reporting 1/192 rather than 1/48 is the load-bearing
  // consequence of using the conventional cell.
  H.check('the wedge is 1/192 of the conventional cell, not of the primitive one',
    primitive.text.includes('1/192 of the cell'), primitive.text.slice(0, 160));

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
