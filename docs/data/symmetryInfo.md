# Symmetry

Symmetry analysis using the WASM build of [Moyo](https://github.com/spglib/moyo) (from the
developers of spglib), running entirely in your browser — no data is sent anywhere. Detects the
space group and can symmetrize the structure to its conventional or primitive cell. Raise the
tolerance if a slightly distorted structure isn't recognized as symmetric.

The result block reports the Hermann–Mauguin symbol with its ITA number, the Hall symbol, the
Pearson symbol and the protostructure (AFLOW prototype) label
`{anonymous formula}_{Pearson}_{space group}_{Wyckoff sites per element}:{elements}`. In the
Wyckoff part the number in front of a letter is how many distinct orbits of that element occupy
that Wyckoff position — not the site multiplicity — and it is always written, including `1`.

The space group and Hall symbol link to the corresponding page on
[symdata.anyterial.se](https://symdata.anyterial.se), opened at its Wyckoff-positions section.
