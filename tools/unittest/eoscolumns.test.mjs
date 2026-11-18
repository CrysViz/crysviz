// EOS data files: column detection (docs/eos/eosMath.js detectColumns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectColumns } from '../../docs/eos/eosMath.js';

const rows = ['40.0 -10.10 5.0', '42.0 -10.30 1.0', '44.0 -10.25 -1.5'];

test('a "# V E P" comment header names the columns; its # is no column', () => {
  const out = detectColumns(['# V E P', ...rows]);
  assert.deepEqual(out.volumes, [40, 42, 44]);
  assert.deepEqual(out.energies, [-10.1, -10.3, -10.25]);
  assert.deepEqual(out.pressures, [5, 1, -1.5]);
  assert.equal(out.columnInfo.hasHeaders, true);
});

test('other comment lines are skipped; the last name row before the data is the header', () => {
  const out = detectColumns(['# EOS scan of Si', '# volume energy pressure', ...rows, '# end']);
  assert.equal(out.volumes.length, 3);
  assert.deepEqual(out.columnInfo.headers, ['volume', 'energy', 'pressure']);
});

test('a plain header line and a headerless file still work', () => {
  assert.deepEqual(detectColumns(['V E P', ...rows]).pressures, [5, 1, -1.5]);
  const bare = detectColumns(rows);
  assert.equal(bare.columnInfo.hasHeaders, false);
  assert.equal(bare.volumes.length, 3);
});

test('no data rows is an error, not an empty fit', () => {
  assert.throws(() => detectColumns(['# V E P']), /No data rows/);
  assert.throws(() => detectColumns(['V E P X', ...rows]), /No data rows with 4 numeric columns/);
});
