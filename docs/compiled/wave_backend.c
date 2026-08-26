#include <math.h>
#include <stddef.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/*
 * Plane-wave (WAVECAR) numerics for WASM.
 *
 * Turning one VASP wavefunction into a scalar field is three steps, and all
 * three are hot enough to want to be out of JS:
 *
 *   1. gvecs   - enumerate the k-grid and keep the G with |k+G|^2/2 < ENCUT.
 *                O(nx*ny*nz) over the *reciprocal* grid, run once per k-point.
 *   2. scatter - place the plane-wave coefficients into an FFT box.
 *   3. ifft3   - inverse 3D FFT, then reduce |psi|^2 / Re / Im / signed |psi|
 *                to a Float32 field.
 *
 * The reference implementation this mirrors is httk's
 * `httk/atomistic/wavefunction.py` (gen_kgrid, gen_gvecs, to_real_wave,
 * expand_gamma_wav). Deviations from it are called out in comments where they
 * happen; the important ones are the FFT box sizing and the gamma handling.
 *
 * Data layout:
 * - complex arrays are interleaved doubles: value i is (buf[2i], buf[2i+1])
 * - the FFT box is indexed x-fastest, `idx = x + nx*(y + ny*z)`, which is the
 *   same order model/Field.js uses (`getValueAt: i + nx*(j + ny*k)`), so the
 *   reduced field needs no transpose before it reaches the marching cubes
 * - G-vectors are int triples, 3 per vector
 * - matrices are flat row-major length 9, rows are the lattice vectors, which
 *   matches math_backend.c and the JS lattice convention
 */

/* CODATA-ish constants, matching httk exactly so G-vector counts agree. */
#define WF_AU_TO_A 0.529177249
#define WF_RY_TO_EV 13.605826

enum {
  WF_OK = 0,
  WF_ERR_ALLOC = 1,
  WF_ERR_BAD_INPUT = 2,
  WF_ERR_BAD_SIZE = 3,
  WF_ERR_CAPACITY = 4
};

enum {
  WF_GAMMA_NONE = 0,
  WF_GAMMA_X = 1,
  WF_GAMMA_Z = 2
};

enum {
  WF_MODE_DENSITY = 0,   /* |psi|^2                          */
  WF_MODE_REAL = 1,      /* Re(psi)                          */
  WF_MODE_IMAG = 2,      /* Im(psi)                          */
  WF_MODE_SIGNED = 3     /* |psi| carrying the sign of Re    */
};

/*
 * Which piece of a two-component spinor wf_reduce_spinor should return.
 *
 * A non-collinear (LNONCOLLINEAR) WAVECAR stores 2*nplw coefficients per band:
 * the up component first, then the down component, both on the same G-vectors.
 * The first two entries here are those amplitudes; the remaining four are the
 * elements of that band's contribution to the density matrix,
 *
 *   rho_ab(r) = conj(psi_a(r)) * psi_b(r),
 *
 * whose diagonal is the spin-resolved density and whose off-diagonal carries
 * the transverse magnetisation (m_x = 2 Re rho_ud, m_y = -2 Im rho_ud).
 */
enum {
  WF_SPINOR_UP = 0,
  WF_SPINOR_DOWN = 1,
  WF_SPINOR_UP_UP = 2,
  WF_SPINOR_UP_DOWN = 3,
  WF_SPINOR_DOWN_UP = 4,
  WF_SPINOR_DOWN_DOWN = 5
};

/* Largest prime factor the mixed-radix FFT will handle in one butterfly. The
 * JS side always rounds the box up to a 5-smooth size, so this is only a
 * backstop against a caller that does not. */
#define WF_MAX_RADIX 64

/* ------------------------------------------------------------------ *
 * FFT box sizing
 * ------------------------------------------------------------------ */

/*
 * Next 5-smooth integer >= n (factors of 2, 3 and 5 only).
 *
 * httk transforms on a box of exactly 2*kgrid_size, which is 2*odd and so
 * needs a general-N transform (Bluestein). Zero-padding in G-space is exact
 * band-limited interpolation in real space, so growing the box to the next
 * 5-smooth size changes nothing physically while reducing the FFT to plain
 * radix-2/3/5. Costs at most ~20% more grid points.
 */
