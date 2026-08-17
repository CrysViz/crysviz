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
  every Fontsource subset) plus U+2011 (non-breaking hyphen) with
  fonttools 4.63. Same OFL 1.1 license (`OFL.txt`); it is exposed only
  under the `CrysViz Sans` @font-face name.
- Symbol coverage for the UI's textual icons, all exposed as additional
  `CrysViz Sans` faces with narrow `unicode-range`s:
  - `noto-sans-symbols2-400-normal.woff2` — unmodified "symbols" subset of
    Noto Sans Symbols 2 from `@fontsource/noto-sans-symbols-2` 5.3.0
    (`OFL-symbols2.txt`).
  - `noto-sans-symbols1-extras-wght-normal.woff2` — Modified Version of
    Noto Sans Symbols (variable TTF from
    https://github.com/google/fonts/tree/main/ofl/notosanssymbols) subset
    to U+2460–24FF and U+26F6 with fonttools (`OFL-symbols.txt`).
  - `noto-emoji-extras-wght-normal.woff2` — Modified Version of Noto Emoji
    (monochrome; variable TTF from
    https://github.com/google/fonts/tree/main/ofl/notoemoji) subset to
    U+269B, U+1F313, U+1F4C1–1F4C2, U+274C with fonttools
    (`OFL-emoji.txt`). Deliberately monochrome so these glyphs render
    identically on every platform instead of as per-OS color emoji.
