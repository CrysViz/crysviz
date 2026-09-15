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
