// A CIF whose atom_site loop has no _atom_site_type_symbol column (it is
// optional) took the elements from nowhere and crashed on load ("Cannot read
// properties of undefined"). The element now comes from the label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { single_asu_from_cif_file, _parse_atoms } from '../../docs/io/cif/cif_parser.js';
import { read_cif } from '../../docs/io/cif/cif_reader.js';

const CIF = `data_SrTiO3
_cell_length_a 3.905
_cell_length_b 3.905
_cell_length_c 3.905
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_label
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Sr1 0.0 0.0 0.0
Ti1 0.5 0.5 0.5
O1 0.5 0.5 0.0
`;

const stream = (text) => new Blob([text]).stream();

test('without _atom_site_type_symbol the elements come from the labels', async () => {
  const [cifblocks] = await read_cif(stream(CIF), true, false, false);
  const block = new Map(cifblocks).values().next().value;
  const [symbols, labels, , , charges] = _parse_atoms(block, false);
  assert.deepEqual(symbols, ['Sr', 'Ti', 'O']);
  assert.deepEqual(labels, ['Sr1', 'Ti1', 'O1']);
  assert.deepEqual(charges, [null, null, null], 'a label digit is not a charge');
});

test('a CIF without _atom_site_type_symbol loads', async () => {
  assert.ok(await single_asu_from_cif_file(stream(CIF)), 'an asymmetric unit');
});
