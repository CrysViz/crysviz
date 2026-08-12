// Shared GLSL chunk for the analytic capped cone-frustum primitive used by
// both tracer scene shaders. The object-space frustum spans y = [-1, 1], has
// radius 1 at its base, radius rTop at its top, and includes both disk caps.

export const coneChunk = /* glsl */`
// Capped cone frustum in object space: y in [-1,1], radius 1.0 at y=-1
// tapering linearly to rTop at y=+1, closed by disk end caps.
float UnitCappedConeFrustumIntersect( float rTop, vec3 ro, vec3 rd, out vec3 n )
{
	float k = (rTop - 1.0) * 0.5;              // d(radius)/dy
	float t = INFINITY;
	// lateral surface: x*x + z*z = f(y)*f(y), f(y) = 1.0 + k * (y + 1.0)
	float f0 = 1.0 + k * (ro.y + 1.0);
	float a = dot(rd.xz, rd.xz) - (k * rd.y) * (k * rd.y);
	float b = 2.0 * (dot(ro.xz, rd.xz) - f0 * k * rd.y);
	float c = dot(ro.xz, ro.xz) - f0 * f0;
	float rr = dot(rd, rd);
	float t0 = INFINITY, t1 = INFINITY;
	if (abs(a) < 1e-7 * rr)
	{
		if (b * b > 1e-14 * rr) t0 = -c / b;
	}
	else
	{
		solveQuadratic(a, b, c, t0, t1);
	}
	vec3 hit = ro + rd * t0;
	if (t0 > 0.0 && t0 < t && abs(hit.y) <= 1.0)
		{ t = t0; n = vec3(hit.x, -k * (1.0 + k * (hit.y + 1.0)), hit.z); }
	hit = ro + rd * t1;
	if (t1 > 0.0 && t1 < t && abs(hit.y) <= 1.0)
		{ t = t1; n = vec3(hit.x, -k * (1.0 + k * (hit.y + 1.0)), hit.z); }
	// base cap (y=-1, radius 1) and top cap (y=+1, radius rTop)
	float tc = (-1.0 - ro.y) / rd.y;
	hit = ro + rd * tc;
	if (tc > 0.0 && tc < t && dot(hit.xz, hit.xz) <= 1.0) { t = tc; n = vec3(0.0, -1.0, 0.0); }
	tc = (1.0 - ro.y) / rd.y;
	hit = ro + rd * tc;
	// Tie-break the apex: its lateral normal is exactly zero when rTop is zero.
	if (tc > 0.0 && tc <= t && dot(hit.xz, hit.xz) <= rTop * rTop) { t = tc; n = vec3(0.0, 1.0, 0.0); }
	n = dot(rd, n) < 0.0 ? n : -n;
	return t;
}
`;
