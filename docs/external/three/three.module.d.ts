// Type stub for the vendored three.js build.
//
// The bundled three.module.js has no hand-written .d.ts, so tsc would otherwise
// infer types straight from the source — and those inferred types are imperfect
// (missing method overloads, missing Object3D properties, etc.), producing
// false-positive errors in *our* code that uses three. We deliberately type the
// whole module as `any`. Install @types/three if real three typing is wanted.
//
// `THREE` is declared as both a value (any) and a namespace of `any` types, so
// both `new THREE.Mesh()` (value) and `@param {THREE.Vector3}` (type) resolve.
declare const THREE: any;
declare namespace THREE {
  type Vector2 = any;
  type Vector3 = any;
  type Vector4 = any;
  type Euler = any;
  type Quaternion = any;
  type Matrix3 = any;
  type Matrix4 = any;
  type Color = any;
  type Plane = any;
  type Box3 = any;
  type Object3D = any;
  type Group = any;
  type Mesh = any;
  type InstancedMesh = any;
  type Line = any;
  type LineSegments = any;
  type Points = any;
  type BufferGeometry = any;
  type BufferAttribute = any;
  type Material = any;
  type Texture = any;
  type Scene = any;
  type Camera = any;
  type PerspectiveCamera = any;
  type OrthographicCamera = any;
  type WebGLRenderer = any;
  type Raycaster = any;
  type Light = any;
}
export = THREE;
