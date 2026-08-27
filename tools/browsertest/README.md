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
- **Non-headless does not mean visible.** The browser is pinned to the private
  Xvfb with `GDK_BACKEND=x11` + an unset `WAYLAND_DISPLAY`. Without that, on a
  Wayland desktop — including inside a toolbox/podman container on one, which
  passes the compositor socket through — GTK prefers Wayland over `$DISPLAY`
  and the browser pops a real window on the user's screen mid-run.

## Usage

```bash
make browsertest-setup   # one-time: ~180 MB into tools/browsertest/env/ (gitignored)
make browsertest         # run all tests/*.test.js
tools/browsertest/run.sh tests/celoutline.test.js   # run one test
tools/browsertest/run.sh tests/tracerbench.bench.js # tracer micro-benchmark (opt-in)
```

`setup.sh` installs everything it can without root, but it cannot supply the
two things that need a package manager: **Xvfb**, and the **GTK3 desktop stack
playwright's Firefox is linked against** (a minimal container has neither, and
the failure is a bare `XPCOMGlueLoad error ... libgtk-3.so.0`). It checks for
both at the end and names the fix. On Fedora that is one command:

```bash
sudo dnf install -y xorg-x11-server-Xvfb gtk3 alsa-lib dbus-libs \
     mesa-libGL mesa-libEGL mesa-dri-drivers dejavu-sans-fonts
```

On Debian/Ubuntu, `sudo npx playwright install-deps firefox` covers the
libraries and `setup.sh` vendors Xvfb from the `xvfb` package by itself.
Playwright's own pre-launch host check hard-codes Debian package names, so it
reports a perfectly good Fedora machine as broken — `run.sh` and `setup.sh` set
`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` and check with `ldd` instead.

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
