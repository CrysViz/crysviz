// @ts-nocheck -- vendored third-party; not type-checked
// LOCAL ADAPTATIONS (CrysViz), see README.md:
// - wrapped as an exported string (upstream ships a .glsl file loaded by the
//   demo scaffolding; this app has no bundler/fetch step);
// - samples the ray-traced texture by normalized coordinates derived from
//   gl_FragCoord / uOutputResolution instead of a 1:1 texelFetch, so the
//   internal ray-tracing resolution can be a fraction of the canvas (the
//   "RT resolution" control); upsampling uses the texture's Linear filter.
// ReinhardToneMapping comes from three's ShaderMaterial tone-mapping prelude
// (present whenever the renderer tone-maps to the screen).
export const ScreenOutput_Fragment = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uRayTracedImageTexture;
uniform vec2 uOutputResolution;
uniform float uOneOverSampleCounter;
uniform bool uUseToneMapping;


void main()
{
	// grab the pixel color resulting from ray tracing
	vec2 uv = gl_FragCoord.xy / uOutputResolution;
	vec3 pixelColor = texture(uRayTracedImageTexture, uv).rgb;

	// take the average of all the samples from accumulation buffer
	pixelColor *= uOneOverSampleCounter;

	// apply tone mapping (brings pixel into 0.0-1.0 rgb color range)
	pixelColor = uUseToneMapping ? ReinhardToneMapping(pixelColor) : pixelColor;

	// lastly, apply gamma correction (gives more intensity/brightness range where it's needed)
	pc_fragColor = clamp(vec4( sqrt(pixelColor), 1.0 ), 0.0, 1.0);
}
`;