EMSCRIPTEN_KEEPALIVE
int wf_next_smooth(int n) {
  int candidate;

  if (n <= 1) return 1;

  for (candidate = n;; candidate++) {
    int rest = candidate;
    while (rest % 2 == 0) rest /= 2;
    while (rest % 3 == 0) rest /= 3;
    while (rest % 5 == 0) rest /= 5;
    if (rest == 1) return candidate;
  }
}

static int is_smooth_enough(int n) {
  int rest = n;
  int f;

  while (rest % 2 == 0) rest /= 2;
  while (rest % 3 == 0) rest /= 3;
  while (rest % 5 == 0) rest /= 5;
  if (rest == 1) return 1;

  /* Not 5-smooth: still fine as long as every remaining factor is small
   * enough for the O(p^2) butterfly. */
  for (f = 7; (long)f * f <= rest; f += 2) {
    while (rest % f == 0) {
      if (f > WF_MAX_RADIX) return 0;
      rest /= f;
    }
  }
  return rest <= WF_MAX_RADIX;
}

/* ------------------------------------------------------------------ *
 * G-vector generation
 * ------------------------------------------------------------------ */

/*
 * The FFT frequency ladder httk builds as
 *   ((arange(n) + n//2) % n) - n//2
 * i.e. for n = 5: [0, 1, 2, -2, -1].
 */
static int freq_at(int i, int n) {
  const int half = n / 2;
  return ((i + half) % n) - half;
}

/*
 * Enumerate the k-grid and keep the G-vectors inside the energy cutoff.
 *
 * kgrid     int[3]     grid size per axis (odd)
 * kvec      double[3]  fractional k-point
 * recip     double[9]  row-major 2*pi * reciprocal lattice; row j is b_j
 * encut     eV
 * gamma     WF_GAMMA_*
 * out       int32 buffer, 3 per accepted G. May be NULL to count only.
 * capacity  number of G-vectors `out` can hold (ignored when out is NULL)
 *
 * Returns the number of accepted G-vectors, or -WF_ERR_CAPACITY if `out` is
 * too small.
 *
 * ORDER IS LOAD-BEARING. VASP stores the coefficients in the order this loop
 * emits, which httk reproduces with meshgrid(fz, fy, fx, indexing='ij')
 * followed by a column reorder: z is the slowest axis and x the fastest. Emit
 * them in any other order and the wavefunction is silently scrambled rather
 * than visibly broken, so docs/tests/wave_backend_test.c pins both the ordering
 * and the resulting count.
 */
EMSCRIPTEN_KEEPALIVE
int wf_gen_gvecs(const int* kgrid, const double* kvec, const double* recip,
                 double encut, int gamma, int* out, int capacity) {
  /* hbar^2/(2 m_e) in eV*Angstrom^2 (== 3.80998...), as RY_TO_EV * AU_TO_A^2 */
  const double kin_prefactor = WF_RY_TO_EV * WF_AU_TO_A * WF_AU_TO_A;
  int nx, ny, nz;
  int ix, iy, iz;
  int count = 0;

  if (kgrid == NULL || kvec == NULL || recip == NULL) return -WF_ERR_BAD_INPUT;

  nx = kgrid[0];
  ny = kgrid[1];
  nz = kgrid[2];
  if (nx <= 0 || ny <= 0 || nz <= 0) return -WF_ERR_BAD_INPUT;

  for (iz = 0; iz < nz; iz++) {
    const int gz = freq_at(iz, nz);
    /* gamma-halved along z drops the negative half of the ladder outright */
    if (gamma == WF_GAMMA_Z && gz < 0) continue;

    for (iy = 0; iy < ny; iy++) {
      const int gy = freq_at(iy, ny);

      for (ix = 0; ix < nx; ix++) {
        const int gx = freq_at(ix, nx);
        double fx, fy, fz, cx, cy, cz, e_kin;

        if (gamma == WF_GAMMA_X && gx < 0) continue;

        /* Half-space filter: keep only one of each +-G pair, choosing the
         * lexicographically positive one along the halved axis first. */
        if (gamma == WF_GAMMA_X) {
          if (!(gx > 0 || (gx == 0 && gy > 0) || (gx == 0 && gy == 0 && gz >= 0))) continue;
        } else if (gamma == WF_GAMMA_Z) {
          if (!(gz > 0 || (gz == 0 && gy > 0) || (gz == 0 && gy == 0 && gx >= 0))) continue;
        }

        fx = (double)gx + kvec[0];
        fy = (double)gy + kvec[1];
        fz = (double)gz + kvec[2];

        /* (G + k) . recip, with the reciprocal vectors as rows */
        cx = fx * recip[0] + fy * recip[3] + fz * recip[6];
        cy = fx * recip[1] + fy * recip[4] + fz * recip[7];
        cz = fx * recip[2] + fy * recip[5] + fz * recip[8];

        e_kin = kin_prefactor * (cx * cx + cy * cy + cz * cz);
        if (e_kin >= encut) continue;

        if (out != NULL) {
          if (count >= capacity) return -WF_ERR_CAPACITY;
          out[count * 3 + 0] = gx;
          out[count * 3 + 1] = gy;
          out[count * 3 + 2] = gz;
        }
        count++;
      }
    }
  }

  return count;
}

