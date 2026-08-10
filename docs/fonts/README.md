# Bundled fonts

Noto Sans (variable-weight, wght 100–900, per-script subsets) and
Noto Sans Math (static 400), bundled so text renders identically on every
platform instead of falling back to whatever the OS ships.

- Source packages: `@fontsource-variable/noto-sans` 5.3.0 and
  `@fontsource/noto-sans-math` 5.3.0 (unmodified `.woff2` files from the
  Fontsource build of Google's Noto fonts; upstream
  https://github.com/notofonts / https://fonts.google.com).
- License: SIL Open Font License 1.1 — see `OFL.txt` (Noto Sans) and
  `OFL-math.txt` (Noto Sans Math) in this directory. Keep these files next to
  the `.woff2` files when moving or replacing them.
- The `@font-face` rules in `styles/fonts.css` expose these files under the
  self-hosted family names `CrysViz Sans` and `CrysViz Sans Math` so CSS can
  never silently resolve to a system-installed Noto Sans of a different
  version. The font binaries themselves are NOT modified or renamed.
- Subsets intentionally bundled: latin, latin-ext, greek, greek-ext,
  cyrillic, cyrillic-ext (+ math). Devanagari and Vietnamese subsets exist
  upstream and were deliberately omitted; add them from the same package
  version if ever needed.
- `noto-sans-subsuper-wght-normal.woff2` is a Modified Version (in OFL
  terms) of Noto Sans: the official variable TTF from
  https://github.com/google/fonts/tree/main/ofl/notosans, width axis pinned
  to 100 and subset to U+2070–209F (superscripts/subscripts, absent from
  every Fontsource subset) with fonttools 4.63. Same OFL 1.1 license
  (`OFL.txt`); it is exposed only under the `CrysViz Sans` @font-face name.
