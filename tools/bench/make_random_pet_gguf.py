#!/usr/bin/env python3
"""Write a random-weight PET GGUF in the layout mlip.cpp's manual `pet`
architecture loads (its scripts/convert_pet_mad.py naming). Only for timing and
build-vs-build numerical comparison; the energies it produces mean nothing.

The real PET-MAD weights live on Hugging Face, which CI and agent sandboxes
often cannot reach. This gives the PET-MAD benchmarks
(tools/browsertest/tests/mlipbench.bench.js, mlipworker.test.js) a model of the
same layer sizes:

    pip install gguf numpy
    python3 tools/bench/make_random_pet_gguf.py -o docs/bench-models/pet-mad-s.gguf
    python3 tools/bench/make_random_pet_gguf.py -o docs/bench-models/pet-mad-xs.gguf \
        --d-pet 128 --d-head 64 --heads 4 --d-ff 256

Named like the real files, so the Debug window's Benchmark tab (models =
./bench-models/) and the headless bench find them. docs/bench-models/ is
gitignored; a real .gguf dropped there works too.
"""
import argparse, numpy as np, gguf
ap = argparse.ArgumentParser()
ap.add_argument('-o', required=True)
ap.add_argument('--d-pet', type=int, default=256)
ap.add_argument('--d-head', type=int, default=128)
ap.add_argument('--heads', type=int, default=8)
ap.add_argument('--d-ff', type=int, default=512)
ap.add_argument('--gnn', type=int, default=2)
ap.add_argument('--attn', type=int, default=2)
ap.add_argument('--cutoff', type=float, default=4.5)
ap.add_argument('--species', type=int, default=85)
ap.add_argument('--seed', type=int, default=0)
a = ap.parse_args()
rng = np.random.default_rng(a.seed)
w = gguf.GGUFWriter(a.o, arch='pet')
w.add_name('random-pet-bench'); w.add_description('random weights, benchmarking only')
w.add_string('pet.version', 'bench'); w.add_bool('pet.has_nc_forces', False); w.add_bool('pet.has_nc_stress', False)
w.add_float32('pet.cutoff', a.cutoff); w.add_float32('pet.cutoff_width', 0.5)
w.add_int32('pet.d_pet', a.d_pet); w.add_int32('pet.d_head', a.d_head); w.add_int32('pet.num_heads', a.heads)
w.add_int32('pet.num_gnn_layers', a.gnn); w.add_int32('pet.d_feedforward', a.d_ff); w.add_int32('pet.num_attention_layers', a.attn)
types = list(range(1, a.species + 1))
w.add_tensor('pet.atomic_types', np.array(types, dtype=np.int32)); w.add_int32('pet.n_atom_types', len(types))
w.add_tensor('composition.atomic_numbers', np.array(types, dtype=np.int32))
w.add_tensor('composition.energies', np.zeros(len(types), dtype=np.float32))
w.add_int32('pet.composition.num_species', len(types))
def lin(name, out, inn, scale=None):
    s = scale if scale is not None else 1.0 / np.sqrt(inn)
    w.add_tensor(name + '.weight', (rng.standard_normal((out, inn)) * s).astype(np.float32))
    w.add_tensor(name + '.bias', (rng.standard_normal(out) * 0.01).astype(np.float32))
def norm(name, d):
    w.add_tensor(name + '.weight', np.ones(d, dtype=np.float32)); w.add_tensor(name + '.bias', np.zeros(d, dtype=np.float32))
D, H, F = a.d_pet, a.d_head, a.d_ff
w.add_tensor('model.embedding.weight', (rng.standard_normal((len(types), D)) * 0.3).astype(np.float32))
for i in range(a.gnn):
    p = f'model.gnn.{i}.'
    lin(p + 'edge_embedder', D, 4)
    w.add_tensor(p + 'node_embedder.weight', (rng.standard_normal((len(types), D)) * 0.3).astype(np.float32))
    if i > 0:
        w.add_tensor(p + 'neighbor_embedder.weight', (rng.standard_normal((len(types) + 1, D)) * 0.3).astype(np.float32))
    lin(p + 'compress.0', D, 3 * D); lin(p + 'compress.2', D, D)
    for j in range(a.attn):
        t = p + f'tl.{j}.'
        lin(t + 'attn.in', 3 * D, D); lin(t + 'attn.out', D, D)
        norm(t + 'norm_a', D); norm(t + 'norm_m', D)
        lin(t + 'mlp.0', F, D); lin(t + 'mlp.3', D, F)
    for kind in ('node', 'edge'):
        lin(f'model.{kind}_heads.energy.{i}.0', H, D); lin(f'model.{kind}_heads.energy.{i}.2', H, H)
        lin(f'model.{kind}_last_layers.energy.{i}.energy___0', 1, H, scale=0.05)
w.write_header_to_file(); w.write_kv_data_to_file(); w.write_tensors_to_file(); w.close()
import os; print(a.o, os.path.getsize(a.o) / 1e6, 'MB')
