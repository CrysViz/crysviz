export class Field {
  /**
   * @param {{nx?:number, ny?:number, nz?:number, origin?:number[], voxel?:any,
   *   values?:any, component?:number, isoValue?:number, absMinValue?:any,
   *   absMaxValue?:any, minValue?:any, maxValue?:any, label?:string,
   *   useAbsoluteIsoValue?:any, isVisible?:boolean}} [opts]
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
    label = "", // optional label for the field (e.g., "Charge Density", "Spin Density X", etc.)
    useAbsoluteIsoValue = null, // whether to use absolute values when determining isovalue
    isVisible = true // whether this field should be rendered (can be toggled by user)
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
  }

  getValueAt(i, j, k) {
    if (!this.values) return null;
    const index = i + this.nx * (j + this.ny * k);
    return this.values[index];
  }

  getValueAtPoint(x_frac, y_frac, z_frac) {
    if (!this.values) return null;

    // Get the voxel indices containing the point
    const x = x_frac * (this.nx - 1);
    const y = y_frac * (this.ny - 1);
    const z = z_frac * (this.nz - 1);

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