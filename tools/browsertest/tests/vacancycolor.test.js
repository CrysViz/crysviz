// A vacancy sphere is hatched to read as "absence", but its fill colour must be
// user-settable (the picker was previously a no-op — VACANCY_COLOR was
// hardcoded). The hatch is carried by a NEGATIVE packed colour in the wedge
// data, so the two properties to check together are: the fill changes, and the
// sign stays negative (still hatched).
'use strict';
const H = require('../harness');

// packColor from WedgeAtoms (0xRRGGBB -> r*65536+g*256+b), replicated so the
// test states the expected value independently of the module internals.
function packColor(hex) {
  return ((hex >> 16) & 0xff) * 65536 + ((hex >> 8) & 0xff) * 256 + (hex & 0xff);
}
const VACANCY_COLOR = 0x2a2a30;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const r = await page.evaluate(async () => {
    const { Atom } = await import('./model/index.js');
    const { wedgeDataForAtom } = await import('./render/WedgeAtoms.js');

    // Pure vacancy site, untouched: wedge fill should be the neutral default.
    const pure = new Atom({ position: [0, 0, 0], element: 'Va' });
    const def = wedgeDataForAtom(pure).packed[0];

    // Same site, recoloured the way the single-dot element picker does it.
    pure.userColor = '#ff0000';
    const tinted = wedgeDataForAtom(pure).packed[0];

    // A mixed Fe/Va site with a per-species colour on the Va slot.
    const mixed = new Atom({
      position: [0, 0, 0],
      species: [{ element: 'Fe', occupancy: 0.5 }, { element: 'Va', occupancy: 0.5 }],
    });
    mixed.setSpeciesColor(1, '#00ff00'); // colour the Va species
    const md = wedgeDataForAtom(mixed);
    // Find the vacancy wedge (negative packed value) among the slots.
    const vacPacked = md.packed.find((p) => p < 0);

    return { def, tinted, vacPacked };
  });

  H.check('untouched vacancy uses the neutral default fill, hatched (negative)',
    r.def === -packColor(VACANCY_COLOR), `${r.def} vs ${-packColor(VACANCY_COLOR)}`);

  H.check('recolouring a pure-Va site changes the fill and keeps the hatch',
    r.tinted === -packColor(0xff0000), `${r.tinted} vs ${-packColor(0xff0000)}`);

  H.check('per-species colour on a Va slot is honoured, still hatched',
    r.vacPacked === -packColor(0x00ff00), `${r.vacPacked} vs ${-packColor(0x00ff00)}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
