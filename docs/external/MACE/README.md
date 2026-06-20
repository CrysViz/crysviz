# MACE-MPA-0 (medium) foundation model

Pretrained machine-learned interatomic potential weights used by the optional
CrysViz compute backend (`docs/backend/server.py`, via `mace_mp(...)`) for
structure relaxation / MD.

- File: `mace-mpa-0-medium.model` (~79 MB).
- Model: **MACE-MPA-0**, *medium* size — a MACE foundation model.
- Upstream: the MACE project — https://github.com/ACEsuit/mace
  (the "MPA" training set combines Materials Project + Alexandria data).
- License / terms: governed by the upstream MACE model release — **verify the
  current terms upstream before redistributing.**

This is third-party model data, so it lives under `docs/external/`. It is *not*
part of the static front-end (the GitHub-Pages deploy serves `docs/`, but this
model is only loaded server-side by the backend).

> Note: at ~79 MB this is a large binary in git history. It is kept tracked by
> choice; if repo size becomes a concern, consider Git LFS or fetching it
> out-of-band.
