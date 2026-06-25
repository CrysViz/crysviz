export const DEFAULT_SINGULAR_TOLERANCE = 1e-12;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function dot3(u, v) {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vectorLength3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

export function acosDeg(value) {
  return (Math.acos(clamp(value, -1, 1)) * 180) / Math.PI;
}

export function transpose3x3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function invert3x3(m, tolerance = DEFAULT_SINGULAR_TOLERANCE) {
  const [a, b, c] = m;
  const [A, B, C] = a;
  const [D, E, F] = b;
  const [G, H, I] = c;
  const det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (Math.abs(det) < tolerance) throw new Error('Singular 3x3 matrix');
  const invDet = 1 / det;
  return [
    [(E * I - F * H) * invDet, (C * H - B * I) * invDet, (B * F - C * E) * invDet],
    [(F * G - D * I) * invDet, (A * I - C * G) * invDet, (C * D - A * F) * invDet],
    [(D * H - E * G) * invDet, (B * G - A * H) * invDet, (A * E - B * D) * invDet],
  ];
}

export function multiplyMatVec(mat, vec) {
  return [
    mat[0][0] * vec[0] + mat[0][1] * vec[1] + mat[0][2] * vec[2],
    mat[1][0] * vec[0] + mat[1][1] * vec[1] + mat[1][2] * vec[2],
    mat[2][0] * vec[0] + mat[2][1] * vec[1] + mat[2][2] * vec[2],
  ];
}

export const matVec = multiplyMatVec;

export function fracToCartPoint(frac, lattice) {
  return [
    frac[0] * lattice[0][0] + frac[1] * lattice[1][0] + frac[2] * lattice[2][0],
    frac[0] * lattice[0][1] + frac[1] * lattice[1][1] + frac[2] * lattice[2][1],
    frac[0] * lattice[0][2] + frac[1] * lattice[1][2] + frac[2] * lattice[2][2],
  ];
}

export function fracToCart(frac, lattice) {
  return frac.map((point) => fracToCartPoint(point, lattice));
}

export function cartToFractional(cartVec, lattice, precomputedInverse) {
  const inverse = precomputedInverse || invert3x3(transpose3x3(lattice));
  return multiplyMatVec(inverse, cartVec);
}

export const cartToFrac = cartToFractional;

export function normalizeFractional(value) {
  if (!Number.isFinite(value)) return 0;
  let normalized = value - Math.floor(value);
  if (normalized < 0) normalized += 1;
  if (Math.abs(normalized) < 1e-8) normalized = 0;
  if (Math.abs(normalized - 1) < 1e-8) normalized = 0;
  return normalized;
}

export function normalizeFractionalPoint(point) {
  return [
    normalizeFractional(point[0]),
    normalizeFractional(point[1]),
    normalizeFractional(point[2]),
  ];
}

export function normalizeFractionalPositions(points) {
  return points.map((point) => normalizeFractionalPoint(point));
}

export function latticeFromCell(a, b, c, alpha, beta, gamma) {
  const rad = Math.PI / 180;
  const ca = Math.cos(alpha * rad);
  const cb = Math.cos(beta * rad);
  const cg = Math.cos(gamma * rad);
  const sinGamma = Math.sin(gamma * rad);
  const sg = Math.abs(sinGamma) > 1e-12 ? sinGamma : (sinGamma >= 0 ? 1e-12 : -1e-12);

  const ax = a;
  const ay = 0;
  const az = 0;
  const bx = b * cg;
  const by = b * sinGamma;
  const bz = 0;
  const cx = c * cb;
  const cy = c * ((ca - cb * cg) / sg);
  const czTerm = 1 - (cb * cb) - (((ca - cb * cg) / sg) ** 2);
  const cz = c * Math.sqrt(Math.max(0, czTerm));
  return [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
}

export function latticeVolume(matrix) {
  return Math.abs(dot3(matrix[0], cross3(matrix[1], matrix[2])));
}

export function latticeParameters(matrix) {
  const [a1, a2, a3] = matrix;
  const a = vectorLength3(a1);
  const b = vectorLength3(a2);
  const c = vectorLength3(a3);
  const alpha = acosDeg(dot3(a2, a3) / (b * c || 1));
  const beta = acosDeg(dot3(a1, a3) / (a * c || 1));
  const gamma = acosDeg(dot3(a1, a2) / (a * b || 1));
  const volume = latticeVolume(matrix);
  return { a, b, c, alpha, beta, gamma, volume };
}
