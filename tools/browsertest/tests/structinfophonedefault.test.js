// The Structure window's formula/atom box (#composition, the +/− toggle) is
// closed by default on a desktop but OPEN by default on a phone — so a
// hand-held user doesn't tap the + after every structure. A deliberate collapse
// still sticks across re-renders (renderComposition rebuilds the box on every
// structure change, and used to reset it every time).
'use strict';
const H = require('../harness');

const boxState = (page) => page.evaluate(() => ({
  open: document.getElementById('composition').classList.contains('open'),
  icon: document.getElementById('structureToggleIcon').textContent,
}));

// Pin the phone workflow through the detection seam (headless can't shrink its
// screen) and reload so it's seeded before the panel system initialises.
async function bootAsPhone(page) {
  await page.evaluate(async () => {
    const { setPhoneScreenOverride } = await import('./ui/panels/PanelManager.js');
    setPhoneScreenOverride(true);
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3000);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const desktop = await boxState(page);
  H.check('desktop: composition starts closed', !desktop.open && desktop.icon === '+',
    JSON.stringify(desktop));

  await bootAsPhone(page);
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);
  const phone = await boxState(page);
  H.check('phone: composition is open by default', phone.open && phone.icon === '−',
    JSON.stringify(phone));

  // Collapse it, then force a re-render (reload the structure): it must stay
  // closed — the default-open must not fight a deliberate collapse.
  await page.evaluate(async () => {
    const { handleStructurePanelToggle } = await import('./ui/StructureInfoPanel/General.js');
    handleStructurePanelToggle();
  });
  let collapsed = await boxState(page);
  H.check('phone: the + toggle still collapses it', !collapsed.open && collapsed.icon === '+',
    JSON.stringify(collapsed));

  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);
  collapsed = await boxState(page);
  H.check('phone: a deliberate collapse survives a re-render', !collapsed.open,
    JSON.stringify(collapsed));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})();
