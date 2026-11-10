// Asymmetric unit across the seven crystal systems, through the panel exactly
// as a user drives it: load, Conv. Cell, Show Asymmetric Unit, then "Highlight
// atoms inside".
//
// asymmetricunit.test.js proves the geometry on all 530 settings in isolation
// and the panel on diamond. What it cannot see is how the pieces meet on real
// cells of every lattice type: each system has its own conventional-cell
// convention (moyo reorders orthorhombic axes, puts rhombohedral groups on
// hexagonal axes, picks origin choice 2), and each of those is a different way
// for the wedge to end up beside the cell instead of in it, or for the wedge
// click to symmetrise a cell that already is the conventional one.
//
// Per structure:
//   - the drawn wedge is the tabulated one moved by a whole lattice vector, and
//     no other lattice vector leaves less of it outside the cell box;
//   - its volume is 1/n of the cell, n = moyo's operation count for that cell;
//   - after Conv. Cell, the wedge click draws onto that structure rather than
//     committing another sym_conv_ copy of it;
//   - one ring per Wyckoff orbit, each on a drawn atom, and on the copies in
//     or on the drawn wedge whenever the atom has one there.
//
// Most cells are loaded in a setting that is NOT moyo's (primitive, cycled
// axes, the other origin choice, a non-reduced triclinic cell), so Conv. Cell
// has real work to do before the wedge goes on.
'use strict';
const H = require('../harness');

const CASES = [
  {
    // No real triclinic crystal is this small; general positions in a skewed
    // cell keep moyo at P-1, and b is a + b of the reduced cell, so the
    // conventional (reduced) cell differs from the loaded one.
    key: 'triclinic', system: 'Triclinic', name: 'FeCl2O2 (synthetic, non-reduced cell)',
    poscar: ['FeCl2O2 P-1', '1.0',
      '5.100000 0.000000 0.000000', '6.450000 6.050000 0.000000', '-1.200000 0.850000 7.050000',
      'Fe Cl O', '1 2 2', 'Direct',
      '0.000000 0.000000 0.000000',
      '0.090000 0.220000 0.430000', '0.910000 0.780000 0.570000',
      '0.440000 0.680000 0.270000', '0.560000 0.320000 0.730000'],
  },
  {
    // Baddeleyite (monoclinic zirconia): three 4e orbits.
    key: 'monoclinic', system: 'Monoclinic', name: 'ZrO2 baddeleyite',
    poscar: ['ZrO2 baddeleyite P2_1/c', '1.0',
      '5.150500 0.000000 0.000000', '0.000000 5.211600 0.000000', '-0.852884 0.000000 5.248454',
      'Zr O', '4 8', 'Direct',
      '0.275400 0.039500 0.208300', '0.724600 0.539500 0.291700',
      '0.724600 0.960500 0.791700', '0.275400 0.460500 0.708300',
      '0.070000 0.331700 0.344700', '0.930000 0.831700 0.155300',
      '0.930000 0.668300 0.655300', '0.070000 0.168300 0.844700',
      '0.449600 0.756900 0.479200', '0.550400 0.256900 0.020800',
      '0.550400 0.243100 0.520800', '0.449600 0.743100 0.979200'],
  },
  {
    // SnSe, Pnma with both sites on 4c, written with the axes cycled
    // (a,b,c) -> (b,c,a) so moyo has to permute them back.
    key: 'orthorhombic', system: 'Orthorhombic', name: 'SnSe (axes cycled)',
    poscar: ['SnSe Pnma axes cycled', '1.0',
      '4.440000 0.000000 0.000000', '0.000000 4.135000 0.000000', '0.000000 0.000000 11.490000',
      'Sn Se', '4 4', 'Direct',
      '0.250000 0.103100 0.118500', '0.750000 0.603100 0.381500',
      '0.750000 0.896900 0.881500', '0.250000 0.396900 0.618500',
      '0.250000 0.481900 0.855100', '0.750000 0.981900 0.644900',
      '0.750000 0.518100 0.144900', '0.250000 0.018100 0.355100'],
  },
  {
    // Anatase in origin choice 1 (Ti at the origin); moyo's standard is
    // origin choice 2, so Conv. Cell moves every atom.
    key: 'tetragonal', system: 'Tetragonal', name: 'TiO2 anatase (origin choice 1)',
    poscar: ['Anatase TiO2', '1.0',
      '3.785000 0.000000 0.000000', '0.000000 3.785000 0.000000', '0.000000 0.000000 9.514000',
      'Ti O', '4 8', 'Direct',
      '0.000000 0.000000 0.000000', '0.500000 0.500000 0.500000',
      '0.000000 0.500000 0.250000', '0.500000 0.000000 0.750000',
      '0.000000 0.000000 0.208100', '0.000000 0.000000 0.791900',
      '0.500000 0.500000 0.708100', '0.500000 0.500000 0.291900',
      '0.000000 0.500000 0.458100', '0.000000 0.500000 0.041900',
      '0.500000 0.000000 0.958100', '0.500000 0.000000 0.541900'],
  },
  {
    // Bi2Se3 as its 5-atom rhombohedral primitive cell; the wedge is defined
    // on the 15-atom hexagonal one.
    key: 'trigonal', system: 'Trigonal', name: 'Bi2Se3 (rhombohedral primitive cell)',
    poscar: ['Bi2Se3 R-3m', '1.0',
      '2.071500 1.195981 9.545333', '-2.071500 1.195981 9.545333', '0.000000 -2.391962 9.545333',
      'Bi Se', '2 3', 'Direct',
      '0.400800 0.400800 0.400800', '0.599200 0.599200 0.599200',
      '0.000000 0.000000 0.000000', '0.211700 0.211700 0.211700',
      '0.788300 0.788300 0.788300'],
  },
  {
    key: 'hexagonal', system: 'Hexagonal', name: '2H-MoS2',
    poscar: ['2H-MoS2 P6_3/mmc', '1.0',
      '3.160000 0.000000 0.000000', '-1.580000 2.736640 0.000000', '0.000000 0.000000 12.294000',
      'Mo S', '2 4', 'Direct',
      '0.3333333 0.6666667 0.250000', '0.6666667 0.3333333 0.750000',
      '0.3333333 0.6666667 0.621000', '0.6666667 0.3333333 0.121000',
      '0.6666667 0.3333333 0.379000', '0.3333333 0.6666667 0.879000'],
  },
  {
    // The cell a user reported: Fd-3m origin choice 2 tabulates the wedge at
    // z <= y <= 0, wholly outside the [0,1) box, and the wedge click was
    // reported to throw away the conventional cell Conv. Cell had just made.
    key: 'cubic', system: 'Cubic', name: 'Diamond (primitive cell)',
    poscar: ['Diamond (primitive cell)', '3.567',
      '   0.0   0.5   0.5', '   0.5   0.0   0.5', '   0.5   0.5   0.0',
      'C', '2', 'Direct', '   0.00  0.00  0.00', '   0.25  0.25  0.25'],
  },
];

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

