## Notes

Wasm file created from this github repo (MIT license): https://github.com/bigd4/PyNEP. Looking at its relation with calorine, it is referenced in [CPU_NEP](https://github.com/brucefan1983/NEP_CPU).
I used this because this is what my jax version of NEP is based on, so the porting was relatively easy.

The weights (NEP89) are obtained from the GPUMD repo (!!GPL-3.0), found [here](https://github.com/brucefan1983/GPUMD/blob/master/potentials/nep/nep89_20250409/nep89_20250409.txt)

## Licenses

Two GPL-3.0 licenses apply here and are kept in this directory:
- `LICENSE-GPUMD` — covers the NEP89 weights (`nep89_20250409.txt`), from GPUMD.
- `LICENSE-NEP_CPU` — covers the NEP implementation compiled into the WASM module
  (`nep_wasm.wasm`/`nep_wasm.js`), derived from NEP_CPU.

The WASM build itself originates from PyNEP (MIT); see the note above.
