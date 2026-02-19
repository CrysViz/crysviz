export function transpose3x3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function invert3x3(m) {
  const A = m[0][0]; const B = m[0][1]; const C = m[0][2];
  const D = m[1][0]; const E = m[1][1]; const F = m[1][2];
  const G = m[2][0]; const H = m[2][1]; const I = m[2][2];
  const det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (Math.abs(det) < 1e-14) throw new Error('Singular 3x3 matrix');
  const invDet = 1.0 / det;
  return [
    [(E * I - F * H) * invDet, (C * H - B * I) * invDet, (B * F - C * E) * invDet],
    [(F * G - D * I) * invDet, (A * I - C * G) * invDet, (C * D - A * F) * invDet],
    [(D * H - E * G) * invDet, (B * G - A * H) * invDet, (A * E - B * D) * invDet],
  ];
}

export function matVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function fracToCart(frac, lattice) {
  return frac.map((f) => [
    f[0] * lattice[0][0] + f[1] * lattice[1][0] + f[2] * lattice[2][0],
    f[0] * lattice[0][1] + f[1] * lattice[1][1] + f[2] * lattice[2][1],
    f[0] * lattice[0][2] + f[1] * lattice[1][2] + f[2] * lattice[2][2],
  ]);
}

export function cartToFrac(cart, lattice) {
  const inv = invert3x3(transpose3x3(lattice));
  return cart.map((c) => matVec(inv, c));
}
