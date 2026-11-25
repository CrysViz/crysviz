// Ray/path tracing pipeline registration, split out of pipeline/index.js so the
// heavy tracer modules (RayTracingCommon, PathTracingCommon and the two tracer
// pipelines) load ONLY where tracing is actually offered:
//   - the full app, which imports this at boot (so it stays offline-complete);
//   - a widget embed opted in with ?tracers=1.
// A default widget never imports this module and never downloads the tracers.
//
// Importing is a side effect: it registers the two pipelines with the manager.
// Idempotent — re-importing just re-sets the same registry entries.
import { registerPipeline } from './index.js';
import { RayTracingPipeline } from './RayTracingPipeline.js';
import { PathTracingPipeline } from './PathTracingPipeline.js';

registerPipeline(RayTracingPipeline);
registerPipeline(PathTracingPipeline);
