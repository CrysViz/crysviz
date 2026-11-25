/** How far past a block's face (in grid fractions) a sample still counts as on it. */
const BLOCK_FACE_EPS = 1e-9;

export class Field {
  /**
   * @param {{nx?:number, ny?:number, nz?:number, origin?:number[], voxel?:any,
   *   values?:any, component?:number, isoValue?:number, absMinValue?:any,
   *   absMaxValue?:any, minValue?:any, maxValue?:any, label?:string,
   *   useAbsoluteIsoValue?:any, isVisible?:boolean, valueUnit?:string|null,
   *   periodic?:boolean, maskValue?:number|null,
   *   colorBy?:{field: Field, colormap: string, min: number, max: number}|null}} [opts]
   */
  constructor({
    nx, // number of grid points along x
    ny, // number of grid points along y
    nz, // number of grid points along z
    origin = [0, 0, 0], // origin of the grid in Cartesian coordinates
    voxel = null, // voxel vectors defining the grid spacing and orientation (3×3 matrix)
    values = null, // Float32Array of field values (length should be nx*ny*nz)
    component = 0, // 0 for charge density, 1+ for spin components
    isoValue = 0, // stored isovalue for rendering (can be set by user)
    absMinValue = null, // minimum field value (can be computed from values)
    absMaxValue = null, // maximum field value (can be computed from values)
    minValue = null, // minimum field value (can be computed from values)
    maxValue = null, // maximum field value (can be computed from values)
    label = "", // optional label for the field (e.g., "Charge Density", "Magnetization Density", etc.)
    useAbsoluteIsoValue = null, // whether to use absolute values when determining isovalue
    isVisible = true, // whether this field should be rendered (can be toggled by user)
    valueUnit = null, // unit of the values, e.g. 'e/bohr³' or 'e/Å³'; null = unknown / not a density
    periodic = true, // false: a finite block of data (a molecular cube) that fills part of the cell
    maskValue = null, // grid points at or above this value are "no data" for the isosurface
    colorBy = null // colour this field's isosurface per vertex by another field (see below)
  } = {}) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.origin = origin;
    this.voxel = voxel;
    this.values = values; // Float32Array of field values
    this.component = component;
    this.isoValue = isoValue;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.absMinValue = absMinValue;
    this.absMaxValue = absMaxValue;
    this.label = label;
    this.useAbsoluteIsoValue = useAbsoluteIsoValue;
    this.isVisible = isVisible;

    // Unit of `values`, as a plain-text string: 'e/bohr³' for a density in
    // atomic units (Gaussian cube), 'e/Å³' for a VASP CHGCAR density after the
    // division by the cell volume. Null when unknown or when the field is not a
    // density (potentials, orbitals, ELF). Consumers that need a density in a
    // particular unit (NCI) convert from this.
    /** @type {string | null} */
    this.valueUnit = valueUnit ?? null;

    // A periodic field (CHGCAR, WAVECAR, a periodic-code cube) repeats with
    // the cell and is drawn with the n-point spacing convention: point n along
    // an axis is point 0 again, so neighbours wrap across the boundary. A block
    // (`periodic === false`, e.g. a Gaussian cube around a molecule) is a
    // finite slab of data whose grid point i sits exactly at origin + i * voxel_i;
    // it fills only part of the structure cell, holds no values outside its own
    // grid (`getValueAtPoint` → null), and its boundary layer has no neighbours
    // beyond it. The grid-to-world mapping for both lives in
    // model/fieldGeometry.js. Anything but a literal `false` is periodic, so an
    // untrusted (share) payload can only ever produce a block by saying so exactly.
    /** @type {boolean} */
    this.periodic = periodic !== false;

    // Values at or above this mark grid points that carry no data: the
    // isosurface skips every cube touching one instead of closing the surface
    // against them. The NCI s field (model/NciField.js) marks the points
    // outside its density window this way, as Jmol does with NaN. Null = none.
    /** @type {number | null} */
    this.maskValue = Number.isFinite(maskValue) ? maskValue : null;

