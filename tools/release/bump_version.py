#!/usr/bin/env python3
"""Single entry point for the CrysViz version.

The version is written in exactly one place, ``src/crysviz/__init__.py``
(``__version__``). pyproject.toml reads it from there (setuptools dynamic
attr), CI and the release workflow ask this script for it, and the two
human-facing "Version X Beta YYYY-MM-DD" lines (README.md, the web app's
docs/ui/about.md) are rewritten by it. Notes for the next release collect
under "## Unreleased" in CHANGELOG.md; a bump turns that section into
"## X — YYYY-MM-DD" (keeping its text) and opens a fresh, empty Unreleased
above it. The version's section becomes the top of the GitHub Release, and the
release workflow refuses to publish while it is empty. The full release
procedure is documented above `bump` in the Makefile.

    tools/release/bump_version.py major      1.4.2 -> 2.0.0
    tools/release/bump_version.py minor      1.4.2 -> 1.5.0
    tools/release/bump_version.py fix        1.4.2 -> 1.4.3   (alias: patch)
    tools/release/bump_version.py 0.10.0     an explicit version (must be greater)
    tools/release/bump_version.py --print    print the current version
    tools/release/bump_version.py --check    fail if any place (or the CHANGELOG heading) disagrees
    tools/release/bump_version.py --notes    print the current version's CHANGELOG text
                                             (fails if there is none)

Stdlib only, so it runs on a bare CI runner before dependencies exist.
"""

from __future__ import annotations

import argparse
import datetime
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src" / "crysviz" / "__init__.py"
# Files carrying a "Version X[ Beta] YYYY-MM-DD" line for people to read.
DISPLAY_FILES = [ROOT / "README.md", ROOT / "docs" / "ui" / "about.md"]
CHANGELOG = ROOT / "CHANGELOG.md"

SOURCE_RE = re.compile(r'^__version__ = "([^"]+)"$', re.M)
DISPLAY_RE = re.compile(r"^Version (\S+)((?: [A-Za-z]+)?) (\d{4}-\d{2}-\d{2})$", re.M)
# "## 0.10.0 — 2026-09-15" (em dash or hyphen); the body runs to the next "## ".
CHANGELOG_HEADING_RE = re.compile(r"^## (\S+) [—-] (\d{4}-\d{2}-\d{2})[ \t]*$", re.M)
UNRELEASED_HEADING_RE = re.compile(r"^## Unreleased[ \t]*$", re.M)
# Plain release numbers with an optional PEP 440 pre-release: 0.10.0, 1.2.3rc1.
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$")


def parse(version: str) -> tuple:
    match = VERSION_RE.match(version)
    if match is None:
        raise SystemExit(f"not a release version (X.Y.Z or X.Y.ZrcN): {version!r}")
    major, minor, patch, pre, pre_n = match.groups()
    # A final release sorts after its own pre-releases.
    pre_key = (1, "", 0) if pre is None else (0, pre, int(pre_n))
    return (int(major), int(minor), int(patch), pre_key)


PARTS = ("major", "minor", "fix", "patch")


def next_version(old: str, part: str) -> str:
    """Semver bump of `old`; a pre-release suffix is dropped."""
    major, minor, patch, _ = parse(old)
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def current_version() -> str:
    match = SOURCE_RE.search(SOURCE.read_text(encoding="utf-8"))
    if match is None:
        raise SystemExit(f"no __version__ line in {SOURCE.relative_to(ROOT)}")
    return match.group(1)


def display_versions() -> dict[pathlib.Path, str | None]:
    found = {}
    for path in DISPLAY_FILES:
        match = DISPLAY_RE.search(path.read_text(encoding="utf-8"))
        found[path] = match.group(1) if match else None
    return found


def changelog_section(version: str) -> tuple[re.Match, str] | None:
    """The heading match for `version` and the section body (up to the next
    "## " heading), or None when CHANGELOG.md has no section for it."""
    text = CHANGELOG.read_text(encoding="utf-8")
    for match in CHANGELOG_HEADING_RE.finditer(text):
        if match.group(1) != version:
            continue
        following = re.compile(r"^## ", re.M).search(text, match.end())
        return match, text[match.end(): following.start() if following else len(text)]
    return None