// Fit the new cell, from off every axis and with c up, so the screenshot
// reads in 3D rather than as a face-on projection where the wedge and the
// cell box overlap edge for edge. resetView first: it is what refits the
// orthographic frustum and the zoom, which setViewDirection leaves at the
// previous structure's.
async function tilt(page) {
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const view = await import('./ui/WindowAndSceneControls.js');
    const render = await import('./render/index.js');
    view.resetView();
    view.setViewDirection([1, 0.45, 0.3], { refit: true });
    app.camera.up.set(0, 0, 1);
    // The fit is made for its own (1,1,1) view; turned c-up, a tall cell
    // (Bi2Se3, MoS2, anatase) overruns the frame height by about this much.
    app.camera.zoom = 0.75;
    app.camera.updateProjectionMatrix();
    app.controls.update();
    render.requestRender();
  });
  await page.waitForTimeout(1200);
}

// Everything checked about one structure, measured in the page against
// independent recomputations from moyo and the tables rather than against
// anything AsymmetricUnitModule cached.
async function measure(page) {
  return page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const render = await import('./render/index.js');
    const geom = await import('./ui/BackendPanel/asuGeometry.js');
    const math = await import('./math/index.js');
    const moyo = await import('./ui/BackendPanel/MoyoWASM.js');

    const s = fileBrowser.selectedStructure;
    const box = document.getElementById('asuResult');
    const hall = Number(box.dataset.hallNumber);
    const tabulated = geom.asymmetricUnitForHallNumber(hall);
    const shift = render.asymmetricUnitShift();
    const move = (halfSpaces, t) => halfSpaces.map((h) => ({
      ...h, offset: h.offset - (h.normal[0] * t[0] + h.normal[1] * t[1] + h.normal[2] * t[2]),
    }));
    const drawnHalfSpaces = move(tabulated.halfSpaces, shift);

    // Volume of the wedge outside the cell box, exactly: clip it to the six
    // faces of [0,1]^3 and compare volumes. Asked of every nearby lattice
    // translation too, so "mostly inside" is measured against the best the
    // lattice allows rather than against a guessed threshold — a wedge that
    // straddles a cell face cannot be pulled wholly inside by any of them.
    const cellBox = [[1, 0, 0, 0], [-1, 0, 0, 1], [0, 1, 0, 0], [0, -1, 0, 1], [0, 0, 1, 0], [0, 0, -1, 1]]
      .map(([a, b, c, o]) => ({ normal: [a, b, c], offset: o }));
    const outsideAt = (t) => {
      const wedgeFaces = move(tabulated.halfSpaces, t);
      // A cell face the wedge already lies on (x >= 0 is both, often) would
      // come out as two coincident faces and count its volume twice.
      const extra = cellBox.filter((c) => !wedgeFaces.some((h) => Math.abs(h.offset - c.offset) < 1e-9
        && Math.hypot(h.normal[0] - c.normal[0], h.normal[1] - c.normal[1], h.normal[2] - c.normal[2]) < 1e-9));
      const clipped = geom.polyhedronFromHalfSpaces([...wedgeFaces, ...extra]);
      const inside = clipped.vertices.length ? geom.polyhedronVolume(clipped) : 0;
      return 1 - inside / tabulated.volumeFraction;
    };
    let bestOutside = Infinity;
    const base = shift;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          bestOutside = Math.min(bestOutside, outsideAt([base[0] + dx, base[1] + dy, base[2] + dz]));
        }
      }
    }

    // The hull on screen is the tabulated wedge moved by `shift` — read back
    // from the mesh, so a shift reported but not applied (or the reverse) shows.
    let hull = null;
    groups.asuGroup?.traverse((o) => {
      if (o.isMesh && o.material?.type === 'MeshStandardMaterial' && !hull) hull = o;
    });
    const toFrac = math.invert3x3(math.transpose3x3(s.lattice));
    const pos = hull?.geometry.getAttribute('position');
    const expectedVertices = tabulated.polyhedron.vertices.map((v) => v.map((x, a) => x + shift[a]));
    let hullMatches = !!pos;
    for (let i = 0; pos && i < pos.count; i += 1) {
      const f = math.multiplyMatVec(toFrac, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
      if (!expectedVertices.some((v) => Math.hypot(v[0] - f[0], v[1] - f[1], v[2] - f[2]) < 1e-5)) hullMatches = false;
    }

    // moyo's own view of the cell on screen: its operation count is what the
    // wedge must be the reciprocal of, and its orbits what the rings must count.
    const { dataset } = moyo.moyoDataset(s);
    const orbitOf = dataset.orbits;
    const orbits = new Set(orbitOf).size;

    const w = s.periodic.visibleWrapped;
    const halo = groups.asuHaloMesh;
    const rings = [];
    for (let k = 0; k < (halo?.visible ? halo.count : 0); k += 1) {
      rings.push(Array.from(halo.instanceMatrix.array.slice(k * 16 + 12, k * 16 + 15)));
    }
    // Every ring on a drawn atom: matched to the copy it surrounds.
    const ringOn = rings.map((r) => w.cart.findIndex((c) => Math.hypot(r[0] - c[0], r[1] - c[1], r[2] - c[2]) < 1e-4));
    const srcOf = (i) => w.srcIndex?.[i] ?? i;
    const ringedSources = new Set(ringOn.filter((i) => i >= 0).map(srcOf));

    // Per atom, its drawn copies that sit in or on the drawn wedge. Where an
    // atom has any, those and only those must carry its rings.
    const inDrawn = new Map();
    w.cart.forEach((c, i) => {
      const f = math.multiplyMatVec(toFrac, c);
      if (!geom.containsFractional(drawnHalfSpaces, f[0], f[1], f[2])) return;
      if (!inDrawn.has(srcOf(i))) inDrawn.set(srcOf(i), []);
      inDrawn.get(srcOf(i)).push(i);
    });
    const misplaced = [];
    for (const src of ringedSources) {
      const want = inDrawn.get(src);
      if (!want) continue;
      const got = ringOn.filter((i) => i >= 0 && srcOf(i) === src);
      const same = got.length === want.length && want.every((i) => got.includes(i));
      if (!same) misplaced.push(`atom ${src}: rings on ${got} but in the wedge ${want}`);
    }

    const text = box.textContent.replace(/\s+/g, ' ').trim();
    return {
      hall,
      hm: tabulated.hm,
      shift,
      outside: outsideAt(shift),
      bestOutside,
      hullMatches,
      denominator: Number(/1\/(\d+) of the cell/.exec(text)?.[1]),
      operations: dataset.operations.length,
      shiftNote: !!box.querySelector('.sym-asu-shift-note'),
      cellBoxNote: !!box.querySelector('.sym-asu-cellbox-note'),
      orbits,
      ringedOrbits: new Set([...ringedSources].map((src) => orbitOf[src])).size,
      counts: render.asuAtomsInside(),
      rings: rings.length,
      offAtom: ringOn.filter((i) => i < 0).length,
      outsideOnly: [...ringedSources].filter((src) => !inDrawn.has(src)).length,
      misplaced,
      atoms: s.atoms.length,
      drawn: w.cart.length,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  for (const c of CASES) {
    await page.evaluate(async ({ text, name }) => {
      const cv = await import('./core/crystal-viewer.js');
      await cv.loadStructure(text, name);
    }, { text: c.poscar.join('\n') + '\n', name: `${c.key}.vasp` });
    await page.waitForTimeout(1200);
    await openSymmetry(page);

    // --- Conv. Cell, then the wedge onto it ------------------------------
    await H.clickById(page, 'getConvBtn');
    await page.waitForTimeout(1500);
    const conv = await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      // Identity, not equality: the question is whether the wedge click kept
      // THIS structure or swapped in a lookalike.
      window.__convStructure = fileBrowser.selectedStructure;
      return {
        rows: document.querySelectorAll('#objectTable tbody tr').length,
        name: fileBrowser.fileData[fileBrowser.selectedRowIndex]?.name ?? '',
      };
    });
    await H.clickById(page, 'showAsuBtn');
    const appeared = await waitForWedge(page, true);
    const kept = await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      return {
        rows: document.querySelectorAll('#objectTable tbody tr').length,
        same: fileBrowser.selectedStructure === window.__convStructure,
        status: document.getElementById('calcResult').textContent.trim(),
      };
    });

    // --- highlight -------------------------------------------------------
    // The toggle is module state and outlives the structure switch, so it is
    // only clicked when the rebuilt panel shows it off.
    await page.evaluate(async () => {
      const chk = document.getElementById('asuHighlightChk');
      if (!chk.checked) chk.click();
      const render = await import('./render/index.js');
      render.updateAsuAtomHighlight();
    });
    const m = await measure(page);
    const tag = `${c.system} ${m.hm} (Hall ${m.hall})`;

    H.check(`${tag}: Conv. Cell commits a sym_conv_ row and the wedge is drawn`,
      conv.name.startsWith('sym_conv_') && appeared, `${conv.name} wedge=${appeared}`);
    H.check(`${tag}: the wedge click keeps the conventional cell Conv. Cell made`,
      kept.same && kept.rows === conv.rows && !/symmetris/i.test(kept.status) && !m.cellBoxNote,
      `same=${kept.same} rows ${conv.rows} -> ${kept.rows} status="${kept.status}" cellBox=${m.cellBoxNote}`);
    H.check(`${tag}: the hull drawn is the tabulated wedge moved by the reported shift`,
      m.hullMatches && m.shiftNote === m.shift.some((v) => v !== 0),
      `shift (${m.shift}) note=${m.shiftNote}`);
    H.check(`${tag}: no lattice translation leaves less of the wedge outside the cell`,
      m.outside <= m.bestOutside + 1e-9,
      `shift (${m.shift.join(',')}), ${(100 * m.outside).toFixed(1)}% outside`
      + ` (best ${(100 * m.bestOutside).toFixed(1)}%)`);
    H.check(`${tag}: the wedge is 1/n of the cell, n = moyo's operation count`,
      m.denominator === m.operations, `1/${m.denominator} vs ${m.operations} operations`);
    H.check(`${tag}: one ringed atom per Wyckoff orbit`,
      m.counts.atoms === m.orbits && m.ringedOrbits === m.orbits,
      `${m.counts.atoms} atoms ringed over ${m.ringedOrbits} orbits, moyo has ${m.orbits}; `
      + `${m.atoms} atoms, ${m.rings} rings`);
    H.check(`${tag}: every ring sits on a drawn atom`,
      m.rings > 0 && m.offAtom === 0 && m.rings === m.counts.instances,
      `${m.offAtom} of ${m.rings} rings off any atom`);
    H.check(`${tag}: rings sit in or on the drawn wedge wherever the atom has a copy there`,
      m.misplaced.length === 0,
      m.misplaced.length ? m.misplaced.slice(0, 3).join(' ; ')
        : `${m.outsideOnly} atom(s) with no copy in the drawn wedge`);

    await tilt(page);
    await H.shotCanvas(page, `asu_system_${c.key}`);

    // Asking again must not commit anything either: the reported failure
    // added a sym_conv_ row on every click, not just the first.
    await H.clickById(page, 'showAsuBtn');
    await waitForWedge(page, false);
    await H.clickById(page, 'showAsuBtn');
    await waitForWedge(page, true);
    const again = await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      return {
        rows: document.querySelectorAll('#objectTable tbody tr').length,
        same: fileBrowser.selectedStructure === window.__convStructure,
      };
    });
    H.check(`${tag}: and so does asking for it a second time`,
      again.same && again.rows === conv.rows, `same=${again.same} rows ${conv.rows} -> ${again.rows}`);

    // Hide before the next structure, so its panel starts from "Show".
    await H.clickById(page, 'showAsuBtn');
    await waitForWedge(page, false);
  }

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
