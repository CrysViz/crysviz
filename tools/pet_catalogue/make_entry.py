#!/usr/bin/env python3
"""Make a CrysViz PET model catalogue entry from a .gguf file.

Reads what the file says about itself (the exporter's --name, --description,
--license, --author, --base-model, --training-elements; see README.md),
adds its sha256 and size and the link it will be downloaded from, and
prints the entry as JSON, or adds it to a catalogue file (replacing an entry
with the same id or link).

    python tools/pet_catalogue/make_entry.py cu-ni.gguf \
        --url https://example.org/pet/cu-ni.gguf --reference PBEsol --method full
    python tools/pet_catalogue/make_entry.py cu-ni.gguf --url ... --catalogue catalogue.json

Only the standard library is needed.
"""
import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

ELEMENTS = (
    "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn "
    "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce "
    "Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn "
    "Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl "
    "Mc Lv Ts Og"
).split()

# GGUF value types -> struct format of a scalar
SCALARS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?",
           10: "<Q", 11: "<q", 12: "<d"}
STRING, ARRAY = 8, 9


def read_gguf_metadata(path: Path) -> dict:
    """The key/value metadata of a GGUF file; "graph.*" strings are skipped."""
    with open(path, "rb") as f:
        def read(fmt):
            size = struct.calcsize(fmt)
            data = f.read(size)
            if len(data) != size:
                raise ValueError("truncated GGUF header")
            return struct.unpack(fmt, data)[0]

        def string(keep=True):
            n = read("<Q")
            if not keep:
                f.seek(n, 1)
                return None
            return f.read(n).decode("utf-8")

        def value(vtype, keep):
            if vtype == STRING:
                return string(keep)
            if vtype == ARRAY:
                item_type, n = read("<I"), read("<Q")
                return [value(item_type, keep) for _ in range(n)]
            return read(SCALARS[vtype])

        if f.read(4) != b"GGUF":
            raise ValueError(f"{path} is not a GGUF file")
        version = read("<I")
        if version < 2:
            raise ValueError(f"GGUF version {version} is too old")
        read("<Q")  # tensors
        kv = {}
        for _ in range(read("<Q")):
            key = string()
            keep = not key.startswith("graph.")
            v = value(read("<I"), keep)
            if keep:
                kv[key] = v
    return kv


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def parse_elements(text):
    out = [s for s in text.replace(",", " ").split()]
    bad = [s for s in out if s not in ELEMENTS]
    if bad:
        raise SystemExit(f"--elements: unknown element(s) {', '.join(bad)}")
    return out


def make_entry(path: Path, args) -> dict:
    kv = read_gguf_metadata(path)
    arch = kv.get("general.architecture")
    if arch not in ("pet-graph", "pet"):
        raise SystemExit(f"{path} is a GGUF file but not a PET model for mlip.cpp (architecture {arch!r})")
    trained = [ELEMENTS[z - 1] for z in kv.get("pet.training_species", []) if 0 < z <= len(ELEMENTS)]
    entry = {
        "id": args.id or path.stem,
        "name": args.name or kv.get("general.name") or path.stem,
        "url": args.url,
        "sha256": sha256_of(path),
        "size": path.stat().st_size,
        "base": args.base or kv.get("general.base_model.0.name"),
        "method": args.method,
        "elements": parse_elements(args.elements) if args.elements else (trained or None),
        "reference": args.reference,
        "description": args.description or kv.get("general.description"),
        "authors": args.authors or kv.get("general.author"),
        "license": args.license or kv.get("general.license"),
        "citation": args.citation,
        "data": args.data,
    }
    return {k: v for k, v in entry.items() if v not in (None, "", [])}


def add_to_catalogue(path: Path, entry: dict, name: str | None):
    if path.exists():
        catalogue = json.loads(path.read_text())
    else:
        catalogue = {"name": name or path.stem, "models": []}
    models = [m for m in catalogue.get("models", [])
              if m.get("id") != entry["id"] and m.get("url") != entry["url"]]
    replaced = len(models) != len(catalogue.get("models", []))
    catalogue["models"] = models + [entry]
    path.write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n")
    print(f"{'replaced' if replaced else 'added'} {entry['id']} in {path} ({len(models) + 1} models)")


def main():
    p = argparse.ArgumentParser(description="Make a CrysViz PET catalogue entry from a .gguf")
    p.add_argument("gguf", type=Path)
    p.add_argument("--url", required=True,
                   help="where the file will be downloaded from (absolute, or relative to the catalogue)")
    p.add_argument("--id", help="stable identifier (default: the file name)")
    p.add_argument("--name", help="shown in the model list (default: the file's general.name)")
    p.add_argument("--base", help="base model, e.g. 'PET-MAD-XS v1.5.0' (default: from the file)")
    p.add_argument("--method", help="fine-tuning method: full, lora or heads")
    p.add_argument("--elements", help="elements it was trained for, e.g. 'Cu,Ni' (default: from the file)")
    p.add_argument("--reference", help="DFT level of the training energies, e.g. PBEsol")
    p.add_argument("--description")
    p.add_argument("--authors")
    p.add_argument("--license")
    p.add_argument("--citation", help="DOI or link to cite")
    p.add_argument("--data", help="training data: DOI, link or a few words")
    p.add_argument("--catalogue", type=Path, help="add the entry to this catalogue file instead of printing it")
    p.add_argument("--catalogue-name", help="name of a new catalogue file")
    args = p.parse_args()

    entry = make_entry(args.gguf, args)
    if args.catalogue:
        add_to_catalogue(args.catalogue, entry, args.catalogue_name)
    else:
        json.dump(entry, sys.stdout, indent=2, ensure_ascii=False)
        print()


if __name__ == "__main__":
    main()
