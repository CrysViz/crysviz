# Browser tests (playwright-Firefox + Xvfb)

End-to-end tests that run the real app with real WebGL and assert on both the
live scene state and the rendered pixels. Built to work in sandboxed agent
environments without root and without a display:

- **Chrome/Chromium cannot run** where the virtual address space is capped
  (agent sandboxes): V8's sandbox needs a ~1 TB reservation, renderers die
  with "V8 process OOM". Don't try to fix this; use Firefox.
- **Headless Firefox has no WebGL** ("Exhausted GL driver options"), so
  playwright's Firefox runs **non-headless against a private Xvfb** with Mesa
  software GL. The `MOZ_DISABLE_*_SANDBOX` env vars are required (content
  processes segfault otherwise); `run.sh` sets all of this up.

## Usage

```bash
make browsertest-setup   # one-time: ~180 MB into tools/browsertest/env/ (gitignored)
make browsertest         # run all tests/*.test.js
tools/browsertest/run.sh tests/celoutline.test.js   # run one test
tools/browsertest/run.sh tests/tracerbench.bench.js # tracer micro-benchmark (opt-in)
```

The `.bench.js` suffix keeps a file OUT of the default `tests/*.test.js` glob,
so it never runs under `make browsertest` — pass it to `run.sh` by hand. The one
bench today, `tracerbench.bench.js`, times `pipeline.render()` for the ray/path
tracers over a 3x3x3 YBCO supercell and prints `ms/sample` (with the scene's
primitive counts). It forces a GPU sync with a 1-px `readRenderTargetPixels`
after the render burst — WebGL submission is async, so without a readback it
would time command submission, not the trace. It is a software-GL (llvmpipe)
proxy, so absolute numbers are machine-dependent, but it is fetch/ALU-sensitive,
which makes before/after comparisons of tracer-shader changes meaningful.

Each test is a standalone node script (CommonJS) using `harness.js`; exit code
0/1 per test, `run.sh` aggregates. Screenshots land in `artifacts/`
(gitignored) — inspect them on failure.

## Writing tests

See `tests/*.test.js`. The key techniques:

- **Live app state**: ES modules are cached per URL, so inside
  `page.evaluate`, `await import('./state/store.js')` returns the *same*
  singletons (`app`, `groups`, `general`, `fileBrowser`) the app uses. Read
  scene state, or call exported app functions (`core/crystal-viewer.js`
  `loadStructure`, `render/index.js` updaters, ...).
- **Drive the real UI** rather than internals where possible:
  `H.clickById`, `H.setSelect` / `H.setSlider` (dispatch `change`/`input`).
- **Assert pixels, not just state**, for rendering claims:
  `H.shotCanvas(page, name)` + `H.darkFraction(file)` (near-black coverage).
- `H.waitFor(page, fn)` polls an in-page condition (async computes like
  polyhedra).
- Always end with the `errors.length === 0` check and `H.finish(browser)`.

`defaultPOSCAR` (YBCO) is the go-to structure: it produces polyhedra, plenty
of bonds, and mixed elements.
