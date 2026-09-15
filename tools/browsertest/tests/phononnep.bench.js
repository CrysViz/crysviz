// Opt-in (.bench.js, not in the default glob): end-to-end consistency of the
// phonon mode map with the REAL in-browser NEP potential — the check that the
// displacement pattern, the supercell, the Q convention and the frequency
// conversion agree with phonopy when the same potential is on both sides.
//
// BAND_YAML below was produced by phonopy 4.4 from forces computed with this
// app's own NEP89 runner (rocksalt NaCl, a = 5.64 Å, 2x2x2 conventional
// supercell, F primitive): Γ, X, L and (¼,¼,0) — the last has complex Bloch
// phases, and NEP89 makes X and (¼,¼,0) imaginary here. All four q-points are
// commensurate with the force-constant supercell, so phonopy's frequencies
// are exact for the NEP model and a frozen-phonon scan in the smallest
// commensurate supercell must reproduce them (harmonic regime: largest atom
// displacement 0.03 Å). Run with:
//   tools/browsertest/run.sh tests/phononnep.bench.js
'use strict';
const H = require('../harness');

// The same phonons as a Quantum ESPRESSO run writes them: cell in Bohr, forces
// were Ry/Bohr, calculator 'qe' (only phonopy.yaml says so). Loading these must
// give the SAME Å cell, frequencies and mode map as the eV/Å files above.
const PHONOPY_QE_YAML = String.raw`phonopy:
  version: "4.4.0"
  calculator: qe
  frequency_unit_conversion_factor: 108.970772
  symmetry_tolerance: 1.00000e-05

physical_unit:
  atomic_mass: "AMU"
  length: "au"
  force: "Ry/au"
  force_constants: "Ry/au^2"

space_group:
  type: "Fm-3m"
  number: 225
  Hall_symbol: "-F 4 2 3"

primitive_matrix:
- [  0.000000000000000,  0.500000000000000,  0.500000000000000 ]
- [  0.500000000000000,  0.000000000000000,  0.500000000000000 ]
- [  0.500000000000000,  0.500000000000000,  0.000000000000000 ]

supercell_matrix:
- [   2,   0,   0 ]
- [   0,   2,   0 ]
- [   0,   0,   2 ]

primitive_cell:
  lattice:
  - [     0.000000000000000,     5.329027706480126,     5.329027706480126 ] # a
  - [     5.329027706480126,     0.000000000000000,     5.329027706480126 ] # b
  - [     5.329027706480126,     5.329027706480126,     0.000000000000000 ] # c
  points:
  - symbol: Na # 1
    coordinates: [  0.000000000000000,  0.000000000000000,  0.000000000000000 ]
    mass: 22.989769
  - symbol: Cl # 2
    coordinates: [  0.500000000000000,  0.500000000000000,  0.500000000000000 ]
    mass: 35.453000
  reciprocal_lattice: # without 2pi
  - [    -0.093825745997154,     0.093825745997154,     0.093825745997154 ] # a*
  - [     0.093825745997154,    -0.093825745997154,     0.093825745997154 ] # b*
  - [     0.093825745997154,     0.093825745997154,    -0.093825745997154 ] # c*

unit_cell:
  lattice:
  - [    10.658055412960252,     0.000000000000000,     0.000000000000000 ] # a
  - [     0.000000000000000,    10.658055412960252,     0.000000000000000 ] # b
  - [     0.000000000000000,     0.000000000000000,    10.658055412960252 ] # c
  points:
  - symbol: Na # 1
    coordinates: [  0.000000000000000,  0.000000000000000,  0.000000000000000 ]
    mass: 22.989769
    reduced_to: 1
  - symbol: Na # 2
    coordinates: [  0.500000000000000,  0.500000000000000,  0.000000000000000 ]
    mass: 22.989769
    reduced_to: 1
  - symbol: Na # 3
    coordinates: [  0.500000000000000,  0.000000000000000,  0.500000000000000 ]
    mass: 22.989769
    reduced_to: 1
  - symbol: Na # 4
    coordinates: [  0.000000000000000,  0.500000000000000,  0.500000000000000 ]
    mass: 22.989769
    reduced_to: 1
  - symbol: Cl # 5
    coordinates: [  0.500000000000000,  0.000000000000000,  0.000000000000000 ]
    mass: 35.453000
    reduced_to: 5
  - symbol: Cl # 6
    coordinates: [  0.000000000000000,  0.500000000000000,  0.000000000000000 ]
    mass: 35.453000
    reduced_to: 5
  - symbol: Cl # 7
    coordinates: [  0.000000000000000,  0.000000000000000,  0.500000000000000 ]
    mass: 35.453000
    reduced_to: 5
  - symbol: Cl # 8
    coordinates: [  0.500000000000000,  0.500000000000000,  0.500000000000000 ]
    mass: 35.453000
    reduced_to: 5`;