/* ------------------------------------------------------------------ *
 * Scatter into the FFT box
 * ------------------------------------------------------------------ */

static int wrap_index(int g, int n) {
  int v = g % n;
  if (v < 0) v += n;
  return v;
}

/*
 * Place plane-wave coefficients at their G-vectors in a zeroed FFT box.
 *
 * For a gamma-compressed file the stored coefficients cover a half-space, so
 * each one is also written conjugated at -G, and everything except the G=0
 * term is scaled by 1/sqrt(2). That is exactly what httk's expand_gamma_wav
 * plus irfftn amounts to: Hermitian-expanding here instead lets the ordinary
 * complex inverse FFT below serve both cases, so there is no separate C2R
 * path to keep correct. The result comes out real to machine precision.
 */
EMSCRIPTEN_KEEPALIVE
int wf_scatter(double* box, const int* dims, const double* coeffs,
               const int* gvecs, int count, int gamma) {
  const double half_scale = 1.0 / sqrt(2.0);
  int nx, ny, nz, i;
  double scale;

  if (box == NULL || dims == NULL || coeffs == NULL || gvecs == NULL) return WF_ERR_BAD_INPUT;

  nx = dims[0];
  ny = dims[1];
  nz = dims[2];
  if (nx <= 0 || ny <= 0 || nz <= 0) return WF_ERR_BAD_INPUT;

  scale = (gamma == WF_GAMMA_NONE) ? 1.0 : half_scale;

  for (i = 0; i < count; i++) {
    const int gx = gvecs[i * 3 + 0];
    const int gy = gvecs[i * 3 + 1];
    const int gz = gvecs[i * 3 + 2];
    const int is_origin = (gx == 0 && gy == 0 && gz == 0);
    const double s = (gamma != WF_GAMMA_NONE && is_origin) ? 1.0 : scale;
    const double re = coeffs[i * 2 + 0] * s;
    const double im = coeffs[i * 2 + 1] * s;
    size_t idx = (size_t)wrap_index(gx, nx)
               + (size_t)nx * ((size_t)wrap_index(gy, ny)
               + (size_t)ny * (size_t)wrap_index(gz, nz));

    box[idx * 2 + 0] = re;
    box[idx * 2 + 1] = im;

    if (gamma != WF_GAMMA_NONE && !is_origin) {
      size_t mirror = (size_t)wrap_index(-gx, nx)
                    + (size_t)nx * ((size_t)wrap_index(-gy, ny)
                    + (size_t)ny * (size_t)wrap_index(-gz, nz));
      box[mirror * 2 + 0] = re;
      box[mirror * 2 + 1] = -im;
    }
  }

  return WF_OK;
}

/* ------------------------------------------------------------------ *
 * Mixed-radix FFT
 * ------------------------------------------------------------------ */

static int smallest_factor(int n) {
  int f;
  if (n % 2 == 0) return 2;
  if (n % 3 == 0) return 3;
  if (n % 5 == 0) return 5;
  for (f = 7; (long)f * f <= n; f += 2) {
    if (n % f == 0) return f;
  }
  return n;
}

