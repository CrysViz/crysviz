#!/usr/bin/env python3
"""Write a synthetic extended-XYZ trajectory for benchmarking the player.

A diamond-lattice crystal (Si by default) whose atoms oscillate on a few
superimposed sine waves: a travelling wave across the cell plus a small
per-atom phase, so bonds stretch and compress and every frame differs. The
atoms stay well inside their bonds (default amplitude 0.08 Å), so the bond
topology is stable and the playback fast path applies, as for a real MD run.
Optional per-atom forces (a spring pulling each atom back to its site) and
per-frame energies make the force colour map and the trajectory plot usable.

The crystal is an nx x ny x nz supercell of the 8-atom cubic cell, chosen as
close to a cube as possible with at least --atoms atoms (so the count is a
multiple of 8; it is printed).

Examples:
  python3 tools/make_trajectory.py --atoms 100000 --steps 50
  python3 tools/make_trajectory.py --atoms 20000 --steps 200 --forces -o bench.xyz
  python3 tools/make_trajectory.py --atoms 216000 --steps 20 --amplitude 0.15 --period 10

Size: about 35 bytes per atom per frame (55 with --forces) — 100k atoms x 50
frames is ~175 MB. Writing runs at a few million atom-frames per second.
"""
import argparse
import math
import random
import sys

DIAMOND = [(0, 0, 0), (0, .5, .5), (.5, 0, .5), (.5, .5, 0),
           (.25, .25, .25), (.25, .75, .75), (.75, .25, .75), (.75, .75, .25)]


def supercell_dims(atoms):
    """nx, ny, nz with 8*nx*ny*nz >= atoms: few extra atoms, close to a cube
    (13 cells gives 2x3x3, not 1x1x13)."""
    cells = max(1, math.ceil(atoms / 8))
    top = math.ceil(cells ** (1 / 3)) + 2
    best = None
    for nx in range(1, top + 1):
        for ny in range(nx, top + 1):
            nz = max(ny, math.ceil(cells / (nx * ny)))
            total = nx * ny * nz
            score = total * (1 + 0.5 * (nz / nx - 1))
            if best is None or score < best[0]:
                best = (score, (nx, ny, nz))
    return best[1]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog=__doc__.split('\n\n', 1)[1])
    p.add_argument('--atoms', type=int, required=True, help='minimum number of atoms')
    p.add_argument('--steps', type=int, required=True, help='number of frames')
    p.add_argument('-o', '--output', help='output .xyz (default: traj_<atoms>atoms_<steps>steps.xyz)')
    p.add_argument('--element', default='Si', help='element symbol (default Si)')
    p.add_argument('--lattice', type=float, default=5.43, help='cubic cell length in Å (default 5.43)')
    p.add_argument('--amplitude', type=float, default=0.08, help='oscillation amplitude in Å (default 0.08)')
    p.add_argument('--period', type=float, default=20, help='frames per oscillation (default 20)')
    p.add_argument('--wavelength', type=float, default=12, help='wavelength of the travelling wave in Å (default 12)')
    p.add_argument('--forces', action='store_true', help='add a forces column and per-frame energies')
    p.add_argument('--spring', type=float, default=5.0, help='spring constant for --forces in eV/Å² (default 5)')
    p.add_argument('--seed', type=int, default=1, help='seed for the per-atom phases (default 1)')
    args = p.parse_args(argv)
    if args.atoms < 1 or args.steps < 1:
        p.error('--atoms and --steps must be positive')

    nx, ny, nz = supercell_dims(args.atoms)
    a = args.lattice
    sites = [((f[0] + i) * a, (f[1] + j) * a, (f[2] + k) * a)
             for i in range(nx) for j in range(ny) for k in range(nz) for f in DIAMOND]
    n = len(sites)
    out = args.output or f'traj_{n}atoms_{args.steps}steps.xyz'

    rng = random.Random(args.seed)
    two_pi = 2 * math.pi
    kx, ky, kz = (two_pi / args.wavelength * w for w in (1.0, 0.7, 0.4))
    # Per-atom phase: the travelling wave plus a little noise, so neighbours
    # move slightly differently and bond lengths vary.
    phase = [kx * x + ky * y + kz * z + rng.uniform(-0.6, 0.6) for x, y, z in sites]
    omega = two_pi / args.period
    amp, spring, el = args.amplitude, args.spring, args.element

    cell = f'{nx * a:.6f} 0 0 0 {ny * a:.6f} 0 0 0 {nz * a:.6f}'
    props = 'species:S:1:pos:R:3' + (':forces:R:3' if args.forces else '')
    print(f'{n} atoms ({nx}x{ny}x{nz} cells of 8), {args.steps} frames -> {out}', file=sys.stderr)

    with open(out, 'w') as fh:
        for t in range(args.steps):
            wt = omega * t
            lines = [str(n)]
            body = []
            energy = 0.0
            for (x, y, z), ph in zip(sites, phase):
                s = wt + ph
                ux, uy, uz = amp * math.sin(s), amp * math.sin(s + 2.1), amp * math.sin(s + 4.2)
                if args.forces:
                    energy += 0.5 * spring * (ux * ux + uy * uy + uz * uz)
                    body.append(f'{el} {x + ux:.5f} {y + uy:.5f} {z + uz:.5f} '
                                f'{-spring * ux:.5f} {-spring * uy:.5f} {-spring * uz:.5f}')
                else:
                    body.append(f'{el} {x + ux:.5f} {y + uy:.5f} {z + uz:.5f}')
            comment = f'Lattice="{cell}" Properties={props} pbc="T T T"'
            if args.forces:
                comment += f' energy={energy:.6f}'
            lines.append(comment)
            fh.write('\n'.join(lines))
            fh.write('\n')
            fh.write('\n'.join(body))
            fh.write('\n')
            if args.steps >= 10 and (t + 1) % max(1, args.steps // 10) == 0:
                print(f'  frame {t + 1}/{args.steps}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
