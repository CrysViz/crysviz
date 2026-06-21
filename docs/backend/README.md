# CrysViz backend (optional Python compute server)

CrysViz-native code. This is the **optional** server-side compute backend that
the in-browser app can talk to over Socket.IO for jobs that can't run in the
browser (symmetry generation, MLIP relaxation / MD, etc.). The app works
without it; when running, the relevant panels (`ui/BackendPanel/…`) connect to
it.

This is *not* third-party software — it lives here (rather than in
`docs/external/`) because it is part of CrysViz. It is also not part of the
static front-end that GitHub Pages serves; it is run separately by the user.

## Contents
- `server.py` — Flask + Flask-SocketIO server. Exposes Socket.IO events for
  symmetry (`spglib`, `httk_symgen`) and structure relaxation via ASE + a MACE
  MLIP calculator.
- `demo.html` — a minimal standalone demo of connecting to the backend
  (reference only; the real client lives in `docs/ui/BackendPanel/`).

The MACE model weights `server.py` loads live (as vendored third-party data)
under `docs/external/MACE/mace-mpa-0-medium.model`; `server.py` resolves that
path relative to its own location.

## Running
Requires Python with: `flask`, `flask-socketio`, `spglib`, `ase`, `mace-torch`,
and `httk_symgen`. Then:

```bash
python docs/backend/server.py
```

The app connects to it at `http://localhost:5001` (see `ui/BackendPanel/`).
