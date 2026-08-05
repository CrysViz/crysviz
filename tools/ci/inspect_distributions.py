#!/usr/bin/env python3
"""Validate that wheel and sdist contain runtime assets, not build debris."""

from pathlib import Path, PurePosixPath
import sys
import tarfile
import zipfile


def archive_names(artifact: Path) -> list[str]:
    if artifact.name.endswith(".whl"):
        with zipfile.ZipFile(artifact) as archive:
            return archive.namelist()
    with tarfile.open(artifact) as archive:
        return archive.getnames()


def main() -> None:
    distribution_dir = Path(sys.argv[1])
    artifacts = sorted(distribution_dir.glob("*.whl")) + sorted(
        distribution_dir.glob("*.tar.gz")
    )
    assert len(artifacts) == 2, artifacts

    for artifact in artifacts:
        names = archive_names(artifact)
        assert any(
            name.endswith(
                (
                    "crysviz/web/compiled/periodic_wasm_bg.wasm",
                    "docs/compiled/periodic_wasm_bg.wasm",
                )
            )
            for name in names
        ), artifact
        assert any(
            name.endswith(
                (
                    "crysviz/web/data/CrysViz_logo_clear_back.png",
                    "docs/data/CrysViz_logo_clear_back.png",
                )
            )
            for name in names
        ), artifact
        assert any("LICENSE" in name for name in names), artifact
        assert any("NOTICE" in name for name in names), artifact
        assert not any(
            {"target", "pkg", "report"} & set(PurePosixPath(name).parts)
            for name in names
        ), artifact
        assert not any(
            "tools/browsertest/env" in name
            or "tests" in PurePosixPath(name).parts
            for name in names
        ), artifact


if __name__ == "__main__":
    main()
