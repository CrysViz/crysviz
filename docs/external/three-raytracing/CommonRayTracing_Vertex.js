// @ts-nocheck -- vendored third-party; not type-checked
// LOCAL ADAPTATION (CrysViz): upstream ships this as a .glsl file loaded by
// the demo scaffolding; wrapped as an exported string (no bundler/fetch).
// Local adaptations are CrysViz work under AGPL-3.0 (repo LICENSE);
// the upstream original is CC0 (this directory's LICENSE).
export const CommonRayTracing_Vertex = /* glsl */`
precision highp float;
precision highp int;

void main()
{
	gl_Position = vec4( position, 1.0 );
}
`;
