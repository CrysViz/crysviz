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
export { parseResFile } from "./ReadResModule.js";
export { parseCastepCell } from "./ReadCastepCellModule.js";
export { parseCastepGeom } from "./ReadCastepGeomModule.js";
export { parseAimsGeometry } from "./ReadAimsGeometryModule.js";
export { parseAimsOut } from "./ReadAimsOutModule.js";
export { parseASETrajectory } from "./ReadASETrajectoryModule.js";
export { readCHGCAR } from "./ReadChgcarModule.js";
export { readCubeFile } from "./ReadCubeModule.js";
export { readWAVECAR, isLikelyWAVECARContent } from "./ReadWavecarModule.js";

// Lazy byte access + the format registry. FileSource is what lets a reader ask
// for a byte range instead of being handed the whole file as a string; formats
// is the single table that decides which reader a file goes to, by sniffing
// the first HEAD_BYTES of content and falling back to the file name.
export { FileSource } from "./FileSource.js";
export {
  FORMATS, POSCAR_FORMAT, SourceKind, HandledBy, HEAD_BYTES,
  detectFormat, formatById, materialize, headOf, prepareHead, looksLike,
} from "./formats.js";

// File/URL loader:
export { loadFromFilePath } from "./FileURLLoader.js";
