// Polyhedra regression set, part 1 of 5: the structures of the stress run
// (AFLOW prototypes, pymatgen's test set, hand-made cases), each checked on
// the WASM and the JS path against the list of polyhedra it should draw in
// fixtures/polyhedra_golden.json (readable copy: polyhedra_golden.md). See
// ../polygolden.js for how to regenerate the lists after an intended change.
'use strict';
const H = require('../harness');
require('../polygolden').runShard(1).catch(H.crash);
