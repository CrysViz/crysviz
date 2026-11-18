// Site occupancies survive a saved session. A .crysviz file and a share link
// store atoms as elements + positions, so a disordered site (Fe 0.5 / Ni 0.3 /
// Co 0.2) used to come back as plain Fe and a partially occupied O as full O.
// Now a sparse species record (model/siteSpecies.js) travels with the file, the
// link and every trajectory frame: occupancies, oxidation states and
// per-species colours.
'use strict';
const H = require('../harness');

const CIF = `data_disorder
_cell_length_a 4
_cell_length_b 4
_cell_length_c 4
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
_symmetry_equiv_pos_as_xyz
x,y,z
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Fe1 Fe 0 0 0 0.5
Ni1 Ni 0 0 0 0.3
Co1 Co 0 0 0 0.2
O1 O 0.5 0.5 0.5 0.8
Na1 Na 0.5 0 0 1
`;

const SNAPSHOT = async () => {
  const { fileBrowser } = await import('./state/store.js');
  const { structureHasFractionalOccupancy } = await import('./ui/DisorderWarningBanner.js');
  const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
  setStructurePanelOpen(true);
  await new Promise((r) => setTimeout(r, 500));
  const s = fileBrowser.selectedStructure;
  return {
    sites: s.atoms.map((a, i) => `${s.elements[i]}=${a.species
      .map((x) => `${x.element}:${x.occupancy}:${x.oxidationState}:${x.color}`).join('/')}`).sort(),
    disordered: structureHasFractionalOccupancy(s),
    rows: [...document.querySelectorAll('#atomPanel .comp-row-name')].map((e) => e.textContent).sort(),
  };
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO, fully ordered

  const ordered = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const file = captureState({ includeFrames: true });
    const link = captureState();
    return { file: file.frames.some((f) => 'species' in f), link: 'species' in link.structure };
  });
  H.check('an ordered structure writes no species record', !ordered.file && !ordered.link, JSON.stringify(ordered));

  await page.evaluate(async (cif) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');
    await cv.loadStructure(cif, 'disorder.cif');
    const s = fileBrowser.selectedStructure;
    const mixed = s.atoms.find((a) => a.species.length === 3);
    mixed.setSpeciesColor(1, '#00ff00'); // a per-species colour
    mixed.species[2].oxidationState = 2; // and an oxidation state
    cv.updateVisualization({ reRenderAtoms: true, reRenderComposition: true });
  }, CIF);
  await page.waitForTimeout(800);
  const before = await page.evaluate(SNAPSHOT);
  H.check('the CIF loads with a three-species site and a partial O',
    before.disordered && before.sites.some((x) => x.split('/').length === 3) && before.sites.some((x) => x.startsWith('O=O:0.8')),
    JSON.stringify(before));

  // --- .crysviz file ---------------------------------------------------------------
  const file = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const cv = await import('./core/crystal-viewer.js');
    const text = JSON.stringify({ format: 'crysviz', ...captureState({ includeFrames: true, includeFields: true }) });
    const saved = JSON.parse(text).frames[0].species;
    await cv.loadStructure(text, 'disorder.crysviz');
    return { saved };
  });
  H.check('the file records only the two non-plain sites',
    file.saved && Object.keys(file.saved).length === 2, JSON.stringify(file.saved));
  const afterFile = await page.evaluate(SNAPSHOT);
  H.check('.crysviz: occupancies, oxidation state and species colour come back',
    JSON.stringify(afterFile.sites) === JSON.stringify(before.sites), JSON.stringify({ before: before.sites, after: afterFile.sites }));
  H.check('.crysviz: the restored structure counts as disordered and lists the mixed site',
    afterFile.disordered && JSON.stringify(afterFile.rows) === JSON.stringify(before.rows),
    JSON.stringify({ before: before.rows, after: afterFile.rows }));

  // --- share link (made from the restored session) -------------------------------
  const link = await page.evaluate(async () => {
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return url;
  });
  H.check('a compact #z= link', /#z=[A-Za-z0-9_-]+$/.test(link), link.slice(0, 80));
  await page.goto('about:blank');
  await page.goto(link, { waitUntil: 'load' });
  await H.waitFor(page, async () => (await import('./state/store.js')).general.sharedStructureLoaded,
    { timeout: 40000, interval: 1000 });
  const afterLink = await page.evaluate(SNAPSHOT);
  H.check('share link: occupancies, oxidation state and species colour come back',
    JSON.stringify(afterLink.sites) === JSON.stringify(before.sites), JSON.stringify({ before: before.sites, after: afterLink.sites }));
  H.check('share link: the mixed site is listed', JSON.stringify(afterLink.rows) === JSON.stringify(before.rows),
    JSON.stringify(afterLink.rows));

  // --- a trajectory: each frame keeps its own sites -------------------------------
  const TRAJ = [
    '2', 'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.0 0.0 0.0', 'Cl 2.0 2.0 2.0',
    '2', 'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.1 0.0 0.0', 'Cl 2.1 2.0 2.0',
  ].join('\n');
  const traj = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { captureState } = await import('./ui/ShareModule.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    await cv.loadStructure(text, 'traj.xyz');
    await new Promise((r) => setTimeout(r, 800));
    // Frame 0 only (a trajectory opens on its last frame): Na half replaced by K.
    showTrajectoryFrame(0, structureShip.container[fileBrowser.selectedRowIndex]);
    fileBrowser.selectedStructure.atoms[0].setSpecies([{ element: 'Na', occupancy: 0.5 }, { element: 'K', occupancy: 0.5 }]);
    const saved = captureState({ includeFrames: true });
    const sites = () => fileBrowser.selectedStructure.atoms.map((a) => a.species.map((x) => `${x.element}:${x.occupancy}`).join('/'));
    await cv.loadStructure(JSON.stringify({ format: 'crysviz', ...saved }), 'traj.crysviz');
    await new Promise((r) => setTimeout(r, 800));
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    showTrajectoryFrame(0, container);
    const f0 = sites();
    showTrajectoryFrame(1, container);
    const f1 = sites();
    return { frames: saved.frames.map((f) => f.species ?? null), f0, f1, count: container.structures.length };
  }, TRAJ);
  H.check('trajectory: only frame 0 records a species entry',
    traj.frames.length === 2 && traj.frames[0] && !traj.frames[1], JSON.stringify(traj.frames));
  H.check('trajectory: frame 0 comes back mixed, frame 1 plain',
    traj.count === 2 && traj.f0[0] === 'Na:0.5/K:0.5' && traj.f1[0] === 'Na:1', JSON.stringify(traj));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
