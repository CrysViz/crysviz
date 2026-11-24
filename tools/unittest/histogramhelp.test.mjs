// Help texts of the histogram windows (docs/data/*Info.md) against the
// Bonds and Polyhedra windows that open them (ui/BondPanel.js,
// ui/PolyhedraPanel.js). Each histogram once had a Panel and a Split View
// button; since the side dock replaced the split view there is one Open
// button per histogram, but four help texts still sent the reader to the
// "Split View" button next to it, and the Bonds help to both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DOCS = new URL('../../docs/', import.meta.url);
const read = (path) => readFileSync(new URL(path, DOCS), 'utf8');

// [help file, window title, the window's source, the histogram's row label]
const HISTOGRAMS = [
  ['bondLengthHistogramInfo.md', 'Bonds', 'ui/BondPanel.js', 'Bond Length'],
  ['coordinationHistogramInfo.md', 'Bonds', 'ui/BondPanel.js', 'Coordination Number'],
  ['polyhedraTypeHistogramInfo.md', 'Polyhedra', 'ui/PolyhedraPanel.js', 'Type'],
  ['polyhedraConnectivityHistogramInfo.md', 'Polyhedra', 'ui/PolyhedraPanel.js', 'Connectivity'],
];

test('each histogram help names the row and the Open button its window has', () => {
  for (const [md, win, src, label] of HISTOGRAMS) {
    const code = read(src);
    assert.match(code, new RegExp(`addHistogramRow\\(\\s*["']${label}["']`), `${src} has a "${label}" row`);
    assert.match(code, /openBtn\.textContent = ["']Open["']/, `${src}: the row's button reads Open`);
    const help = read(`data/${md}`);
    assert.ok(help.includes(`**Open** next to *${label}*`), `${md} names the Open button next to ${label}`);
    assert.ok(help.includes(`in the ${win} window`), `${md} names the ${win} window`);
  }
});

test('no help text points at a Split View or Panel button', () => {
  for (const src of ['ui/BondPanel.js', 'ui/PolyhedraPanel.js']) {
    assert.doesNotMatch(read(src), /["'](Split View|Panel)["']/, `${src} has no such button`);
  }
  const helps = readdirSync(new URL('data/', DOCS)).filter((f) => f.endsWith('Info.md'));
  assert.ok(helps.length > 40, 'found the help texts');
  for (const md of helps) {
    const text = read(`data/${md}`);
    assert.doesNotMatch(text, /split view/i, `${md} mentions the split view`);
    assert.doesNotMatch(text, /\(\*\*Panel\*\*\)/, `${md} names a Panel button`);
  }
});
