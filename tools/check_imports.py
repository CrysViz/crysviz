#!/usr/bin/env python3
"""Static ES-module import checker for CrysViz (docs/).

Two checks that the runtime (no bundler) would otherwise only surface as
load-time failures in the browser:

  1. Resolver        — every relative `import ... from './x.js'` points at a file
                       that exists (catches typos / moved files).
  2. Import-vs-export — every *named* import resolves to an actual export in its
                       source module, following `export { x } from '...'`
                       re-export chains and `export *` (catches the load-time
                       SyntaxError "does not provide an export named 'x'").

Dependency-free (Python 3 stdlib). Exits non-zero if any problem is found, so it
can gate `make check`. Scans docs/ and ignores vendored/compiled/dead code.
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")
IGNORE_DIRS = {"external", "compiled"}


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    # drop // line comments but keep the "://" in URLs/strings reasonably intact
    return re.sub(r"(^|[^:])//[^\n]*", lambda m: m.group(1), src)


def load_files():
    files = {}
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in IGNORE_DIRS]
        for fn in fns:
            if fn.endswith(".js"):
                p = os.path.normpath(os.path.join(dp, fn))
                with open(p, encoding="utf-8", errors="ignore") as fh:
                    files[p] = strip_comments(fh.read())
    return files


def resolve(base, spec, files):
    target = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    for cand in (target, target + ".js", os.path.join(target, "index.js")):
        if os.path.normpath(cand) in files:
            return os.path.normpath(cand)
    return None


def direct_exports(src):
    """Names exported directly, plus re-export module specs (named + star)."""
    names = set()
    for m in re.finditer(
        r"export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)", src
    ):
        names.add(m.group(1))
    if re.search(r"export\s+default", src):
        names.add("default")
    star_from = []
    for m in re.finditer(r"export\s*\{([^}]*)\}\s*(?:from\s*['\"]([^'\"]+)['\"])?", src):
        for part in m.group(1).split(","):
            part = part.strip()
            if part:
                names.add(re.split(r"\s+as\s+", part)[-1].strip())
    for m in re.finditer(r"export\s*\*\s*from\s*['\"]([^'\"]+)['\"]", src):
        star_from.append(m.group(1))
    return names, star_from


def exports_of(path, files, cache, seen=None):
    if path in cache:
        return cache[path]
    seen = seen or set()
    if path in seen:
        return set()
    seen.add(path)
    names, star_from = direct_exports(files[path])
    out = set(names)
    for spec in star_from:
        t = resolve(path, spec, files)
        if t:
            out |= exports_of(t, files, cache, seen)
    cache[path] = out
    return out


IMPORT_RE = re.compile(
    r"import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s*as\s*[A-Za-z0-9_$]+\s*)?from\s*['\"](\.[^'\"]+)['\"]"
)
ANY_REL_RE = re.compile(r"""(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]""")


def main():
    files = load_files()
    cache = {}
    unresolved = []
    invalid_named = []

    for path, src in files.items():
        rel = os.path.relpath(path)
        # 1) resolver
        for m in ANY_REL_RE.finditer(src):
            spec = m.group(1)
            # Vendored/compiled targets are intentionally not scanned (and may be
            # build-generated), so don't flag imports pointing into them.
            if any(part in IGNORE_DIRS for part in spec.split("/")):
                continue
            if not resolve(path, spec, files):
                unresolved.append((rel, spec))
        # 2) import-vs-export
        for m in IMPORT_RE.finditer(src):
            named, spec = m.group(2), m.group(3)
            if not named:
                continue
            t = resolve(path, spec, files)
            if not t:
                continue  # resolver already reported it
            exps = exports_of(t, files, cache)
            for part in named.split(","):
                part = part.strip()
                if not part:
                    continue
                name = re.split(r"\s+as\s+", part)[0].strip()
                if name and name not in exps:
                    invalid_named.append((rel, name, spec))

    n = len(files)
    ok = True
    if unresolved:
        ok = False
        print(f"UNRESOLVED relative imports ({len(unresolved)}):")
        for p, s in unresolved:
            print(f"  {p}  ->  {s}")
    if invalid_named:
        ok = False
        print(f"INVALID named imports ({len(invalid_named)}):")
        for p, name, s in invalid_named:
            print(f"  {p}: '{name}' is not exported by {s}")

    if ok:
        print(f"check_imports: {n} files scanned — all relative imports resolve, "
              "all named imports map to real exports.")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
