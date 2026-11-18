// CIF loops followed by a comment (docs/io/cif/cif_reader.js _read_cif_loop).
// Jana2006 writes "#=====" separators and section comments between loops; a
// comment after a loop's last row made the reader take the next "loop_" and
// its tags as more values of that loop, so a Jana CIF lost its atom_site loop
// and did not load (the error read "No structural block found in CIF").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read_cif } from '../../docs/io/cif/cif_reader.js';
import { single_asu_from_cif_file } from '../../docs/io/cif/cif_parser.js';

const stream = (text) => new Blob([text]).stream();
async function blocks(text) {
  const [cifblocks] = await read_cif(stream(text), true, false, false);
  return new Map(cifblocks);
}

const ATOMS = `loop_
 _atom_site_label
 _atom_site_type_symbol
 _atom_site_fract_x
 _atom_site_fract_y
 _atom_site_fract_z
  Si1 Si 0 0 0
  O1 O 0.25(1) 0.25(1) 0.25(1)
`;

// The layout Jana2006 writes (a made-up structure): a data_global block of
// publication fields, then the structure block, with "?" loops and
// comment separators between the loops.
const JANA_LIKE = `#=======================================================================
data_global
#=======================================================================
_audit_creation_method                   'Jana2006 Version : 10/09/2020'
loop_
 _publ_author_name
 _publ_author_address
; ?      "A. Author"
;
; ?      # address
;

#=======================================================================

# 4. TEXT

_publ_section_synopsis
; ?
;
#=======================================================================
data_I
#=======================================================================
_cell_length_a                           5.0(1)
_cell_length_b                           5.0(1)
_cell_length_c                           5.0(1)
_cell_angle_alpha                        90
_cell_angle_beta                         90
_cell_angle_gamma                        90
loop_
 _space_group_symop_id
 _space_group_symop_operation_xyz
 1   x,y,z
loop_
 _restr_equal_torsion_atom_site_label_1
 _restr_equal_torsion_site_symmetry_1
 _restr_equal_torsion_class_target_weight_param
 ? ? ?


#=======================================================================

# 9. ATOMIC COORDINATES AND DISPLACEMENT PARAMETERS

${ATOMS}
loop_
 _atom_site_aniso_label
 _atom_site_aniso_U_11
 Si1 0.01(1)
 O1 0.02(1)
`;

test('a comment after a loop ends it: the next loop is read on its own', async () => {
  for (const between of ['# comment', '\n\n#=====\n\n# 9. ATOMIC\n']) {
    const b = (await blocks(`data_x\nloop_\n _a\n _b\n ? ?\n${between}\n${ATOMS}`)).get('x');
    assert.deepEqual(b.get('a'), ['?'], between);
    assert.deepEqual(b.get('b'), ['?'], between);
    assert.deepEqual(b.get('atom_site_label'), ['Si1', 'O1'], between);
  }
});

test('a comment after a loop does not take the next tag as a value', async () => {
  const b = (await blocks('data_x\nloop_\n _a\n 1\n 2\n# end of loop\n_cell_length_a 5.0\n')).get('x');
  assert.deepEqual(b.get('a'), ['1', '2']);
  assert.equal(b.get('cell_length_a'), '5.0');
});

test('comments between loop rows, and an indented tag after a loop', async () => {
  const b = (await blocks('data_x\nloop_\n _a\n _b\n 1 2\n# between rows\n 3 4\n  _cell_length_a 5.0\n')).get('x');
  assert.deepEqual(b.get('a'), ['1', '3']);
  assert.deepEqual(b.get('b'), ['2', '4']);
  assert.equal(b.get('cell_length_a'), '5.0');
});

test('a text field after a comment in a loop is still a text field', async () => {
  const b = (await blocks('data_x\nloop_\n _a\n _b\n 1\n# note\n;\nline one\nline two\n;\n')).get('x');
  assert.deepEqual(b.get('a'), ['1']);
  assert.equal(b.get('b')[0].trim(), 'line one\nline two');
});

test('a Jana2006-style CIF reads its structure block', async () => {
  const all = await blocks(JANA_LIKE);
  assert.deepEqual([...all.keys()], ['global', 'i']);
  const i = all.get('i');
  assert.deepEqual(i.get('atom_site_label'), ['Si1', 'O1']);
  assert.deepEqual(i.get('restr_equal_torsion_class_target_weight_param'), ['?']);
  assert.deepEqual(i.get('atom_site_aniso_label'), ['Si1', 'O1']);
  assert.equal(all.get('global').get('publ_section_synopsis').trim(), '?');
  const asu = await single_asu_from_cif_file(stream(JANA_LIKE));
  assert.ok(asu, 'an asymmetric unit');
});

test('a CIF without atom positions names its data blocks in the error', async () => {
  await assert.rejects(single_asu_from_cif_file(stream('data_global\n_audit_creation_method x\ndata_I\n_cell_length_a 5.0\n')),
    /No atom positions in this CIF: none of its data blocks \(data_global, data_i\) has an _atom_site_label loop/);
});
