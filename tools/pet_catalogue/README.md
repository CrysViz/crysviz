# PET model catalogues

A catalogue is a JSON file listing PET models (fine-tuned PET-MAD-XS or any
other PET model mlip.cpp can run) for CrysViz's in-browser PET-MAD
calculator. It and the models can be hosted anywhere. In CrysViz, pick
PET-MAD, choose **from a link…** in the model list, paste the catalogue's
link and press **Add**: its models appear as their own group in the list.
CrysViz remembers it, keeps a copy so the list also works offline, and
fetches it again each session, so new entries show up without anyone
re-adding it. The same box takes a link to a single `.gguf`.

To ship a catalogue with CrysViz itself, add its link to `DEFAULT_CATALOGUES`
in `docs/atomistic/petModels.js`.

## Making an entry

1. Fine-tune with metatrain (any method: `full`, `lora`, `heads`).
2. Export to GGUF with mlip.cpp's exporter, patched by
   `docs/external/mlip_wasm/crysviz-export-checkpoint.patch` (which takes a
   local checkpoint, merges LoRA, and writes the description into the file):

   ```bash
   python scripts/export_pytorch/export_pet_gguf.py --model model.ckpt -o cu-ni.gguf \
       --name "PET-MAD-XS · Cu–Ni alloys" --description "Fine-tuned on ... for ..." \
       --base-model "PET-MAD-XS v1.5.0" --training-elements "Cu,Ni" \
       --license BSD-3-Clause --author "..." --version 1.0
   ```

   A model loaded from a file or a single link shows that description, and
   CrysViz notes when a structure has elements outside `--training-elements`.
3. Make the catalogue entry (sha256, size, and the file's own description):

   ```bash
   python tools/pet_catalogue/make_entry.py cu-ni.gguf --url cu-ni.gguf \
       --method full --reference PBEsol --citation doi:... --catalogue catalogue.json \
       --catalogue-name "Our fine-tuned PET-MAD-XS models"
   ```

4. Upload `cu-ni.gguf` and `catalogue.json`.

## Format

```json
{
  "name": "Our fine-tuned PET-MAD-XS models",
  "description": "optional",
  "models": [
    {
      "id": "cu-ni",
      "name": "PET-MAD-XS · Cu–Ni alloys",
      "url": "cu-ni.gguf",
      "sha256": "ad8cc931…",
      "size": 17074464,
      "base": "PET-MAD-XS v1.5.0",
      "method": "full",
      "elements": ["Cu", "Ni"],
      "reference": "PBEsol",
      "description": "Fine-tuned on … for …",
      "authors": "…",
      "license": "BSD-3-Clause",
      "citation": "doi:10.…",
      "data": "doi:10.… (training set)"
    }
  ]
}
```

Only `name` and `url` are required. A bare array of entries is accepted too.

| field | |
|---|---|
| `name` | shown in the model list |
| `url` | absolute, or relative to the catalogue's own address. Page links on Hugging Face (`/blob/`), GitHub, GitLab and Dropbox are turned into file links. |
| `sha256` | recommended: the download is refused when it does not match, and a cached copy that no longer matches (the file at the link was replaced) is downloaded again |
| `size` | bytes, shown in the list |
| `elements` | the elements it was trained for. Fine-tuned XS models keep parameters for all elements of the base model, so others still run; CrysViz notes them as outside the training set. |
| `reference` | DFT level of the training energies. A full fine-tune refits the per-element energies, so total energies of models with different references are not comparable. |
| `base`, `method`, `description`, `authors`, `license`, `citation`, `data` | shown on the selected model's line |
| `id` | stable identifier; `make_entry.py` replaces entries by it |

Entries without a name or link, with a malformed `sha256`, or repeating
another entry's link are left out; CrysViz says which and why when the
catalogue is added.

## Hosting

The browser downloads the catalogue and the models from the CrysViz page, so
the server must allow cross-site downloads: it has to answer with
`Access-Control-Allow-Origin: *`. Checked: Hugging Face (`/resolve/` links)
and `raw.githubusercontent.com` do. For your own web server, add that header
for the `.json` and `.gguf` files, for example in nginx:

```nginx
location ~ \.(gguf|json)$ { add_header Access-Control-Allow-Origin *; }
```

When a server does not send it, CrysViz says so; the file can then still be
downloaded by hand and loaded with **local .gguf**.

Models are cached in the browser after the first download (17 MB for an XS
model).

`example-catalogue.json` here is a template.
