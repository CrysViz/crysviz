# Debug

Live memory and playback figures for hunting leaks and stalls. Only present when the page was
opened with `?debug` on the URL (`index.html?debug`); ordinary sessions never see it, and share
links made while it is open drop the parameter.

**Memory** is mostly *accounted*, not measured: a browser cannot attribute its heap to one object,
so the panel walks what each loaded structure or trajectory references and sums the real size of
every typed array plus a fixed estimate per object, array, map and string. Exact for the frame
store's positions, forces and moments; an estimate for the rest. Three more series cover what no
container owns: **app state** (the global id registry, bond-length and coordination tables, the
wrapped periodic copy, measurements, hover/selection state), **scene buffers** (the CPU-side
geometry attributes, index and instance matrices of everything in the three.js scene) and, in
Chromium, the **JS heap** the browser itself reports for the whole page. Growth in the heap that
none of the accounted series shows is in something not walked: renderer-internal objects, DOM,
closures, workers. The values are meaningful relative to themselves over time, which is what a
leak shows.

- **frame / shown / render** — the frame the selected row is showing, frames applied to the scene
  per second during playback, and frames actually drawn per second by the on-demand render loop.
- **JS heap** — `performance.memory` where the browser has it (Chromium); the whole page, coarse.
- **cost @ tick** — main-thread milliseconds of this tick's accounting walk plus this window's own
  plots and tables on the previous tick, and the sampling interval. The walk is repeated only
  every tenth of its own duration (a 60 ms walk at most every 600 ms; the memory series step in
  between), and the plots redraw in one batch every two seconds and not at all while the window is
  hidden, so watching the window costs playback as little as possible.
- **scene** — wall time per rendered frame and the frame rate the scene alone could sustain
  (1000 / ms). Without **Bench render** this is the CPU submit time of on-demand frames; with it,
  every animation frame renders, the animate loop's cap is lifted and each frame blocks on the GPU
  before it is timed, so the figure is the whole scene's real cost. Pair it with the Trajectory
  panel's **max** speed to benchmark playback.
- **fast / full** — playback frames per second that took the render fast path (atoms and bonds
  moved in place, bond topology kept from the last full rebuild) versus a full atoms-and-bonds
  rebuild. Only a *trajectory* gets the fast path; every 20th frame and every settle rebuild.
- **kind** in the table — `trajectory`: one system in motion (same composition throughout,
  consecutive frames within 1 Å per atom, cell nearly constant); `dataset`: unrelated structures
  sharing a file, drawn with a full exact rebuild on every frame; `eager`: all frames held as
  Structures.
- **live / frames** in the table — materialised frames over frames. A store-backed trajectory
  keeps exactly one Structure alive; a growing count is a leak. **switches** counts frame
  changes through the live Structure: shown / reused (cheap rewrite) / rebuilt (new Structure) /
  detached (overlay or copy) / pristine (as-loaded snapshot materialised).

The **Renderer & registries** card counts live GL geometries / textures / programs, objects in the
scene graph and ids in the global registry: things that leak without moving a byte figure the
model can see. Ids must not climb during playback (bond ids are released on every rebuild).

Vertical markers record loads, removals, play/pause, proper frame loads, GC hints and your own
**Mark** entries. **Clear** drops the recorded history and empties the plots; sampling goes on. **GC hint** calls `gc()` where the browser exposes it (Chromium started with
`--js-flags=--expose-gc`) and evicts unpinned volumetric-field caches. **CSV** downloads the whole
recorded history. Sampling keeps running while this window is closed.

## Benchmark tab

Measures how fast in-browser MD runs **on this machine**, with the browser's own GPU for drawing and
(where the browser has it) WebGPU for PET-MAD. Pick potentials, cells and viewer options and press
**Run**: each combination loads the default cell (or an n×n×n supercell of it) as an extra row,
runs a short MD simulation through the MD panel and removes the rows again. PET-MAD models are
downloaded on first use (`models` can point at a local folder such as `./bench-models/`).

- **Potentials** — NEP89; PET-MAD-XS and -S on the CPU (in their worker), with **WebGPU** (where the
  browser offers it), and XS on the main thread (what PET-MAD did before it moved to a worker; this
  one freezes the page while it runs).
