# Memory at scale — 2026-10-19 (headless sandbox)

`tools/browsertest/tests/memstress.bench.js`, Chromium, 4 cores, SwiftShader
software GL (no GPU), cross-origin isolated (`CRYSVIZ_COI=1`). Heap = main-thread
JS heap after a forced GC (CDP). PSS = whole Chromium process tree from /proc.

```
CRYSVIZ_COI=1 CRYSVIZ_BROWSER=chromium tools/browsertest/run.sh tests/memstress.bench.js
```

## A. Trajectory playback (Si supercell, thermally moving)

| atoms | frames | heap idle | after load | after 2 Auto + 1 Full loop | after delete (before fix) | after delete (fixed) | Auto ms/frame | Full ms/frame |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,728 | 60 | 7 MB | 12.8 MB | 13.5 MB | 18.2 MB | 8.2 MB | 13 | 75 |
| 8,000 | 40 | 7 MB | 33.3 MB | 34.1 MB | 50.4 MB | 8.5 MB | 65–98 | 303 |
| 21,952 | 20 | 7 MB | 80.5 MB | 81.2 MB | 98.3 MB | 9.6 MB | 126–139 | 867 |
| 54,872 | 10 | 7 MB | 190 MB | 191 MB | 206 MB | 11.6 MB | 342–469 | – |

- No growth between playback loops at any size (≤ 0.4 MB).
- Atom impostors switch on above 20k atoms as designed.
- One loaded frame costs ~3.4 KB of heap per atom (≈ 75 % JS objects:
  Atom/Bond objects, array positions, Vector3s, colour strings; the frame
  store itself is compact typed arrays).
- Render times are not meaningful here: SwiftShader stalls for seconds on
  large frames.

## B. NEP MD, 1,625 atoms, 400 steps (stride 4 → 101 frames)

| | heap | PSS |
|---|---:|---:|
| before (NEP runner loaded) | 18.1 MB | 563 MB |
| during the run (sampled) | 120–260 MB, GC sawtooth, no trend | 800–910 MB |
| after MD | 36.9 MB | 765 MB |
| after deleting the MD row (before fixes) | 41 MB (+23 MB) | 760 MB |
| after deleting the MD row (fixed) | 19.2 MB (+1 MB) | 738 MB |

## C. PET-MAD (xs) in its worker, threaded wasm (4 threads)

| atoms | PSS warm | PSS +10 evals |
|---:|---:|---:|
| 13 | 630 MB | 630 MB |
| 104 | 908 MB | 971 MB |
| 351 | 1,795 MB | 1,775 MB |
| 832 | 2,681 MB | 2,637 MB |
| worker destroyed | 402 MB | |

