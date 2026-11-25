// Modify Structure atom table: changing an atom's element recolours it to the
// new element's default colour when the atom has no colour of its own, and
// keeps a user-picked colour otherwise, and the atom's own styling (opacity,
// size) survives the change. An occupancy edit updates the site in place, so
// that styling survives it too.
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await H.loadDefaultStructure(page); // YBCO

  const result = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const { getElementDefaultColor } = await import('./defaults/color_texture_defaults.js');
    const { colorToHex } = await import('./ui/addToStructureModule/CommitAtoms.js');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = () => fileBrowser.selectedStructure;
    const hex = (c) => colorToHex(c).toLowerCase();

    // Atom 1 gets a user colour before the editor opens (what the Structure
    // Info panel's picker does); atom 0 keeps its element default.
    s().atoms[1].userColor = '#123456';
    s().atoms[1].setColor('#123456');
    s().atoms[2].setOpacity(0.4);
    s().atoms[2].radiusScale = 1.7;

    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    await frame();
    const panel = document.querySelector(sel);
    const rowOf = (uuid) => panel.querySelector(`#atomsTable tbody tr[data-uuid="${uuid}"]`);
    const setElement = async (uuid, element) => {
      const input = /** @type {HTMLInputElement} */ (rowOf(uuid).querySelector('.atom-element'));
      input.value = element;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frame();
    };
    const atomOf = (uuid) => s().atoms.find((a) => a.uuid === uuid);

    const plainUuid = s().atoms[0].uuid;
    const customUuid = s().atoms[1].uuid;
    const styledUuid = s().atoms[2].uuid;

    await setElement(plainUuid, 'Fe');
    const plain = atomOf(plainUuid);
    const plainSwatch = rowOf(plainUuid).querySelector('.color-swatch-btn').dataset.hex;

    await setElement(customUuid, 'Fe');
    const custom = atomOf(customUuid);

    // A second change on the same (still auto) row keeps following the default.
    await setElement(plainUuid, 'Ni');
    const plainAgain = atomOf(plainUuid);

    await setElement(styledUuid, 'Fe');
    const styled = atomOf(styledUuid);

    const occInput = /** @type {HTMLInputElement} */ (rowOf(styledUuid).querySelector('.atom-occ'));
    occInput.value = '0.6';
    occInput.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    const afterOcc = atomOf(styledUuid);

    return {
      plain: { color: hex(plain.getColor()), userColor: plain.userColor, expected: hex(getElementDefaultColor('Fe')), swatch: plainSwatch },
      plainAgain: { color: hex(plainAgain.getColor()), userColor: plainAgain.userColor, expected: hex(getElementDefaultColor('Ni')) },
      custom: { color: hex(custom.getColor()), element: custom.species[0].element },
      styled: { element: styled.species[0].element, opacity: styled.opacity, radiusScale: styled.radiusScale },
      occupancy: {
        sameAtom: afterOcc === styled, occupancy: afterOcc.species[0].occupancy,
        opacity: afterOcc.opacity, radiusScale: afterOcc.radiusScale,
      },
    };
  }, MODIFY);

  H.check('an atom without a custom colour takes the new element\'s default colour',
    result.plain.color === result.plain.expected && !result.plain.userColor
    && result.plain.swatch.toLowerCase() === result.plain.expected, JSON.stringify(result.plain));
  H.check('it keeps following the default on a further element change',
    result.plainAgain.color === result.plainAgain.expected && !result.plainAgain.userColor,
    JSON.stringify(result.plainAgain));
  H.check('an atom with a user colour keeps it across an element change',
    result.custom.color === '#123456' && result.custom.element === 'Fe', JSON.stringify(result.custom));
  H.check('an element change keeps the atom\'s opacity and size',
    result.styled.element === 'Fe'
    && Math.abs(result.styled.opacity - 0.4) < 1e-9 && Math.abs(result.styled.radiusScale - 1.7) < 1e-9,
    JSON.stringify(result.styled));

  H.check('an occupancy edit updates the site in place and keeps its styling',
    result.occupancy.sameAtom && Math.abs(result.occupancy.occupancy - 0.6) < 1e-9
    && Math.abs(result.occupancy.opacity - 0.4) < 1e-9 && Math.abs(result.occupancy.radiusScale - 1.7) < 1e-9,
    JSON.stringify(result.occupancy));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