- **PET-MAD CPU threads** — each PET-MAD CPU row runs once per ticked thread count: **auto** (per
  cell size the fastest of all cores, one and half, as the MD panel does), 1, 2, 4, … up to all
  cores. More than one thread needs a cross-origin isolated page: the line above the form says
  whether this page is, and **Enable multi-threading** turns it on. The page reloads, losing loaded
  structures, runs still going and results not downloaded, so CrysViz asks first; open Debug →
  Benchmark again afterwards. It is the same switch as "multi-threaded" in the PET-MAD controls.
- **PET-MAD CPU matrix kernel** — how the CPU multiplies matrices: the **blocked GEMM** (the
  default) or ggml's **dot products** (what earlier builds did). Tick both for an A/B comparison;
  they give the same forces to float precision.
- **PET-MAD WebGPU readback** — how WebGPU results come back: through a **canvas snapshot** (the
  default, used where the browser returns it exact) or with **mapAsync** (what earlier builds did;
  Firefox answers it only every ~100 ms). Tick both for an A/B comparison; the CSV column
  `gpuReadback` says which one actually ran.
- **PET-MAD WebGPU matrix kernel** — the GPU kernel for the matrix products, most of a WebGPU
  step: **vec4 tiles** (the default) or the **register tiles** of earlier builds, which Firefox
  and Safari run several times slower. Tick both for an A/B comparison; the CSV column
  `gpuMatmul` says which one ran.
- **Viewer** — a ladder: atoms only, + bonds, + periodic images (boundary images and bonded
  neighbours across the cell), + a force colour map (which recolours every atom and bond every frame).
- **Results** — steps per second; per step, the time spent waiting for the potential and updating
  the 3D view; the longest page freeze; the CPU threads PET-MAD used. The chart plots steps per
  second against atoms for one viewer option (dot-product and mapAsync runs drawn faded with hollow
  points).
  **JSON** downloads everything for `tools/bench/plot_potential_perf.py` (the combined figures),
  **CSV** the table; both record the thread count asked for and used, and the matrix kernel, and
  for PET-MAD where one evaluation spends its time: inside the wasm the neighbour list and inputs,
  graph build, allocation, graph compute (on WebGPU split into encoding + submitting and waiting
  for the GPU) and reading the results, and outside it the worker round trip.
- **WebGPU round trip** — where WebGPU works, the line above the form also shows how long one wait
  for the GPU takes (a tiny copy read back), on the page and in a worker. Every PET-MAD WebGPU step
  waits once, so this is its floor. The JSON keeps both, with the GPU adapter. After it, **canvas
  readback** times the same wait through a WebGPU canvas snapshot (2D `drawImage` +
  `getImageData`, and `VideoFrame.copyTo`) and says whether the bytes came back exact. Snapshots
  are synchronous, so they may avoid a slow round trip. **Kernel launch** times 512 tiny GPU
  kernels in one pass, the way PET-MAD's WebGPU build issues its ~560 per step (each with its own
  bind group), and once reusing a single bind group: microseconds per kernel.

Close other heavy tabs while it runs: PET-MAD on all threads competes with everything else for the
CPU.

## Tracer tab

Compares the tracers' noise, old and new, on the current view with the active tracer (Visual ▸
Render: **Ray tracing** or **Path tracing**), rendered in this browser on its GPU. Old: a ray passed a
surface with opacity below 1 at random, and the ray tracer aimed its soft-shadow rays (**Light
softness**), glass frost and metal roughness with plain random numbers — grainy at the 64 samples a
render (and each PNG-export tile) stops at. New: each see-through surface is blended exactly with what
lies behind it and a shadow ray keeps 1 − opacity of the light (up to four layers; deeper ones, and in
path tracing those met after a bounce, still pass at random), and those directions come from a
stratified sequence that covers the light evenly over the samples. Both converge to the same picture.

See-through polyhedra or atoms, the ground plane and a soft light show the difference best; then
**Render old / new**: both at the chosen number of **samples**, side by side;
click one for full size (or to save it). With **error against 8× samples**, a reference is rendered
the new way at eight times the samples, and each image shows its mean difference to it (0–255) over
the pixels that are not plain background: lower is less noise. Each image also gives its render time: the exact
way traces every see-through layer per sample, so a sample costs more, but far fewer are needed.
Keep the view still while it renders.