No growth from repeated evaluations. Memory grows ~2.5 MB per atom (the graph
architecture's autograd buffers), so a single in-browser evaluation tops out
near ~1,400 atoms against wasm32's 4 GB. The browser's own
`measureUserAgentSpecificMemory` reports 3–10 GB here — it counts the threads'
shared wasm memory once per thread; PSS is the real figure.

## Leaks found and fixed

1. `crystal-viewer.js` `loadStructure` ended with a stray
   `console.warn(fileBrowser.selectedStructure)`: the console kept every loaded
   structure (and its trajectory store) alive while DevTools / a driver is
   attached.
2. The global `usedIDs` registry: the .xyz reader registered one id per atom
   per frame (then discarded the objects); deleted rows never released ids;
   MD/relax working copies kept their last bond ids.
3. Deleting a row did not rebuild the open panels: the Trajectory panel's
   handlers kept driving — and holding — the deleted trajectory.

Pinned by `tools/browsertest/tests/trajleak.test.js`.

## After the columnar port (step 3/4: deferred frame physics, direct bond matrices, motion-gated topology, columnar xyz load)

Same bench, same sandbox, with two other browser suites sharing the 4 cores
(timings are pessimistic). 10 frames each.

| atoms | bonds | load | heap after load | PSS | Auto update ms/frame | heap after delete |
|---:|---:|---:|---:|---:|---:|---:|
| 54,872 | 110k | 4.3 s (was 16.5 s) | 165 MB (was 211 MB) | 629 MB | 93–100 (was 330–470) | 11.5 MB |
| 110,592 | 221k | 5.4 s | 326 MB | 922 MB | 161–195 | 15 MB |
| 216,000 | 432k | 13.0 s | 628 MB | 1.46 GB | 204–396 | 23 MB |

Uncontended profile of one fast frame at 216k atoms: ~123 ms of JS (bond
matrices 41, Bond object endpoints 36, bond loop 35, atom positions 8). At 22k
atoms: 54 → 13 ms/frame averaged over a loop (the periodic full rebuild no
longer runs every 20th frame for large structures).

Files: `memstress-columnar-55k-110k.json` (the 216k entry of that run hit the
runner's 900 s per-file limit; software-GL renders take 20–45 s each here) and
`memstress-columnar-216k.json`.

## Round 2: playback bonds in step with the atoms (2026-10-20)

Bonds now form and break per frame from a neighbour list with a 1 Å skin
(render/PlaybackBondsModule.js) instead of waiting for a topology rebuild;
large structures no longer rebuild for bonds during playback.
`memstress-playback-bonds.json`, idle machine except software-GL renders:

| atoms | load | heap after load | update ms/frame (Auto loops; software-GL stalls in between) | heap after delete |
|---:|---:|---:|---:|---:|
| 54,872 | 2.4 s | 165 MB | 41–64 | 11.5 MB |
| 110,592 | 6.2 s | 326 MB | 100–118 | 15 MB |
| 216,000 | 16.1 s | 628 MB | 178–271 | 23 MB |

Clean CPU profile of one fast frame at 216k atoms (432k bonds), same
conditions back to back: 148 ms before the candidate bonds, 137 ms with them
(bond writer then shares one rotation per bond).

## Round 3: a responsive app at 216k atoms (2026-10-20)

The player and the display toggles, timed in the app at 216,000 atoms and
432,000 bonds. The probe clicks the real controls and waits until the main
thread is free; a toggle that runs behind the busy strip is timed until its
rebuild is done. Each column ran back to back on an otherwise idle machine
with software GL: b142053 against 21fd41e.

| action | before | after |
|---|---:|---:|
| step forward (click) | 6.7 s | 0.6 s (first), 0.3 s |
| scrubber drag, per input event | 3.7–4.2 s | 0.10–0.12 s |
| scrubber release | 4.2 s | 0.36 s |
| pause | 5.4 s | 0.35 s |
| main-thread latency during 3 s of playback (median / max) | 94 ms / 4.7 s | 4 ms / 0.15 s |
| periodic images off / on | 4.1 / 3.7 s | 2.2 / 1.9 s, strip running |
| bonds on | 4.1 s | 1.3 s, strip running |

What changed:

- **Settle.** Pause, step and scrubber release take the render fast path on
  20,000+ atoms (`ui/TrajectoryPanel.js` settleFrame). Dragging never
  rebuilds. `largesettle.test.js` checks that the atoms and bonds match a full
  rebuild of the frame exactly.
- **Scheduler.** Playback is self-scheduled, with at least half of a slow
  frame's cost left idle before the next frame.
- **Pause first.** While a large trajectory plays, the bonds, periodic images,
  neighbour bonds and polyhedra toggles are greyed out with a "pause first"
  hint. When paused, they run behind the ray tracer's progress strip in busy
  mode (`ui/HeavyRebuild.js`, `heavytoggles.test.js`). The strip animates
  `transform` only. A trace shows the compositor drawing 54 frames during a
  1.5 s main-thread block with the strip on, and none without it.
- **Rebuild allocations.** Profiled `updateVisualization` for the periodic
  toggle went from 6.0–7.7 s to 2.3–2.9 s. Garbage collection went from
  4.2 s to 1.2 s.
  - V8 boxes every double-valued object field, so a Bond's 22 numbers were 22
    heap objects. They now live in shared Float64Array records
    (`model/Bond.js`), and the bond matrices are written from the record.
  - Per element pair the elements, default colours and options are shared;
    the ids and index arrays are built lazily.
  - Per-half [bond, half] arrays are built on lookup, and per-atom lists are
    sized up front.
  - Image-style and focus-region lookups are skipped when none are set.

## Round 4: colour maps during playback (2026-10-21)

Colouring atoms by force, or bonds by length, used to make every playback
frame a full rebuild: the fast path only moved instances, so it gave way to
the full path whenever those colours had to change. Only the colours change,
though, so the fast path now recolours the instances it moves
(`render/FrameColorsModule.js`). It uses the same binning as a full rebuild
(`render/ColorMapBins.js`) and the same precedence: a per-copy style, then an
atom's user colour, then a bond's user or category colour, then the map. The
model's `atom.color` / `bond.color` follow, and the player's "full render each
frame" note is gone.

Per frame at 216,000 atoms with bonds shown, on the same machine and run:

| colour mode | full rebuild (was every frame) | fast frame now |
|---|---:|---:|
| elements (unchanged) | 3.2 s | 0.09–0.11 s |
| atoms by force, bonds following them | 5.8–6.0 s | 0.15–0.23 s |
| bonds by length | 2.6–2.7 s | 0.10–0.13 s |

`colormapfast.test.js` checks the result against a full rebuild of the same
frame, in each mode. It compares atom instances, bond and candidate-bond
halves, and the model colours; all must match exactly, including with a user
atom colour and with the log scale. It also checks that a 22k-atom trajectory
with a force map plays without a single full rebuild.

The bond builder's length colouring now honours the bond map's log scale. It
had always been linear, unlike the Colors panel and the colour bar.

Main-thread update per playback frame (fast path, bonds shown, median after
warm-up; same idle 4-core sandbox). The force-map columns are after the
follow-up that resets frame styles without loading positions; before it, a
force frame cost 26 / 47 / 85 / 188 ms.

| atoms | elements | force map | length map | force + length |
|---:|---:|---:|---:|---:|
| 21,952 | 8 ms | 14 ms | 9 ms | 9 ms |
| 54,872 | 17 ms | 35 ms | 26 ms | 41 ms |
| 110,592 | 39 ms | 61 ms | 57 ms | 72 ms |
| 216,000 | 71 ms | 152 ms | 92 ms | 139 ms |

The player leaves at least half a frame's cost idle before the next frame, so
a frame period is at least 1.5 × the update. 15 fps (66.7 ms) therefore needs
an update of 44 ms or less, at the 0.05 s speed setting:

| colour mode | atoms at 15 fps |
|---|---|
| none | about 120k |
| force map | about 70k |
| length map | about 85k |
| both | about 60k |

These are interpolated from the table above. GPU time is not included (this
sandbox renders in software).

## Round 6: picking on a large trajectory (2026-10-22)

Report: picking an atom on a 50k-100k-atom trajectory stalled for a long
time, the atom was not highlighted, and colour edits did not respond.

Cause: a 3D pick opens the Structure window on the picked atom's row, and the
list was built whole, one heavy row per atom of the element. Each row carries
its own colour picker, material editor and spin/force editor. On 51,984 Si
atoms the renderer grew to 9.4 GB and had not finished after 13 minutes. Any
later composition rebuild, such as a colour Reset, rebuilt the open list.

Fix: lists longer than 1,000 rows (atoms, bonds, polyhedra) show 100 rows per
page with a pager. A pick opens the page that holds its row. Two further
fixes:

- Bond and polyhedron rows share one pass over the atoms for their "Si12"
  numbering. Before, each row scanned every atom twice.
- The colour-map table is built once. Before, the force recolour on Reset
  rebuilt it for every atom.

Main-thread time on the 51,984-atom force-coloured trajectory (paused; same
sandbox; the frame drawing that follows, in software GL here, is excluded):

| action | before | after |
|---|---:|---:|
| pick an atom (row list revealed) | did not finish (> 13 min, 9.4 GB) | 0.46 s |
| double-click on the canvas (raycast + pick) | did not finish | 0.69 s |
| pick a bond (103,968 Si-Si bonds) | not measured (whole list); 4.6 s with paging alone | 0.57 s |
| colour picker drag step | — | 45 ms |
| colour Reset | — | 0.67 s (1.65 s before the table cache) |

"—": not reachable before the fix (the pick never finished).

While playing, a pick takes 0.36 s and playback keeps its rate. A selected
atom keeps its highlight colour on force-map frames.

### Trajectory memory limit

Settings ▸ Memory ▸ "Trajectory memory" (default 2 GiB) caps a loaded
trajectory's frames. A larger one asks what to load: every n-th frame, the
first frames that fit, everything with the limit raised to fit, or everything
this once. For .xyz the estimate comes from the start of the file, before
parsing, and a reduced load reads only the kept frames. Other formats are
trimmed right after parsing.

The 1.14 GB file, 101,568 atoms × 200 frames with forces:

| | estimate | actual |
|---|---:|---:|
| frames | 202 | 200 |
| frame memory | 939 MiB | 930 MiB |

The dialog appears 1.9 s after the file is chosen. With a 0.5 GiB limit and
"every 2nd frame", the load holds 100 frames and 488 MB of frame data, with
the renderer at 1.08 GB, against 1.55 GB for the full load.

Worker parse time:

| plan | frames | parse time |
|---|---:|---:|
| full | 200 | 28 s |
| every 2nd | 100 | 21 s |
| first 100 | 100 | 13.5 s (stops reading) |