/*
 * Recursive Cooley-Tukey with a direct O(p^2) butterfly per radix.
 *
 *   in       first element of the (strided) input line
 *   out      contiguous output, n complex values
 *   n        length of this sub-transform
 *   in_stride input stride in complex elements
 *   tw       twiddle table for the TOP-LEVEL length: tw[t] = exp(s*2*pi*i*t/N)
 *   N        top-level length
 *   tw_step  N / n, so that W_n^t == tw[(t * tw_step) % N]
 *
 * Radices are at most 5 in practice, so the direct butterfly costs 25 complex
 * multiplies at worst and buys a much smaller (and much easier to verify)
 * implementation than hand-written radix kernels.
 */
static void dft_rec(const double* in, double* out, int n, int in_stride,
                    const double* tw, int N, int tw_step) {
  double tre[WF_MAX_RADIX];
  double tim[WF_MAX_RADIX];
  int p, m, q, j, k, wp;

  if (n == 1) {
    out[0] = in[0];
    out[1] = in[1];
    return;
  }

  p = smallest_factor(n);
  m = n / p;

  for (q = 0; q < p; q++) {
    dft_rec(in + 2 * (size_t)q * in_stride, out + 2 * (size_t)q * m,
            m, in_stride * p, tw, N, tw_step * p);
  }

  /* X[k + j*m] = sum_q W_n^{qk} * Y_q[k] * W_p^{qj}
   * For a fixed k the p touched slots are exactly out[q*m + k], so reading
   * them into tre/tim first makes the write-back safe in place. */
  wp = N / p;
  for (k = 0; k < m; k++) {
    for (q = 0; q < p; q++) {
      const size_t at = 2 * ((size_t)q * m + k);
      const double yr = out[at];
      const double yi = out[at + 1];
      const long t = ((long)q * k * tw_step) % N;
      const double wr = tw[2 * t];
      const double wi = tw[2 * t + 1];
      tre[q] = yr * wr - yi * wi;
      tim[q] = yr * wi + yi * wr;
    }
    for (j = 0; j < p; j++) {
      double sr = 0.0;
      double si = 0.0;
      for (q = 0; q < p; q++) {
        const long t = ((long)q * j * wp) % N;
        const double wr = tw[2 * t];
        const double wi = tw[2 * t + 1];
        sr += tre[q] * wr - tim[q] * wi;
        si += tre[q] * wi + tim[q] * wr;
      }
      out[2 * ((size_t)j * m + k)] = sr;
      out[2 * ((size_t)j * m + k) + 1] = si;
    }
  }
}

static int fft_axis(double* box, const int* dims, int axis, int sign) {
  const int nx = dims[0];
  const int ny = dims[1];
  const int nz = dims[2];
  const int n = dims[axis];
  const int stride = (axis == 0) ? 1 : (axis == 1 ? nx : nx * ny);
  double* tw;
  double* line;
  int t, a, b, i;

  if (!is_smooth_enough(n)) return WF_ERR_BAD_SIZE;

  tw = (double*)malloc(sizeof(double) * 2 * (size_t)n);
  line = (double*)malloc(sizeof(double) * 2 * (size_t)n);
  if (tw == NULL || line == NULL) {
    free(tw);
    free(line);
    return WF_ERR_ALLOC;
  }

  for (t = 0; t < n; t++) {
    const double angle = (double)sign * 2.0 * M_PI * (double)t / (double)n;
    tw[2 * t] = cos(angle);
    tw[2 * t + 1] = sin(angle);
  }

  /* `a` and `b` walk the two axes that are not being transformed. */
  for (a = 0; a < ((axis == 2) ? ny : nz); a++) {
    for (b = 0; b < ((axis == 0) ? ny : nx); b++) {
      size_t base;
      if (axis == 0) {
        base = ((size_t)a * ny + b) * nx;
      } else if (axis == 1) {
        base = (size_t)a * nx * ny + b;
      } else {
        base = (size_t)a * nx + b;
      }

      dft_rec(box + 2 * base, line, n, stride, tw, n, 1);

      for (i = 0; i < n; i++) {
        const size_t at = 2 * (base + (size_t)i * stride);
        box[at] = line[2 * i];
        box[at + 1] = line[2 * i + 1];
      }
    }
  }

  free(tw);
  free(line);
  return WF_OK;
}

