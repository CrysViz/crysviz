# periodic_wasm

WASM-accelerated drop-in for `periodicWrapped`.

## Build

```bash
# Install wasm-pack once
cargo install wasm-pack

# Build for the web target (outputs to pkg/)
wasm-pack build --target web --release

# Or for bundlers (Vite, Webpack)
wasm-pack build --target bundler --release
```

This produces `pkg/periodic_wasm.js` and `pkg/periodic_wasm_bg.wasm`.
Copy both (plus `periodicWasm.js`) next to your viewer source.

## Usage

```js
// main.js (top-level, run once)
import { initPeriodicWasm, periodicWrapped } from './periodicWasm.js';
await initPeriodicWasm('/assets/periodic_wasm_bg.wasm');

// Anywhere in viewer code – identical call site, same return shape:
const { elements, frac, cart, srcIndex } = periodicWrapped(general, frac, elements, lattice);
```

## What changed vs the JS version

| | JS | WASM |
|---|---|---|
| Boundary atom duplication | O(N) JS objects + eps arithmetic | Same algorithm, tight Rust loops |
| Ghost-atom inner loop | O(W × N × S) with Set string keys | O(W × N × S) with u64-keyed HashSet |
| frac↔cart conversions | Per-atom JS calls | Inline matrix–vector multiplies |
| Memory | Many tiny arrays | One contiguous allocation per run |
| GC pressure | High (new arrays inside loops) | None |

### Key algorithmic note: ghost key encoding

The original uses string keys `"j:dx,dy,dz"`.  The Rust version encodes
the same information as a single `u64`:

```
key = (j << 12) | ((dx+4) << 8) | ((dy+4) << 4) | (dz+4)
```

dx, dy, dz ∈ [-2, 2] fit in 4 bits each after the +4 offset.  This makes
HashSet lookups ~5× faster than hashing a string.

### Complete Rings & Fragments (`src/fragments.rs`)

With a non-empty `fragment_table`, `periodic_wrapped` adds the atoms that fragments and small
rings cut by a cell face need from the neighbouring cells, between the boundary set and the
Neighbour Bonds ghosts. It builds the periodic bond graph of the primary atoms (shared
`CellList`, fractional mode), splits it into components with per-atom unwrap shifts, draws every
finite component whole for each copy that has a displayed atom, and in extended components
closes the smallest rings (≤ `max_ring` atoms, atoms of degree ≤ 4) through bonds that leave the
displayed set. `docs/render/FragmentCompletion.js` is the JS twin; `cargo test` covers both
kinds of structure.
