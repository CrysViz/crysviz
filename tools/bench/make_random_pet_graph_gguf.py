#!/usr/bin/env python3
"""Write a random-weight PET model in the `pet-graph` GGUF format, the one the
published PET-MAD files use (mlip.cpp's GraphModel), at the published sizes.
Only for timing and build-vs-build numerical comparison; the energies it
produces mean nothing.

make_random_pet_gguf.py writes mlip.cpp's other, hand-written `pet` layout,
which runs different code (PETModel). The published pet-mad-xs.gguf /
pet-mad-s.gguf are graph exports: this builds a random metatrain PET and
exports it with mlip.cpp's own scripts/export_pytorch/export_pet_gguf.py, so
the graph, ops and weight layout are what the real files carry. Zero-initialised
weights (output heads) get small random values, so forces and stress depend on
every layer.

    python3 -m venv venv && venv/bin/pip install metatrain
    git clone https://github.com/peterspackman/mlip.cpp
    venv/bin/python tools/bench/make_random_pet_graph_gguf.py --mlip-cpp mlip.cpp \\
        --size xs -o docs/bench-models/pet-mad-xs.gguf
    venv/bin/python tools/bench/make_random_pet_graph_gguf.py --mlip-cpp mlip.cpp \\
        --size s -o docs/bench-models/pet-mad-s.gguf

Sizes are matched by parameter count, as the published checkpoints' layer
widths could not be read here: xs 4.4 M parameters (16.8 MB; published
16.3 MB), s 25.0 M (95.3 MB; published 95.4 MB). docs/bench-models/ is
gitignored; a real .gguf dropped there works too.
"""
import argparse
import math
import sys
import warnings

SIZES = {
    'xs': {'num_gnn_layers': 3},
    's': {'d_pet': 384, 'd_node': 768, 'd_head': 384, 'd_feedforward': 512},
}

ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
ap.add_argument('-o', '--output', required=True)
ap.add_argument('--mlip-cpp', required=True, help='mlip.cpp checkout (for scripts/export_pytorch)')
ap.add_argument('--size', choices=sorted(SIZES), default='xs')
ap.add_argument('--seed', type=int, default=0)
args = ap.parse_args()

import torch
sys.path.insert(0, f'{args.mlip_cpp}/scripts')
warnings.filterwarnings('ignore')
from metatrain.pet import PET
from metatrain.utils.architectures import get_default_hypers
from metatrain.utils.data import DatasetInfo
from metatrain.utils.data.target_info import get_energy_target_info

hypers = get_default_hypers('pet')['model']
hypers.update(SIZES[args.size])
types = [z for z in range(1, 87) if z != 85]  # 85 species, as PET-MAD
info = DatasetInfo(length_unit='Angstrom', atomic_types=types,
                   targets={'energy': get_energy_target_info('energy', {'quantity': 'energy', 'unit': 'eV'})})
torch.manual_seed(args.seed)
model = PET(hypers, info)
with torch.no_grad():
    for p in model.parameters():
        if p.numel() and float(p.abs().max()) == 0.0:
            p.normal_(0.0, 0.5 / math.sqrt(p.shape[-1] if p.dim() > 1 else 1))
print(f'{args.size}: {sum(p.numel() for p in model.parameters()):,} parameters', file=sys.stderr)
model.eval()

import export_pytorch.export_pet_full as epf
import export_pytorch.export_pet_gguf as epg
raw = epf._unwrap_to_pet(model)
epf.load_pet_model = epg.load_pet_model = lambda name: raw
sys.argv = ['export_pet_gguf.py', '-o', args.output, '--model', f'random-pet-{args.size}']
epg.main()
