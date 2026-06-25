// Public API barrel for the `io/` domain (structure parsing + file loading).
//
// Other domains should import io functionality from here rather than reaching
// into individual reader modules. Intra-io modules import each other directly.
//
// Note: the readers and FileURLLoader transitively depend on ui/ and
// core/crystal-viewer.js (existing cycles). This barrel is currently consumed
// only by the entry point (crystal-viewer), so routing through it does not
// widen those cycles. readCHGCAR/readCubeFile are exported for completeness but
// their sole consumer (render/Render3DFieldModule) intentionally keeps a direct
// import to avoid pulling FileURLLoader into the render load graph.

// Parse pipeline (parse_any, isLikelyCIFContent, isLikelymagCIFContent,
// isLikelyOUTCARContent, parse_cif):
export * from "./load_structure.js";

// Format readers:
export { parseOUTCAR } from "./ReadOutcarModule.js";
export { parsePWSCFout } from "./ReadPWSCFoutModule.js";
export { parsePWSCFin } from "./ReadPWSCFinModule.js";
export { parseXYZFile } from "./ReadeXYZModule.js";
export { parseASETrajectory } from "./ReadASETrajectoryModule.js";
export { readCHGCAR } from "./ReadChgcarModule.js";
export { readCubeFile } from "./ReadCubeModule.js";

// File/URL loader:
export { loadFromFilePath } from "./FileURLLoader.js";
