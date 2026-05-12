#include <math.h>
#include <stddef.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/*
 * Simple C math backend intended for WASM compilation.
 *
 * These functions target the operations that are most likely to benefit from a
 * JS -> WASM boundary crossing:
 * - batched fractional -> cartesian transforms
 * - batched cartesian -> fractional transforms
 * - reusable 3x3 inversion for lattice transforms
 *
 * Data layout:
 * - matrices are flat row-major arrays of length 9
 * - vectors are flat arrays of length 3 * count
 * - lattice layout matches the JS codebase:
 *   lattice rows are the a, b, c lattice vectors
 *
 * Notes:
 * - `frac_to_cart_batch` matches JS `fracToCart`
 * - `cart_to_frac_batch` matches JS `cartToFractional`, which uses
 *   inverse(transpose(lattice))
 */

enum {
  MATH_OK = 0,
  MATH_ERR_SINGULAR = 1,
  MATH_ERR_BAD_INPUT = 2
};

static double clamp_double(double value, double min, double max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

static int invert3x3_impl(const double* m, double tolerance, double* out) {
  const double A = m[0];
  const double B = m[1];
  const double C = m[2];
  const double D = m[3];
  const double E = m[4];
  const double F = m[5];
  const double G = m[6];
  const double H = m[7];
  const double I = m[8];

  const double det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (fabs(det) < tolerance) return MATH_ERR_SINGULAR;

  const double inv_det = 1.0 / det;

  out[0] = (E * I - F * H) * inv_det;
  out[1] = (C * H - B * I) * inv_det;
  out[2] = (B * F - C * E) * inv_det;
  out[3] = (F * G - D * I) * inv_det;
  out[4] = (A * I - C * G) * inv_det;
  out[5] = (C * D - A * F) * inv_det;
  out[6] = (D * H - E * G) * inv_det;
  out[7] = (B * G - A * H) * inv_det;
  out[8] = (A * E - B * D) * inv_det;

  return MATH_OK;
}

static void transpose3x3_impl(const double* m, double* out) {
  out[0] = m[0];
  out[1] = m[3];
  out[2] = m[6];
  out[3] = m[1];
  out[4] = m[4];
  out[5] = m[7];
  out[6] = m[2];
  out[7] = m[5];
  out[8] = m[8];
}

static void mat_vec3_impl(const double* m, const double* v, double* out) {
  out[0] = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
  out[1] = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
  out[2] = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
}

static double normalize_fractional_scalar(double value) {
  double normalized;

  if (!isfinite(value)) return 0.0;

  normalized = value - floor(value);
  if (normalized < 0.0) normalized += 1.0;
  if (fabs(normalized) < 1e-8) normalized = 0.0;
  if (fabs(normalized - 1.0) < 1e-8) normalized = 0.0;
  return normalized;
}

EMSCRIPTEN_KEEPALIVE
int invert3x3(const double* m, double tolerance, double* out) {
  if (m == NULL || out == NULL) return MATH_ERR_BAD_INPUT;
  return invert3x3_impl(m, tolerance, out);
}

EMSCRIPTEN_KEEPALIVE
void frac_to_cart_batch(const double* frac, int count, const double* lattice, double* out) {
  int i;

  if (frac == NULL || lattice == NULL || out == NULL || count <= 0) return;

  for (i = 0; i < count; i++) {
    const double f0 = frac[i * 3 + 0];
    const double f1 = frac[i * 3 + 1];
    const double f2 = frac[i * 3 + 2];

    out[i * 3 + 0] = f0 * lattice[0] + f1 * lattice[3] + f2 * lattice[6];
    out[i * 3 + 1] = f0 * lattice[1] + f1 * lattice[4] + f2 * lattice[7];
    out[i * 3 + 2] = f0 * lattice[2] + f1 * lattice[5] + f2 * lattice[8];
  }
}

EMSCRIPTEN_KEEPALIVE
int cart_to_frac_batch(const double* cart, int count, const double* lattice, double* out) {
  double lattice_t[9];
  double inverse[9];
  int i;
  int status;

  if (cart == NULL || lattice == NULL || out == NULL || count <= 0) return MATH_ERR_BAD_INPUT;

  transpose3x3_impl(lattice, lattice_t);
  status = invert3x3_impl(lattice_t, 1e-12, inverse);
  if (status != MATH_OK) return status;

  for (i = 0; i < count; i++) {
    mat_vec3_impl(&inverse[0], &cart[i * 3], &out[i * 3]);
  }

  return MATH_OK;
}

EMSCRIPTEN_KEEPALIVE
int cart_to_frac_batch_wrapped(const double* cart, int count, const double* lattice, double* out) {
  int i;
  int status = cart_to_frac_batch(cart, count, lattice, out);
  if (status != MATH_OK) return status;

  for (i = 0; i < count * 3; i++) {
    out[i] = normalize_fractional_scalar(out[i]);
  }

  return MATH_OK;
}

EMSCRIPTEN_KEEPALIVE
void normalize_fractional_batch(double* values, int count) {
  int i;
  if (values == NULL || count <= 0) return;

  for (i = 0; i < count; i++) {
    values[i] = normalize_fractional_scalar(values[i]);
  }
}

EMSCRIPTEN_KEEPALIVE
double lattice_volume(const double* lattice) {
  const double ax = lattice[0];
  const double ay = lattice[1];
  const double az = lattice[2];
  const double bx = lattice[3];
  const double by = lattice[4];
  const double bz = lattice[5];
  const double cx = lattice[6];
  const double cy = lattice[7];
  const double cz = lattice[8];

  const double cross_x = by * cz - bz * cy;
  const double cross_y = bz * cx - bx * cz;
  const double cross_z = bx * cy - by * cx;
  const double dot = ax * cross_x + ay * cross_y + az * cross_z;
  return fabs(dot);
}

EMSCRIPTEN_KEEPALIVE
void lattice_parameters(const double* lattice, double* out) {
  const double ax = lattice[0];
  const double ay = lattice[1];
  const double az = lattice[2];
  const double bx = lattice[3];
  const double by = lattice[4];
  const double bz = lattice[5];
  const double cx = lattice[6];
  const double cy = lattice[7];
  const double cz = lattice[8];

  const double a = sqrt(ax * ax + ay * ay + az * az);
  const double b = sqrt(bx * bx + by * by + bz * bz);
  const double c = sqrt(cx * cx + cy * cy + cz * cz);

  const double bc = bx * cx + by * cy + bz * cz;
  const double ac = ax * cx + ay * cy + az * cz;
  const double ab = ax * bx + ay * by + az * bz;

  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = acos(clamp_double(bc / ((b * c) > 0.0 ? (b * c) : 1.0), -1.0, 1.0)) * 180.0 / M_PI;
  out[4] = acos(clamp_double(ac / ((a * c) > 0.0 ? (a * c) : 1.0), -1.0, 1.0)) * 180.0 / M_PI;
  out[5] = acos(clamp_double(ab / ((a * b) > 0.0 ? (a * b) : 1.0), -1.0, 1.0)) * 180.0 / M_PI;
  out[6] = lattice_volume(lattice);
}
