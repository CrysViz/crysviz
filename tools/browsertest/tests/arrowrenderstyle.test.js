// Force and spin arrows follow the render style (Visual ▸ Rendering style:
// metallic, matte, cel). The arrow meshes are built once and reused while
// their count stays the same, and switching the style only rebuilt atoms and
// bonds, so the arrows kept the style they were created in: shiny arrows
// among cel-shaded atoms, toon arrows after switching back.
// render/ArrowMaterial.js restyleArrowMaterials() now swaps their materials,
// keeping a focus region's transparency.
'use strict';
const H = require('../harness');

const XYZ = [
  '2', 'Lattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 1.0 1.0 1.0   1.0 0.5 0.0',
  'Cl 3.5 3.5 3.5   0.0 -1.0 0.5',
].join('\n');

const MCIF = [
  'data_MnO', '_space_group_magn.name_BNS  "P1"',
  '_cell_length_a 4.446', '_cell_length_b 4.446', '_cell_length_c 4.446',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  'loop_', '_space_group_symop_magn_operation.id', '_space_group_symop_magn_operation.xyz', '1 x,y,z,+1',
  'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Mn1 Mn 0 0 0', 'O1 O 0.5 0.5 0.5',
  'loop_', '_atom_site_moment.label', '_atom_site_moment.crystalaxis_x', '_atom_site_moment.crystalaxis_y', '_atom_site_moment.crystalaxis_z',
  'Mn1 2.6 2.6 2.6', '',
].join('\n');

async function setStyle(page, style) {
  await H.setSelect(page, 'renderStyleMenu', style);
  await page.waitForTimeout(700);
}

const arrowMaterials = (page, keys) => page.evaluate(async (keys) => {
  const { groups } = await import('./state/store.js');
  return keys.map((k) => {
    const m = groups[k]?.material;
    return m ? { key: k, type: m.type, roughness: m.roughness ?? null, spec: m.userData?.transparencySpec ?? null } : { key: k, missing: true };
  });
}, keys);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);

  // --- force arrows --------------------------------------------------------------------
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'forces.xyz'), XYZ);
  await page.waitForTimeout(1200);
  await setStyle(page, 'metallic');
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(900);
  const FORCE = ['forcesShaftMesh', 'forcesTipMesh'];
  const metallic = await arrowMaterials(page, FORCE);
  H.check('forces shown in metallic: physical, glossy arrows',
    metallic.every((m) => m.type === 'MeshPhysicalMaterial' && m.roughness < 0.5), JSON.stringify(metallic));

  await setStyle(page, 'cel');
  const cel = await arrowMaterials(page, FORCE);
  H.check('switched to cel: the force arrows turn toon like the atoms', cel.every((m) => m.type === 'MeshToonMaterial'), JSON.stringify(cel));

  await setStyle(page, 'matte');
  const matte = await arrowMaterials(page, FORCE);
  H.check('switched to matte: rough physical arrows',
    matte.every((m) => m.type === 'MeshPhysicalMaterial' && m.roughness === 1), JSON.stringify(matte));

  // A focus region's transparency on the arrows survives a style switch.
  await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const { syncArrowTransparency } = await import('./render/ArrowMaterial.js');
    syncArrowTransparency(groups.forcesShaftMesh, true);
    syncArrowTransparency(groups.forcesTipMesh, true);
  });
  const before = await arrowMaterials(page, FORCE);
  await setStyle(page, 'metallic');
  const after = await arrowMaterials(page, FORCE);
  H.check('a focus region\'s arrow transparency survives the switch',
    after.every((m, i) => m.type === 'MeshPhysicalMaterial' && m.roughness < 0.5
      && JSON.stringify(m.spec) === JSON.stringify(before[i].spec) && m.spec?.needsTransparency === true),
    JSON.stringify({ before, after }));

  // --- spin arrows ---------------------------------------------------------------------
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'MnO.mcif'), MCIF);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const t = document.getElementById('showSpinsToggle'); if (!t.checked) t.click(); });
  await page.waitForTimeout(900);
  const SPIN = ['spinShaftMesh', 'spinTipMesh'];
  await setStyle(page, 'cel');
  const spinCel = await arrowMaterials(page, SPIN);
  H.check('spin arrows follow too (cel: toon)', spinCel.every((m) => m.type === 'MeshToonMaterial'), JSON.stringify(spinCel));
  await setStyle(page, 'metallic');
  const spinMetal = await arrowMaterials(page, SPIN);
  H.check('and back (metallic: physical)', spinMetal.every((m) => m.type === 'MeshPhysicalMaterial'), JSON.stringify(spinMetal));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
