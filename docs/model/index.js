// Public barrel for the data-model classes.
// Add new model classes here; keep internal helpers unexported.
export { Atom } from './Atom.js';
export { Bond } from './Bond.js';
export { Structure } from './Structure.js';
export { StructureContainer } from './StructureContainer.js';
export { StructureShip } from './StructureShip.js';
export { Spin } from './Spin.js';
export { Force } from './Force.js';
export { Stress } from './Stress.js';
export { Polyhedra } from './Polyhedra.js';
export { Polyhedron } from './Polyhedron.js';
export { Symmetry } from './Symmetry.js';
export { Wyckoff } from './Wyckoff.js';
export { Field } from './Field.js';
export { Plane, getCutPlaneMaskSign } from './Plane.js';
export { FieldContainer } from './FieldContainer.js';
export { ColoredObject } from './ColoredObject.js';

// Instanced-mesh helper (default export re-exported as a name):
export { default as InstanceMeshManager } from './InstanceMeshManager.js';

// Isosurface class + render-material settings helpers:
export {
  Isosurface, getIsosurfaceMaterialSettings, setIsosurfaceMaterialSettings,
  getIsosurfaceTriangleSortingEnabled, setIsosurfaceTriangleSortingEnabled,
  applyMaterialSettingsToStoredIsosurfaces, updateStoredIsosurfaceRenderOrder,
} from './Isosurface.js';
