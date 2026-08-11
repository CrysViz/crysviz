// @ts-nocheck -- vendored third-party; not type-checked
// LOCAL ADAPTATION (CrysViz): wrapped as an exported string (see README.md).
// Local adaptations are CrysViz work under AGPL-3.0 (repo LICENSE);
// the upstream original is CC0 (this directory's LICENSE).
export const ScreenCopy_Fragment = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uRayTracedImageTexture;

void main()
{	
	pc_fragColor = texelFetch(uRayTracedImageTexture, ivec2(gl_FragCoord.xy), 0);	
} 
`;