const BAND_QE_YAML = String.raw`nqpoint: 4      
npath: 1      
segment_nqpoint:
- 4
reciprocal_lattice:
- [  -0.09382575,   0.09382575,   0.09382575 ] # a*
- [   0.09382575,  -0.09382575,   0.09382575 ] # b*
- [   0.09382575,   0.09382575,  -0.09382575 ] # c*
natom: 2      
lattice:
- [     0.000000000000000,     5.329027706480126,     5.329027706480126 ] # a
- [     5.329027706480126,     0.000000000000000,     5.329027706480126 ] # b
- [     5.329027706480126,     5.329027706480126,     0.000000000000000 ] # c
points:
- symbol: Na # 1
  coordinates: [  0.000000000000000,  0.000000000000000,  0.000000000000000 ]
  mass: 22.989769
- symbol: Cl # 2
  coordinates: [  0.500000000000000,  0.500000000000000,  0.500000000000000 ]
  mass: 35.453000

phonon:
- q-position: [    0.0000000,    0.0000000,    0.0000000 ]
  distance:    0.0000000
  band:
  - # 1
    frequency:   -0.0000000254
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.62717836359838,  0.00000000000000 ]
      - [  0.00443244892455,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.77884360188418,  0.00000000000000 ]
      - [  0.00550431055331,  0.00000000000000 ]
  - # 2
    frequency:    0.0000000000
    eigenvector:
    - # atom 1
      - [ -0.62719402609513,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [ -0.77886305191002,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    0.0000000359
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00443244892455,  0.00000000000000 ]
      - [ -0.62717836359838,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00550431055331,  0.00000000000000 ]
      - [ -0.77884360188418,  0.00000000000000 ]
  - # 4
    frequency:    2.6808872402
    eigenvector:
    - # atom 1
      - [ -0.77886305191002,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.62719402609513,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 5
    frequency:    2.6808872402
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.77884816754116,  0.00000000000000 ]
      - [  0.00481513741834,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.62718204017898,  0.00000000000000 ]
      - [ -0.00387747937998,  0.00000000000000 ]
  - # 6
    frequency:    2.6808872402
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00481513741834,  0.00000000000000 ]
      - [ -0.77884816754116,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00387747937998,  0.00000000000000 ]
      - [  0.62718204017898,  0.00000000000000 ]

- q-position: [    0.5000000,    0.0000000,    0.5000000 ]
  distance:    0.0938257
  band:
  - # 1
    frequency:   -1.3884439391
    eigenvector:
    - # atom 1
      - [ -0.77441914892259,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [ -0.63267288687126,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
  - # 2
    frequency:   -1.3884439391
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [ -0.77441914892259, -0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.63267288687126, -0.00000000000000 ]
  - # 3
    frequency:   -1.0404912304
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.91223314070075, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.40967145007585,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
  - # 4
    frequency:    2.5258282675
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.40967145007585,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.91223314070075,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
  - # 5
    frequency:    3.1684053913
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.63267288687126, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.77441914892259,  0.00000000000000 ]
  - # 6
    frequency:    3.1684053913
    eigenvector:
    - # atom 1
      - [ -0.63267288687126,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.77441914892259, -0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.5000000,    0.5000000 ]
  distance:    0.1750812
  band:
  - # 1
    frequency:    2.1780461200
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.77940667849925,  0.08262776847496 ]
      - [ -0.56614786977742, -0.13153992641789 ]
      - [ -0.21325880872183,  0.04891215794293 ]
  - # 2
    frequency:    2.1780461200
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.21959226151509, -0.06437225129647 ]
      - [  0.56669618985119,  0.08772646339209 ]
      - [ -0.78628845136627, -0.02335421209562 ]
  - # 3
    frequency:    2.3225284946
    eigenvector:
    - # atom 1
      - [  0.57735026918963, -0.00000000000000 ]
      - [ -0.78867513459481,  0.00000000000000 ]
      - [  0.21132486540519, -0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
  - # 4
    frequency:    2.3225284946
    eigenvector:
    - # atom 1
      - [ -0.57735026918963,  0.00000000000000 ]
      - [ -0.21132486540519,  0.00000000000000 ]
      - [  0.78867513459481, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
  - # 5
    frequency:    2.4220250769
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [ -0.25534160886701, -0.51781656608739 ]
      - [ -0.25534160886701, -0.51781656608739 ]
      - [ -0.25534160886701, -0.51781656608740 ]
  - # 6
    frequency:    3.1186832617
    eigenvector:
    - # atom 1
      - [  0.57735026918963,  0.00000000000000 ]
      - [  0.57735026918963, -0.00000000000000 ]
      - [  0.57735026918963, -0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]

- q-position: [    0.2500000,    0.2500000,    0.0000000 ]
  distance:    0.2414260
  band:
  - # 1
    frequency:   -0.9314940115
    eigenvector:
    - # atom 1
      - [ -0.73393722858944,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [ -0.67921730284973,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -0.9314940115
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00292411339429, -0.73393140351834 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00270610119712, -0.67921191207661 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    2.0995340078
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.05150284314711, -0.38023354924030 ]
    - # atom 2
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.12395065930858, -0.91509897783620 ]
  - # 4
    frequency:    2.9075854415
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00351524257552,  0.67920820634036 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00379844179893, -0.73392739923608 ]
      - [  0.00000000000000, -0.00000000000000 ]
  - # 5
    frequency:    2.9075854415
    eigenvector:
    - # atom 1
      - [ -0.67921730284973,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.73393722858944, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
  - # 6
    frequency:    3.4222093491
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.03512951607062,  0.92278698640614 ]
    - # atom 2
      - [ -0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.01459669489546, -0.38342800017505 ]`;

