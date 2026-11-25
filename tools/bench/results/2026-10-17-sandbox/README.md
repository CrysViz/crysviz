# Potential performance map — sandbox run, 2026-10-17

92 MD runs through the CrysViz MD panel (`tools/browsertest/tests/potentialperf.bench.js`,
before the shared-module rewrite), plotted with `tools/bench/plot_potential_perf.py`.

- Machine: 4 CPU cores, headless Chromium, **software WebGL** (no GPU). Viewer costs are
  therefore much higher than on a real GPU; the potentials ran on the CPU.
- Page cross-origin isolated (`CRYSVIZ_COI=1`), so the multi-threaded PET-MAD build was available.
- **PET-MAD curves use stand-in models**: random weights through mlip.cpp's hand-written PET
  code, 3 MB (XS) and 12 MB (S), because Hugging Face was unreachable. The published
  `pet-mad-xs.gguf` (16 MB) and `pet-mad-s.gguf` (95 MB) are graph-exported models with larger
  layers; expect them to cost more per step. Measure them with the Debug window's Benchmark tab
  (`index.html?debug`), which downloads the real files.
- Recorded before the MD viewer/worker overlap (`general.mdPipelineViewer`); NEP on 351–832
  atoms runs 25–65 % faster with it.

Files: `1_throughput.png`, `2_step_breakdown.png`, `3_viewer_options.png`,
`4_threads_worker.png`, `potential_perf.csv` (table view), `potentialperf.json` (raw records).