/*
 * In-place 3D FFT of an interleaved complex box. `sign` is +1 for the inverse
 * transform (the direction this module needs) and -1 for the forward one.
 *
 * Deliberately unscaled: wf_reduce_scalar renormalises to sum |psi|^2 dV = 1,
 * which makes the result independent of the padded box size. httk instead uses
 * numpy's "ortho" norm and then divides by the L2 norm, which is the same
 * thing up to a grid-dependent constant.
 */
EMSCRIPTEN_KEEPALIVE
int wf_ifft3(double* box, const int* dims, int sign) {
  int axis;

  if (box == NULL || dims == NULL) return WF_ERR_BAD_INPUT;
  if (dims[0] <= 0 || dims[1] <= 0 || dims[2] <= 0) return WF_ERR_BAD_INPUT;

  for (axis = 0; axis < 3; axis++) {
    const int status = fft_axis(box, dims, axis, sign);
    if (status != WF_OK) return status;
  }

  return WF_OK;
}

/* ------------------------------------------------------------------ *
 * Reduction to a scalar field
 * ------------------------------------------------------------------ */

/*
 * Reduce one complex value to the requested scalar.
 *
 * `squared` picks the WF_MODE_DENSITY convention. An amplitude psi reduces to
 * |psi|^2, because that is the density it represents; a density-matrix element
 * rho is already a density, so it reduces to |rho| and squaring it again would
 * be meaningless. The other three modes are the same for both.
 */
static double reduce_value(double re, double im, int mode, int squared) {
  switch (mode) {
    case WF_MODE_REAL:
      return re;
    case WF_MODE_IMAG:
      return im;
    case WF_MODE_SIGNED: {
      const double magnitude = sqrt(re * re + im * im);
      return (re < 0.0) ? -magnitude : magnitude;
    }
    case WF_MODE_DENSITY:
    default:
      return squared ? (re * re + im * im) : sqrt(re * re + im * im);
  }
}

/*
 * Running [min, max, absMin, absMax] over the samples actually stored.
 *
 * The stats are accumulated from the float32 that was written, not from the
 * double it came from. The isovalue slider in ui/FieldPanel.js maps its range
 * onto [minValue, maxValue], so a max that no stored sample can reach leaves
 * the top of the slider producing an empty surface. The CHGCAR/cube readers
 * derive their stats from the Float32Array for the same reason.
 */
typedef struct {
  double min_v;
  double max_v;
  double abs_min;
  double abs_max;
  int seen;
} wf_stats;

static void stats_init(wf_stats* s) {
  s->min_v = 0.0;
  s->max_v = 0.0;
  s->abs_min = 0.0;
  s->abs_max = 0.0;
  s->seen = 0;
}

static void stats_add(wf_stats* s, float stored) {
  const double v = (double)stored;
  const double av = fabs(v);

  if (!s->seen) {
    s->min_v = v;
    s->max_v = v;
    s->abs_min = av;
    s->abs_max = av;
    s->seen = 1;
    return;
  }
  if (v < s->min_v) s->min_v = v;
  if (v > s->max_v) s->max_v = v;
  if (av < s->abs_min) s->abs_min = av;
  if (av > s->abs_max) s->abs_max = av;
}

static void stats_write(const wf_stats* s, double* out) {
  out[0] = s->min_v;
  out[1] = s->max_v;
  out[2] = s->abs_min;
  out[3] = s->abs_max;
}

/*
 * Normalise the wavefunction to sum |psi|^2 dV = 1 and write the requested
 * scalar out as float32, reporting min/max/absMin/absMax in the same pass.
 *
 * `stats` receives [min, max, absMin, absMax], the four numbers model/Field.js
 * carries and ui/FieldPanel.js's slider mapping reads.
 *
 * WF_MODE_SIGNED is |psi| carrying sign(Re psi) - httk's reduce_std_coeffs
 * uses the same construction. It is what makes the existing positive/negative
 * isosurface pair meaningful for an orbital: |psi|^2 is non-negative, so the
 * negative surface would otherwise always be empty.
 */