    // Per-vertex colouring of this field's isosurface by another field on the
    // same grid: the other field is sampled at each vertex and mapped through
    // `colormap` over [min, max]. Null draws the surface in its flat colour.
    /** @type {{field: Field, colormap: string, min: number, max: number} | null} */
    this.colorBy = colorBy ?? null;

    // Set by model/WavefunctionSource.js when this field is one band of a
    // WAVECAR, so the UI can trace a field back to its (spin, k-point, band)
    // and to the proxy that produced it. Null for every other field source.
    /** @type {{source: any, spin: number, kpt: number, band: number, quantity: number,
     *           spinor?: number} | null} */
    this.wavefunction = null;

    // Set by model/CompositeField.js on a derived field: the terms it was built
    // from, so it can be rebuilt when one of them is reloaded.
    /** @type {Array<{field: Field, weight: number}> | null} */
    this.derivedFrom = null;

    // How those terms were combined — 'sum' for a weighted combination,
    // 'magnitude' for sqrt(sum of squares). Read by `recomputeComposite`, which
    // cannot tell the two apart from the term list alone.
    /** @type {string | null} */
    this.derivedOp = null;
  }

  getValueAt(i, j, k) {
    if (!this.values) return null;
    const index = i + this.nx * (j + this.ny * k);
    return this.values[index];
  }

  getValueAtPoint(x_frac, y_frac, z_frac) {
    if (!this.values) return null;

    // A block holds nothing outside its own grid. The tolerance keeps a point
    // that a world -> grid inversion lands on a face by float noise inside.
    // The periodic path below is deliberately untouched (out-of-range input
    // behaves exactly as it always has).
    if (!this.periodic && [x_frac, y_frac, z_frac].some((f) => !(f >= -BLOCK_FACE_EPS && f <= 1 + BLOCK_FACE_EPS))) {
      return null;
    }

    // Get the voxel indices containing the point
    let x = x_frac * (this.nx - 1);
    let y = y_frac * (this.ny - 1);
    let z = z_frac * (this.nz - 1);

    // Block only: a point admitted by the face tolerance just below 0 would floor
    // to index -1; clamping the grid coordinate keeps the base index in range and
    // returns the face value.
    if (!this.periodic) {
      x = Math.min(Math.max(x, 0), this.nx - 1);
      y = Math.min(Math.max(y, 0), this.ny - 1);
      z = Math.min(Math.max(z, 0), this.nz - 1);
    }

    // Get the base indices (floor)
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const k0 = Math.floor(z);

    // Get the next indices (ceil), clamped to grid bounds
    const i1 = Math.min(i0 + 1, this.nx - 1);
    const j1 = Math.min(j0 + 1, this.ny - 1);
    const k1 = Math.min(k0 + 1, this.nz - 1);

    // Get fractional parts for interpolation
    const fx = x - i0;
    const fy = y - j0;
    const fz = z - k0;

    // Get the 8 corner values
    const v000 = this.getValueAt(i0, j0, k0);
    const v100 = this.getValueAt(i1, j0, k0);
    const v010 = this.getValueAt(i0, j1, k0);
    const v110 = this.getValueAt(i1, j1, k0);
    const v001 = this.getValueAt(i0, j0, k1);
    const v101 = this.getValueAt(i1, j0, k1);
    const v011 = this.getValueAt(i0, j1, k1);
    const v111 = this.getValueAt(i1, j1, k1);

    // Perform trilinear interpolation
    const v00 = v000 * (1 - fx) + v100 * fx;
    const v10 = v010 * (1 - fx) + v110 * fx;
    const v01 = v001 * (1 - fx) + v101 * fx;
    const v11 = v011 * (1 - fx) + v111 * fx;

    const v0 = v00 * (1 - fy) + v10 * fy;
    const v1 = v01 * (1 - fy) + v11 * fy;

    return v0 * (1 - fz) + v1 * fz;
  }
}