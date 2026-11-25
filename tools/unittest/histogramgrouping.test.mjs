// The analysis histograms' series colours (docs/ui/AnalysisPanels/
// histogramColors.js) and Wyckoff site labels (wyckoffSites.js).
//
// Colours: one palette colour per family (element pair, or element), spread
// evenly over the map so two species take its two ends; several series of
// one family share its colour in lighter and darker shades. Site labels: element, orbit number
// within that element, multiplicity + letter, as the Structure panel's
// Wyckoff tab writes them; ranked by element, then orbit number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTOGRAM_COLORS, shadesOf, seriesColors, hexToOklab, oklabToHex, paletteSlot, paletteColor,
  SINGLE_FAMILY_COLOR,
} from '../../docs/ui/AnalysisPanels/histogramColors.js';
import { wyckoffSites, hasWyckoffSites } from '../../docs/ui/AnalysisPanels/wyckoffSites.js';

const hue = (hex) => {
  const [, a, b] = hexToOklab(hex);
  return (Math.atan2(b, a) * 180) / Math.PI;
};

test('OKLab round trip is exact to the byte', () => {
  for (const c of [...HISTOGRAM_COLORS, '#000000', '#ffffff', '#123456']) {
    assert.equal(oklabToHex(hexToOklab(c)), c);
  }
});

test('a single shade is the base colour itself', () => {
  for (const c of HISTOGRAM_COLORS) assert.deepEqual(shadesOf(c, 1), [c]);
});

test('shades are distinct, dark to light, keep the hue and stay in the lightness band', () => {
  for (const base of [...HISTOGRAM_COLORS, SINGLE_FAMILY_COLOR]) {
    for (const n of [2, 3, 4, 6, 12, 16]) {
      const shades = shadesOf(base, n);
      assert.equal(shades.length, n);
      assert.equal(new Set(shades).size, n, `${base} x${n}: ${shades}`);
      const L = shades.map((s) => hexToOklab(s)[0]);
      for (let i = 1; i < n; i++) assert.ok(L[i] > L[i - 1], `${base} x${n}: ${L}`);
      // Never washed out to white, however many site pairs a family has.
      assert.ok(L[0] >= 0.29 && L[n - 1] <= 0.81, `${base} x${n}: ${L}`);
      if (n <= 6) for (let i = 1; i < n; i++) assert.ok(L[i] - L[i - 1] > 0.07, `${base} x${n}: steps ${L}`);
      // Gamut clipping may bend the hue a little at the extremes, never far.
      for (const s of shades) {
        const d = Math.abs(((hue(s) - hue(base) + 540) % 360) - 180);
        assert.ok(d < 25, `${base} -> ${s}: hue moved ${d.toFixed(1)}°`);
      }
    }
  }
});

test('families spread over the whole map: two species take its two ends', () => {
  const slots = (count) => Array.from({ length: count }, (_, i) => paletteSlot(i, count));
  assert.equal(paletteColor(0, 1), SINGLE_FAMILY_COLOR); // a lone family: teal
  assert.equal(SINGLE_FAMILY_COLOR, '#2a9d8f');
  assert.deepEqual(seriesColors(['C-N', 'C-N'], ['C-N']), shadesOf(SINGLE_FAMILY_COLOR, 2));
  assert.deepEqual(slots(2), [0, 7]);
  assert.deepEqual(slots(3), [0, 4, 7]);
  assert.deepEqual(slots(4), [0, 2, 5, 7]);
  assert.deepEqual(slots(8), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(slots(10).slice(8), [0, 1]); // past eight: in order, wrapping
  for (let n = 2; n <= 8; n++) assert.equal(new Set(slots(n)).size, n, `slots(${n}) = ${slots(n)}`);
  assert.deepEqual(seriesColors(['O', 'Si'], ['O', 'Si']), [HISTOGRAM_COLORS[0], HISTOGRAM_COLORS[7]]);
});

test('site pairs share their element pair\'s colour as shades', () => {
  const families = ['Ba-O', 'Ba-O', 'Ba-Y', 'Cu-O', 'Cu-O', 'Cu-O'];
  const order = ['Ba-Cu', 'Ba-O', 'Ba-Y', 'Cu-O']; // 4 families: slots 0, 2, 5, 7
  const colors = seriesColors(families, order);
  assert.deepEqual(colors.slice(0, 2), shadesOf(HISTOGRAM_COLORS[2], 2));
  assert.equal(colors[2], HISTOGRAM_COLORS[5]);
  assert.deepEqual(colors.slice(3), shadesOf(HISTOGRAM_COLORS[7], 3));
});

test('a family missing from the order goes after it, counted once', () => {
  // A, B, X: three families -> X takes the far end.
  assert.deepEqual(seriesColors(['X', 'X'], ['A', 'B']), shadesOf(HISTOGRAM_COLORS[7], 2));
});

// YBCO under its Wyckoff lock, trimmed to what wyckoffSites reads.
function ybco() {
  const elements = ['Ba', 'Ba', 'Y', 'Cu', 'Cu', 'Cu', 'O', 'O', 'O', 'O', 'O', 'O', 'O'];
  const orbit = (element, wyckoff, atomIndices) => ({ element, wyckoff, multiplicity: atomIndices.length, atomIndices });
  return {
    elements,
    atoms: elements.map(() => ({})),
    symmetry: {
      mode: 'wyckoff',
      orbitGroups: [
        orbit('Ba', 't', [0, 1]), orbit('Y', 'h', [2]), orbit('Cu', 'q', [3, 4]), orbit('Cu', 'b', [5]),
        orbit('O', 'e', [6]), orbit('O', 's', [7, 9]), orbit('O', 'r', [8, 10]), orbit('O', '?', [11, 12]),
      ],
    },
  };
}

test('site labels: element, orbit number, multiplicity + letter', () => {
  const { labels } = wyckoffSites(ybco());
  assert.deepEqual(labels, [
    'Ba1 (2t)', 'Ba1 (2t)', 'Y1 (1h)', 'Cu1 (2q)', 'Cu1 (2q)', 'Cu2 (1b)',
    'O1 (1e)', 'O2 (2s)', 'O3 (2r)', 'O2 (2s)', 'O3 (2r)', 'O4', 'O4',
  ]);
});

test('ranks sort sites by element, then orbit number', () => {
  const { ranks } = wyckoffSites(ybco());
  // Ba1, Cu1, Cu2, O1, O2, O3, O4, Y1
  assert.deepEqual(ranks, [0, 0, 7, 1, 1, 2, 3, 4, 5, 4, 5, 6, 6]);
});

test('outside Wyckoff mode there are no sites; an atom outside every orbit keeps its element', () => {
  const s = ybco();
  assert.equal(wyckoffSites({ ...s, symmetry: null }), null);
  assert.equal(hasWyckoffSites({ ...s, symmetry: { mode: 'wyckoff', orbitGroups: [] } }), false);
  s.atoms.push({});
  s.elements.push('H');
  const { labels, ranks } = wyckoffSites(s);
  assert.equal(labels[13], 'H');
  assert.equal(ranks[13], 8);
});
