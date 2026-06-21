# MACE-MPA-0 (medium) foundation model

Pretrained machine-learned interatomic potential weights used by the optional
CrysViz compute backend (`backend/server.py`, via `mace_mp(...)`) for
structure relaxation / MD.

- File: `mace-mpa-0-medium.model` (~79 MB).
- Model: **MACE-MPA-0**, *medium* size — a MACE foundation model.
- Upstream: the MACE project — https://github.com/ACEsuit/mace
  (the "MPA" training set combines Materials Project + Alexandria data).
- License / terms: governed by the upstream MACE model release — **verify the
  current terms upstream before redistributing.**

This is third-party model data used only by the backend, so it lives under
`backend/external/` (outside the served `docs/` app) and is never published to
GitHub Pages — the deploy serves only `docs/`.

> Note: at ~79 MB this is a large binary in git history. It is kept tracked by
> choice; if repo size becomes a concern, consider Git LFS or fetching it
> out-of-band.