EMSCRIPTEN_KEEPALIVE
int wf_reduce_scalar(const double* box, int count, int mode, double dv,
                     float* out, double* stats) {
  double total = 0.0;
  double scale;
  wf_stats acc;
  int i;

  if (box == NULL || out == NULL || stats == NULL) return WF_ERR_BAD_INPUT;
  if (count <= 0) return WF_ERR_BAD_INPUT;

  for (i = 0; i < count; i++) {
    const double re = box[i * 2];
    const double im = box[i * 2 + 1];
    total += (re * re + im * im) * dv;
  }

  scale = (total > 0.0) ? (1.0 / sqrt(total)) : 1.0;

  stats_init(&acc);
  for (i = 0; i < count; i++) {
    const double re = box[i * 2] * scale;
    const double im = box[i * 2 + 1] * scale;

    out[i] = (float)reduce_value(re, im, mode, 1);
    stats_add(&acc, out[i]);
  }

  stats_write(&acc, stats);
  return WF_OK;
}

/*
 * The same reduction for a non-collinear band, whose wavefunction is the
 * two-component spinor (psi_up, psi_down) held in two separately-transformed
 * boxes of the same shape.
 *
 * `component` is a WF_SPINOR_* selector: either one of the two amplitudes, or
 * one element of rho_ab = conj(psi_a) psi_b. `mode` then reduces whatever that
 * picks to a real scalar, exactly as wf_reduce_scalar does for a collinear
 * band.
 *
 * The normalisation is the important difference from calling wf_reduce_scalar
 * twice. A spinor is normalised as a whole,
 *
 *   sum (|psi_up|^2 + |psi_down|^2) dV = 1,
 *
 * so the same scale factor is applied to both components. Normalising each one
 * on its own would rescale a nearly-empty minority component up to the same
 * weight as the majority one and erase the spin texture, which is the entire
 * content of a non-collinear calculation.
 */
EMSCRIPTEN_KEEPALIVE
int wf_reduce_spinor(const double* box_up, const double* box_down, int count,
                     int component, int mode, double dv,
                     float* out, double* stats) {
  double total = 0.0;
  double scale;
  wf_stats acc;
  int i;

  if (box_up == NULL || box_down == NULL || out == NULL || stats == NULL) {
    return WF_ERR_BAD_INPUT;
  }
  if (count <= 0) return WF_ERR_BAD_INPUT;
  if (component < WF_SPINOR_UP || component > WF_SPINOR_DOWN_DOWN) return WF_ERR_BAD_INPUT;

  for (i = 0; i < count; i++) {
    const double ur = box_up[i * 2];
    const double ui = box_up[i * 2 + 1];
    const double dr = box_down[i * 2];
    const double di = box_down[i * 2 + 1];
    total += (ur * ur + ui * ui + dr * dr + di * di) * dv;
  }

  scale = (total > 0.0) ? (1.0 / sqrt(total)) : 1.0;

  stats_init(&acc);
  for (i = 0; i < count; i++) {
    const double ur = box_up[i * 2] * scale;
    const double ui = box_up[i * 2 + 1] * scale;
    const double dr = box_down[i * 2] * scale;
    const double di = box_down[i * 2 + 1] * scale;
    /* An amplitude squares under WF_MODE_DENSITY; a rho element does not. */
    int squared = 0;
    double zr;
    double zi;

    switch (component) {
      case WF_SPINOR_UP:
        zr = ur; zi = ui; squared = 1;
        break;
      case WF_SPINOR_DOWN:
        zr = dr; zi = di; squared = 1;
        break;
      case WF_SPINOR_UP_UP:
        zr = ur * ur + ui * ui; zi = 0.0;
        break;
      case WF_SPINOR_DOWN_DOWN:
        zr = dr * dr + di * di; zi = 0.0;
        break;
      case WF_SPINOR_UP_DOWN:
        /* conj(psi_up) * psi_down */
        zr = ur * dr + ui * di; zi = ur * di - ui * dr;
        break;
      case WF_SPINOR_DOWN_UP:
      default:
        /* conj(psi_down) * psi_up, i.e. the conjugate of the entry above */
        zr = dr * ur + di * ui; zi = dr * ui - di * ur;
        break;
    }

    out[i] = (float)reduce_value(zr, zi, mode, squared);
    stats_add(&acc, out[i]);
  }

  stats_write(&acc, stats);
  return WF_OK;
}
