// @ts-nocheck -- vendored third-party; not type-checked
// LOCAL ADAPTATION (CrysViz): wrapped as an exported string (see README.md).
export const ScreenCopy_Fragment = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D tPathTracedImageTexture;

void main()
{	
	pc_fragColor = texelFetch(tPathTracedImageTexture, ivec2(gl_FragCoord.xy), 0);	
} 
`;