const BAND_YAML = String.raw`nqpoint: 4      
npath: 1      
segment_nqpoint:
- 4
reciprocal_lattice:
- [  -0.17730496,   0.17730496,   0.17730496 ] # a*
- [   0.17730496,  -0.17730496,   0.17730496 ] # b*
- [   0.17730496,   0.17730496,  -0.17730496 ] # c*
natom: 2      
lattice:
- [     0.000000000000000,     2.820000000000000,     2.820000000000000 ] # a
- [     2.820000000000000,     0.000000000000000,     2.820000000000000 ] # b
- [     2.820000000000000,     2.820000000000000,     0.000000000000000 ] # c
points:
- symbol: Na # 1
  coordinates: [  0.000000000000000,  0.000000000000000,  0.000000000000000 ]
  mass: 22.989769
- symbol: Cl # 2
  coordinates: [  0.500000000000000,  0.500000000000000,  0.500000000000000 ]
  mass: 35.453000

phonon:
- q-position: [    0.0000000,    0.0000000,    0.0000000 ]
  distance:    0.0000000
  band:
  - # 1
    frequency:   -0.0000000504
    eigenvector:
    - # atom 1
      - [ -0.01526526920933,  0.00000000000000 ]
      - [ -0.31529076244279,  0.00000000000000 ]
      - [  0.54196960259526,  0.00000000000000 ]
    - # atom 2
      - [ -0.01895674024677,  0.00000000000000 ]
      - [ -0.39153486282315,  0.00000000000000 ]
      - [  0.67302953109816,  0.00000000000000 ]
  - # 2
    frequency:    0.0000000248
    eigenvector:
    - # atom 1
      - [  0.61146528500858,  0.00000000000000 ]
      - [  0.11247521804642,  0.00000000000000 ]
      - [  0.08265515118759,  0.00000000000000 ]
    - # atom 2
      - [  0.75933076704204,  0.00000000000000 ]
      - [  0.13967414943468,  0.00000000000000 ]
      - [  0.10264294783369,  0.00000000000000 ]
  - # 3
    frequency:    0.0000000378
    eigenvector:
    - # atom 1
      - [ -0.13874264033958,  0.00000000000000 ]
      - [  0.53038986029779,  0.00000000000000 ]
      - [  0.30464638403885,  0.00000000000000 ]
    - # atom 2
      - [ -0.17229360046011,  0.00000000000000 ]
      - [  0.65864955758787,  0.00000000000000 ]
      - [  0.37831644435147,  0.00000000000000 ]
  - # 4
    frequency:    2.6808872501
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.69180537773274,  0.00000000000000 ]
      - [ -0.35781695862132,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.55708920384415,  0.00000000000000 ]
      - [  0.28813879020942,  0.00000000000000 ]
  - # 5
    frequency:    2.6808872501
    eigenvector:
    - # atom 1
      - [ -0.02022504394512,  0.00000000000000 ]
      - [  0.35769629929497,  0.00000000000000 ]
      - [ -0.69157209429317,  0.00000000000000 ]
    - # atom 2
      - [  0.01628659445526,  0.00000000000000 ]
      - [ -0.28804162703288,  0.00000000000000 ]
      - [  0.55690134799653,  0.00000000000000 ]
  - # 6
    frequency:    2.6808872501
    eigenvector:
    - # atom 1
      - [ -0.77860041364898,  0.00000000000000 ]
      - [ -0.00929157401592,  0.00000000000000 ]
      - [  0.01796438295319,  0.00000000000000 ]
    - # atom 2
      - [  0.62698252790975,  0.00000000000000 ]
      - [  0.00748221354965,  0.00000000000000 ]
      - [ -0.01446615496072,  0.00000000000000 ]

- q-position: [    0.5000000,    0.0000000,    0.5000000 ]
  distance:    0.1773050
  band:
  - # 1
    frequency:   -1.3884439442
    eigenvector:
    - # atom 1
      - [ -0.77441914764311,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [ -0.63267288843740,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -1.3884439442
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.77441914764311, -0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.63267288843740, -0.00000000000000 ]
  - # 3
    frequency:   -1.0404912356
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.91223314003894,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.40967145154954, -0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
  - # 4
    frequency:    2.5258282701
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.40967145154954,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.91223314003894,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
  - # 5
    frequency:    3.1684053990
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.63267288843740, -0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.77441914764311,  0.00000000000000 ]
  - # 6
    frequency:    3.1684053990
    eigenvector:
    - # atom 1
      - [ -0.63267288843740,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.77441914764311, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.5000000,    0.5000000 ]
  distance:    0.3308556
  band:
  - # 1
    frequency:    2.1780461200
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.41871610783291,  0.09863149365715 ]
      - [  0.38576469442544,  0.03459135377176 ]
      - [ -0.80448080225835, -0.13322284742891 ]
  - # 2
    frequency:    2.1780461200
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [ -0.69329180631954, -0.03101269831968 ]
      - [  0.71878531795306, -0.00183633898670 ]
      - [ -0.02549351163352,  0.03284903730638 ]
  - # 3
    frequency:    2.3225285088
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.70710678118655,  0.00000000000000 ]
      - [  0.70710678118655, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
  - # 4
    frequency:    2.3225285088
    eigenvector:
    - # atom 1
      - [ -0.81649658092773,  0.00000000000000 ]
      - [  0.40824829046386,  0.00000000000000 ]
      - [  0.40824829046386,  0.00000000000000 ]
    - # atom 2
      - [ -0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
  - # 5
    frequency:    2.4220250769
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [ -0.31421485897724,  0.48435767334816 ]
      - [ -0.31421485897724,  0.48435767334816 ]
      - [ -0.31421485897724,  0.48435767334816 ]
  - # 6
    frequency:    3.1186832807
    eigenvector:
    - # atom 1
      - [ -0.57735026918963,  0.00000000000000 ]
      - [ -0.57735026918963,  0.00000000000000 ]
      - [ -0.57735026918963,  0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.2500000,    0.2500000,    0.0000000 ]
  distance:    0.4562291
  band:
  - # 1
    frequency:   -0.9314940145
    eigenvector:
    - # atom 1
      - [ -0.06087297173863,  0.00000000000000 ]
      - [ -0.73096006098706, -0.02560710057501 ]
      - [  0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [ -0.05633448512366, -0.00000000000000 ]
      - [ -0.67646210634287, -0.02369792019678 ]
      - [ -0.00000000000000, -0.00000000000000 ]
  - # 2
    frequency:   -0.9314940145
    eigenvector:
    - # atom 1
      - [  0.73140845931536,  0.00000000000000 ]
      - [ -0.06083565286650, -0.00213120355631 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.67687707358093,  0.00000000000000 ]
      - [ -0.05629994862270, -0.00197230809684 ]
      - [ -0.00000000000000, -0.00000000000000 ]
  - # 3
    frequency:    2.0995340097
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.01728344536393, -0.38331628449813 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [  0.04159565464487, -0.92251813536080 ]
  - # 4
    frequency:    2.9075854497
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.67880115410943,  0.02377267619226 ]
      - [ -0.00000000000000, -0.00000000000000 ]
    - # atom 2
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.73348754993591, -0.02568787915300 ]
      - [  0.00000000000000, -0.00000000000000 ]
  - # 5
    frequency:    2.9075854497
    eigenvector:
    - # atom 1
      - [ -0.67921730466297,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
    - # atom 2
      - [  0.73393722691138,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
  - # 6
    frequency:    3.4222093668
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000, -0.00000000000000 ]
      - [ -0.00278563283930, -0.92345121625595 ]
    - # atom 2
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000,  0.00000000000000 ]
      - [  0.00115746063845,  0.38370398972381 ]`;

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  const base = new URL(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html');
  base.searchParams.set('experimental', '');
  await page.goto(base.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  const results = await page.evaluate(async (band) => {
    const cv = await import('./core/crystal-viewer.js');
    const S = await import('./phonon/phononSession.js');
    // band.yaml declares no unit; a forced unit skips the confirmation dialog
    // (this is a script, nobody is there to click). Back to auto below, where
    // phonopy.yaml declares Bohr.
    S.setLengthUnit('angstrom');
    await cv.loadStructure(band, 'band.yaml');
    const M = await import('./phonon/phononMath.js');
    const { runModeMapScan } = await import('./phonon/modeMapScan.js');
    const { fitPolynomial, analyzeFit, amplitudeGrid } = await import('./phonon/modeMapFit.js');
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { runner, potential } = await ensureCalculatorRunner(() => {});
    const ds = S.phononState.dataset;
    const out = [];
    for (let iq = 0; iq < ds.qpoints.length; iq++) {
      const qp = ds.qpoints[iq];
      const dims = M.commensurateDims(qp.q);
      const sc = M.buildSupercell(ds.cell, dims);
      for (const ib of [0, 2, 3, 5]) {
        const f = qp.freqs[ib];
        if (Math.abs(f) < 0.05) continue; // acoustic at Γ
        const eig = qp.eigvecs.subarray(ib * ds.natom * 6, (ib + 1) * ds.natom * 6);
        const pattern = M.modePattern(sc, qp.q, eig, 0);
        const d1 = M.maxDisplacement(M.frozenDisplacement(pattern, sc.masses, 1, new Float64Array(sc.natom * 3)));
        const qMax = 0.03 / d1;
        const scan = await runModeMapScan(runner, sc, pattern, amplitudeGrid(-qMax, qMax, 9));
        const fit = fitPolynomial(scan.Q, scan.energies, { degree: 4, evenOnly: true });
        const an = analyzeFit(fit, -qMax, qMax);
        out.push({ q: qp.q, ib, dims, natom: sc.natom, phonopy: f, fit: an.frequencyTHz, potential });
      }
    }
    return out;
  }, BAND_YAML);

  H.check('NEP runner was used', results.length > 0 && results[0].potential === 'nep', results[0]?.potential);
  for (const r of results) {
    const rel = Math.abs(r.fit - r.phonopy) / Math.abs(r.phonopy);
    H.check(`q=(${r.q.join(',')}) band ${r.ib + 1} [${r.dims.join('x')}, ${r.natom} atoms]: fit ${r.fit.toFixed(4)} vs phonopy ${r.phonopy.toFixed(4)} THz`,
      rel < 0.01 && Math.sign(r.fit) === Math.sign(r.phonopy), `rel. dev. ${(rel * 100).toFixed(2)} %`);
  }
  H.check('an imaginary mode was among the checks', results.some((r) => r.phonopy < -0.5));

  // ---- Bohr path: phonopy.yaml (calculator qe) + band.yaml in Bohr ----------
  const qe = await page.evaluate(async ({ pq, bq }) => {
    const cv = await import('./core/crystal-viewer.js');
    const S = await import('./phonon/phononSession.js');
    const M = await import('./phonon/phononMath.js');
    const { runModeMapScan } = await import('./phonon/modeMapScan.js');
    const { fitPolynomial, analyzeFit, amplitudeGrid } = await import('./phonon/modeMapFit.js');
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const before = S.phononState.dataset.cell.lattice.map((r) => r.slice());
    const freqsBefore = Array.from(S.phononState.dataset.qpoints[1].freqs);
    S.setLengthUnit('auto');
    await cv.loadStructure(pq, 'phonopy.yaml');
    await cv.loadStructure(bq, 'band.yaml');
    const ds = S.phononState.dataset;
    const latErr = Math.max(...ds.cell.lattice.flat().map((v, i) => Math.abs(v - before.flat()[i])));
    const rawA = ds.cellRaw.lattice[0][1];
    const freqErr = Math.max(...Array.from(ds.qpoints[1].freqs).map((f, i) => Math.abs(f - freqsBefore[i])));
    // Mode map at X band 1 (imaginary) in the converted cell.
    const qp = ds.qpoints[1];
    const dims = M.commensurateDims(qp.q);
    const sc = M.buildSupercell(ds.cell, dims);
    const eig = qp.eigvecs.subarray(0, ds.natom * 6);
    const pattern = M.modePattern(sc, qp.q, eig, 0);
    const d1 = M.maxDisplacement(M.frozenDisplacement(pattern, sc.masses, 1, new Float64Array(sc.natom * 3)));
    const qMax = 0.03 / d1;
    const { runner } = await ensureCalculatorRunner(() => {});
    const scan = await runModeMapScan(runner, sc, pattern, amplitudeGrid(-qMax, qMax, 9));
    const fit = fitPolynomial(scan.Q, scan.energies, { degree: 4, evenOnly: true });
    const an = analyzeFit(fit, -qMax, qMax);
    return {
      unit: S.effectiveLengthUnit(), detected: S.phononState.detectedUnit, calculator: S.phononState.cells?.calculator,
      latErr, rawA, aA: ds.cell.lattice[0][1], shownA: S.phononState.structure.lattice[0][1], freqErr,
      phonopy: qp.freqs[0], fit: an.frequencyTHz,
    };
  }, { pq: PHONOPY_QE_YAML, bq: BAND_QE_YAML });
  H.check('QE phonopy.yaml detected: calculator qe, cells in Bohr', qe.detected === 'bohr' && qe.calculator === 'qe' && qe.unit === 'bohr', JSON.stringify(qe));
  // 1e-6 Å: phonopy's Bohr (0.5291772074) and CODATA 2018 (0.5291772109) differ at 7e-9 relative.
  H.check('Bohr band.yaml converts to the same Å cell (raw 5.329 Bohr -> 2.82 Å) and the shown structure follows',
    qe.latErr < 1e-6 && Math.abs(qe.rawA - 5.3290277) < 1e-6 && Math.abs(qe.aA - 2.82) < 1e-6 && Math.abs(qe.shownA - 2.82) < 1e-6, JSON.stringify(qe));
  H.check('frequencies identical between the eV/Å and Ry/Bohr files', qe.freqErr < 1e-6, `${qe.freqErr}`);
  H.check(`Bohr path mode map at X: fit ${qe.fit.toFixed(4)} vs phonopy ${qe.phonopy.toFixed(4)} THz`,
    Math.abs(qe.fit - qe.phonopy) / Math.abs(qe.phonopy) < 0.01);
  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real[0] || '');
  await H.finish(browser);
})().catch(H.crash);
