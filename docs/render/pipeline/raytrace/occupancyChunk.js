// Optional shared GLSL chunk for viewer-facing disordered-site pies. It is
// interpolated into both tracer scene shaders only when SceneEncoder found at
// least one WedgeAtoms composition entry; the empty scene path is byte-for-byte
// the pre-feature shader source.

export const occupancyChunk = /* glsl */`
uniform sampler2D uOccupancyDataTexture; // two texels per encoded atom
uniform vec3 uPieAxis;  // primary camera view axis
uniform vec3 uPieRight; // primary camera view-space +x
uniform vec3 uPieUp;    // primary camera view-space +y

vec3 pieUnpackColor(float packed)
{
	float v = abs(packed);
	float r = floor(v / 65536.0);
	float g = floor(mod(v, 65536.0) / 256.0);
	float b = mod(v, 256.0);
	vec3 srgb = vec3(r, g, b) / 255.0;
	return mix(
		pow((srgb + 0.055) / 1.055, vec3(2.4)),
		srgb / 12.92,
		step(srgb, vec3(0.04045))
	);
}

vec3 pieAtomColor(int atomIndex, vec3 center, vec3 hitPoint, vec4 mat, vec3 fallback)
{
	// Material type codes remain integer values; +0.25 is the occupancy flag.
	if (abs(fract(mat.x) - 0.25) > 0.1) return fallback;
	vec4 fractions = fetchData(uOccupancyDataTexture, atomIndex * 2);
	vec4 packed = fetchData(uOccupancyDataTexture, atomIndex * 2 + 1);
	vec3 offset = hitPoint - center;
	vec3 tangent = offset - uPieAxis * dot(offset, uPieAxis);
	float radial = length(tangent);
	float angle = radial < 1e-6 ? 0.0
		: (atan(dot(tangent, uPieUp), dot(tangent, uPieRight)) + 3.14159265) / 6.28318531;
	float selected = packed.x;
	if (angle >= fractions.x) selected = packed.y;
	if (angle >= fractions.y) selected = packed.z;
	if (angle >= fractions.z) selected = packed.w;
	vec3 color = pieUnpackColor(selected);
	if (selected < 0.0)
	{
		float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.14));
		color = mix(color, color * 2.2 + 0.16, hatch);
	}
	return color;
}
`;
