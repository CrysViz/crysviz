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

// Volumetric-field composition and the tree view over a file's fields:
export {
  combineFields, magnitudeField, recomputeComposite, computeFieldStats, describeCombination,
  defaultIsoValue,
} from './CompositeField.js';
export { FieldCatalog, FieldCatalogNode, NodeKind } from './FieldCatalog.js';
export { TrajectoryFrameStore } from './TrajectoryFrameStore.js';
export { TrajectoryContainer } from './TrajectoryContainer.js';
export { materializeFrame } from './materializeFrame.js';

// Lazily-read plane-wave wavefunctions (WAVECAR) and the byte-budgeted cache
// that keeps them inside the browser's memory limits:
export { WavefunctionSource, GammaMode, WaveQuantity, RTAG_SINGLE, RTAG_DOUBLE } from './WavefunctionSource.js';
export { LruByteCache, DEFAULT_CACHE_BUDGET_BYTES, byteSizeOf } from './LruByteCache.js';
export { ColoredObject } from './ColoredObject.js';

// Instanced-mesh helper (default export re-exported as a name):
export { default as InstanceMeshManager } from './InstanceMeshManager.js';

// Isosurface class + render-material settings helpers:
export {
  Isosurface, getIsosurfaceMaterialSettings, setIsosurfaceMaterialSettings,
  getIsosurfaceTriangleSortingEnabled, setIsosurfaceTriangleSortingEnabled,
  applyMaterialSettingsToStoredIsosurfaces, updateStoredIsosurfaceRenderOrder,
} from './Isosurface.js';
