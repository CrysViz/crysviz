# Managed Python examples

Install CrysViz first (`python -m pip install -e .`), then run either example
from any directory with `python examples/rotate_camera.py` or
`python examples/raytrace_snapshot.py`. The examples embed their POSCAR, so no
repository-relative input file is needed.

The managed API requires a working native pywebview GUI backend. On Linux
install the `crysviz[qt]` or `crysviz[gtk]` extra and the matching system GUI
backend. The separate `crysviz` CLI supports `--browser`; these examples do
not parse that option.

The rotation example performs a short orbit and waits for the window to close.
The ray-tracing example writes `crysviz-raytrace.png` in the current directory,
prints its resolved path, and also waits for manual window close. Ctrl-C or a
context exit closes the managed window and cleans up its private host.