def release_notes(version: str) -> str:
    """The section body without HTML comments (the placeholder), trimmed."""
    section = changelog_section(version)
    if section is None:
        return ""
    return re.sub(r"<!--.*?-->", "", section[1], flags=re.S).strip()


def check() -> int:
    version = current_version()
    problems = []
    for path, found in display_versions().items():
        if found != version:
            shown = "no 'Version X YYYY-MM-DD' line" if found is None else found
            problems.append(f"{path.relative_to(ROOT)}: {shown}, expected {version}")
    # Only the heading is required here, so a bump PR can be opened before the
    # notes are written; publishing requires the text (--notes).
    if changelog_section(version) is None:
        problems.append(f"{CHANGELOG.relative_to(ROOT)}: no '## {version} — YYYY-MM-DD' section")
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


def bump(version: str, date: str, allow_same: bool) -> None:
    old = current_version()
    if parse(version) < parse(old) or (parse(version) == parse(old) and not allow_same):
        raise SystemExit(f"new version {version} must be greater than current {old}")

    text = SOURCE.read_text(encoding="utf-8")
    SOURCE.write_text(SOURCE_RE.sub(f'__version__ = "{version}"', text, count=1), encoding="utf-8")
    for path in DISPLAY_FILES:
        text = path.read_text(encoding="utf-8")
        new, n = DISPLAY_RE.subn(lambda m: f"Version {version}{m.group(2)} {date}", text, count=1)
        if n != 1:
            raise SystemExit(f"no 'Version X YYYY-MM-DD' line in {path.relative_to(ROOT)}")
        path.write_text(new, encoding="utf-8")
    stamp_changelog(version, date)
    print(f"{old} -> {version} ({date})")


def stamp_changelog(version: str, date: str) -> None:
    """Turn "## Unreleased" into the section for `version` (its notes move
    with it; none yet leaves an empty section the release refuses) under a
    fresh, empty Unreleased. Re-stamping a version that already has a section only
    re-dates it and leaves Unreleased alone."""
    text = CHANGELOG.read_text(encoding="utf-8")
    heading = f"## {version} — {date}"
    section = changelog_section(version)
    if section is not None:
        match = section[0]
        CHANGELOG.write_text(text[: match.start()] + heading + text[match.end():], encoding="utf-8")
        return

    unreleased_block = "## Unreleased\n\n"
    unreleased = UNRELEASED_HEADING_RE.search(text)
    if unreleased is not None:
        following = re.compile(r"^## ", re.M).search(text, unreleased.end())
        end = following.start() if following else len(text)
        notes = re.sub(r"<!--.*?-->", "", text[unreleased.end(): end], flags=re.S).strip()
        start = unreleased.start()
    else:
        # No Unreleased section yet: open the version above the newest one.
        notes = ""
        newest = CHANGELOG_HEADING_RE.search(text)
        if newest is None:
            text = text.rstrip("\n") + "\n\n"
            start = end = len(text)
        else:
            start = end = newest.start()
    block = f"{unreleased_block}{heading}\n\n" + (f"{notes}\n\n" if notes else "")
    CHANGELOG.write_text(text[:start] + block + text[end:], encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("version", nargs="?", help="major | minor | fix (patch), or an explicit version such as 0.10.0")
    group.add_argument("--print", action="store_true", help="print the current version")
    group.add_argument("--check", action="store_true", help="verify every place agrees")
    group.add_argument("--notes", action="store_true", help="print the current version's CHANGELOG text; fail if empty")
    parser.add_argument("--date", default=datetime.date.today().isoformat(), help="release date (default: today)")
    parser.add_argument("--allow-same", action="store_true", help="re-stamp the current version (e.g. a new date)")
    args = parser.parse_args()

    if args.print:
        print(current_version())
        return 0
    if args.check:
        return check()
    if args.notes:
        version = current_version()
        notes = release_notes(version)
        if not notes:
            print(f"CHANGELOG.md has no release notes for {version}: write them under '## {version} — YYYY-MM-DD'", file=sys.stderr)
            return 1
        print(notes)
        return 0
    version = next_version(current_version(), args.version) if args.version in PARTS else args.version
    parse(version)
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", args.date):
        raise SystemExit(f"--date must be YYYY-MM-DD: {args.date!r}")
    bump(version, args.date, args.allow_same)
    return check()


if __name__ == "__main__":
    sys.exit(main())
