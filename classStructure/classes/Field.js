export class Field {
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
    useAbsoluteIsoValue = null // whether to use absolute values when determining isovalue
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
  }

}