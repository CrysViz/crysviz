/*
 * Native test harness for docs/compiled/wave_backend.c.
 *
 * The plane-wave backend is portable C99, so it can be compiled and tested with
 * an ordinary host compiler. That matters for two reasons: the FFT and the
 * G-vector ordering are the places where a mistake produces a plausible-looking
 * but wrong wavefunction rather than an error, and emscripten is not always
 * available (see the notes in docs/compiled/Makefile).
 *
 * Build and run:
 *   gcc -O2 -I docs/compiled docs/tests/wave_backend_test.c -o wave_backend_test -lm
 *   ./wave_backend_test
 *
 * The WASM build is checked separately by docs/tests/wave_backend_smoke.mjs, which
 * runs the same operations through the compiled module's JS boundary.
 */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

#include "wave_backend.c"

static int failures = 0;

static void check(int cond, const char* what) {
  if (cond) {
    printf("  ok   %s\n", what);
  } else {
    printf("  FAIL %s\n", what);
    failures++;
  }
}

static void check_close(double a, double b, double tol, const char* what) {
  if (fabs(a - b) <= tol) {
    printf("  ok   %s (%.12g ~ %.12g)\n", what, a, b);
  } else {
    printf("  FAIL %s (%.12g != %.12g, tol %g)\n", what, a, b, tol);
    failures++;
  }
}

/* ---- reference DFT, used to validate the mixed-radix implementation ---- */
static void naive_dft3(const double* in, double* out, int nx, int ny, int nz, int sign) {
  int x, y, z, u, v, w;
  for (x = 0; x < nx; x++)
    for (y = 0; y < ny; y++)
      for (z = 0; z < nz; z++) {
        double sr = 0.0, si = 0.0;
        for (u = 0; u < nx; u++)
          for (v = 0; v < ny; v++)
            for (w = 0; w < nz; w++) {
              double ang = sign * 2.0 * M_PI * ((double)u * x / nx + (double)v * y / ny + (double)w * z / nz);
              double c = cos(ang), s = sin(ang);
              size_t si_ = (size_t)u + (size_t)nx * ((size_t)v + (size_t)ny * (size_t)w);
              double ar = in[si_ * 2], ai = in[si_ * 2 + 1];
              sr += ar * c - ai * s;
              si += ar * s + ai * c;
            }
        size_t oi = (size_t)x + (size_t)nx * ((size_t)y + (size_t)ny * (size_t)z);
        out[oi * 2] = sr;
        out[oi * 2 + 1] = si;
      }
}

static void test_next_smooth(void) {
  printf("wf_next_smooth\n");
  check(wf_next_smooth(1) == 1, "1 -> 1");
  check(wf_next_smooth(70) == 72, "70 -> 72");
  check(wf_next_smooth(71) == 72, "71 -> 72");
  check(wf_next_smooth(72) == 72, "72 stays 72");
  check(wf_next_smooth(73) == 75, "73 -> 75");
  check(wf_next_smooth(121) == 125, "121 -> 125");
  /* every result must be 5-smooth and >= input */
  {
    int n, bad = 0;
    for (n = 1; n < 2000; n++) {
      int r = wf_next_smooth(n), rest = r;
      while (rest % 2 == 0) rest /= 2;
      while (rest % 3 == 0) rest /= 3;
      while (rest % 5 == 0) rest /= 5;
      if (rest != 1 || r < n) bad++;
    }
    check(bad == 0, "1..2000 all 5-smooth and >= n");
  }
}

static void test_fft_against_naive(void) {
  int dims[3] = {6, 5, 4};  /* radix 2, 3 and 5 all exercised */
  int count = dims[0] * dims[1] * dims[2];
  double* a = malloc(sizeof(double) * 2 * count);
  double* b = malloc(sizeof(double) * 2 * count);
  double* ref = malloc(sizeof(double) * 2 * count);
  int i;
  double worst = 0.0;

  printf("wf_ifft3 vs naive DFT (6x5x4)\n");
  srand(1234);
  for (i = 0; i < 2 * count; i++) a[i] = (double)rand() / RAND_MAX - 0.5;
  memcpy(b, a, sizeof(double) * 2 * count);

  naive_dft3(a, ref, dims[0], dims[1], dims[2], 1);
  check(wf_ifft3(b, dims, 1) == WF_OK, "returns WF_OK");

  for (i = 0; i < 2 * count; i++) {
    double d = fabs(b[i] - ref[i]);
    if (d > worst) worst = d;
  }
  check_close(worst, 0.0, 1e-10, "max abs deviation from reference");

  /* forward then inverse must return N * original */
  memcpy(b, a, sizeof(double) * 2 * count);
  wf_ifft3(b, dims, -1);
  wf_ifft3(b, dims, 1);
  worst = 0.0;
  for (i = 0; i < 2 * count; i++) {
    double d = fabs(b[i] / count - a[i]);
    if (d > worst) worst = d;
  }
  check_close(worst, 0.0, 1e-10, "round trip forward+inverse == N * input");

  free(a); free(b); free(ref);
}

static void test_fft_larger(void) {
  /* a 5-smooth size that a real WAVECAR would produce */
  int dims[3] = {72, 45, 50};
  int count = dims[0] * dims[1] * dims[2];
  double* box = calloc((size_t)count * 2, sizeof(double));
  int status;

  printf("wf_ifft3 on a realistic box (72x45x50 = %d points)\n", count);
  /* single plane wave at G=(1,0,0): inverse FFT must give a pure sinusoid */
  box[2 * (size_t)1] = 1.0;  /* index x=1,y=0,z=0 */
  status = wf_ifft3(box, dims, 1);
  check(status == WF_OK, "returns WF_OK");
  {
    int x, bad = 0;
    for (x = 0; x < dims[0]; x++) {
      double ang = 2.0 * M_PI * (double)x / dims[0];
      size_t idx = (size_t)x;  /* y=0,z=0 */
      if (fabs(box[idx * 2] - cos(ang)) > 1e-9) bad++;
      if (fabs(box[idx * 2 + 1] - sin(ang)) > 1e-9) bad++;
    }
    check(bad == 0, "single plane wave transforms to exp(2*pi*i*x/nx)");
  }
  free(box);
}

static void test_gvec_order_and_gamma(void) {
  /* cubic 10 A cell; recip rows are 2*pi/a along each axis */
  const double a = 10.0;
  double recip[9] = {0};
  int kgrid[3];
  double kvec[3] = {0.0, 0.0, 0.0};
  double encut = 400.0;
  int i, bound, n_std, n_gx, n_gz;
  int* out;

  printf("wf_gen_gvecs\n");
  for (i = 0; i < 3; i++) recip[i * 3 + i] = 2.0 * M_PI / a;

  /* kgrid_size per httk: ceil(sqrt(encut/RY) * |a| / AU / 2pi) * 2 + 1 */
  for (i = 0; i < 3; i++) {
    double g = sqrt(encut / WF_RY_TO_EV) * a / WF_AU_TO_A / (2.0 * M_PI);
    kgrid[i] = (int)ceil(g) * 2 + 1;
  }
  printf("  kgrid = %d %d %d\n", kgrid[0], kgrid[1], kgrid[2]);

  bound = kgrid[0] * kgrid[1] * kgrid[2];
  out = malloc(sizeof(int) * 3 * bound);

  n_std = wf_gen_gvecs(kgrid, kvec, recip, encut, WF_GAMMA_NONE, out, bound);
  check(n_std > 0, "standard mode returns a positive count");

  /* counting pass (out == NULL) must agree with the filling pass */
  check(wf_gen_gvecs(kgrid, kvec, recip, encut, WF_GAMMA_NONE, NULL, 0) == n_std,
        "count-only pass matches");

  /* The sphere |k+G|^2 * prefactor < encut has a known volume; the count is
   * (4/3)pi R^3 in units of the reciprocal cell, R = sqrt(encut/prefactor). */
  {
    double prefactor = WF_RY_TO_EV * WF_AU_TO_A * WF_AU_TO_A;
    double R = sqrt(encut / prefactor);                 /* in 1/Angstrom */
    double cell = (2.0 * M_PI / a) * (2.0 * M_PI / a) * (2.0 * M_PI / a);
    double expect = (4.0 / 3.0) * M_PI * R * R * R / cell;
    printf("  count = %d, sphere estimate = %.1f\n", n_std, expect);
    check(fabs(n_std - expect) / expect < 0.02, "count within 2% of the sphere volume");
  }

  /* gamma halves must be almost exactly half, plus the G=0 term */
  n_gx = wf_gen_gvecs(kgrid, kvec, recip, encut, WF_GAMMA_X, NULL, 0);
  n_gz = wf_gen_gvecs(kgrid, kvec, recip, encut, WF_GAMMA_Z, NULL, 0);
  printf("  gamma-x = %d, gamma-z = %d\n", n_gx, n_gz);
  check(n_gx == (n_std + 1) / 2, "gamma-x count is (std+1)/2");
  check(n_gz == (n_std + 1) / 2, "gamma-z count is (std+1)/2");

  /* ordering: z slowest, x fastest. Walk the emitted list and confirm the
   * frequency ladder index is non-decreasing in z, then y, then x. */
  {
    int prev_iz = -1, prev_iy = -1, prev_ix = -1, bad = 0;
    for (i = 0; i < n_std; i++) {
      int gx = out[i * 3], gy = out[i * 3 + 1], gz = out[i * 3 + 2];
      /* freq_at(i,n) = ((i + n/2) % n) - n/2, and for |g| <= n/2 that inverts
       * to simply i = g mod n, so the wrapped index IS the ladder position. */
      int px = (gx % kgrid[0] + kgrid[0]) % kgrid[0];
      int py = (gy % kgrid[1] + kgrid[1]) % kgrid[1];
      int pz = (gz % kgrid[2] + kgrid[2]) % kgrid[2];
      if (pz < prev_iz) bad++;
      else if (pz == prev_iz && py < prev_iy) bad++;
      else if (pz == prev_iz && py == prev_iy && px <= prev_ix) bad++;
      prev_iz = pz; prev_iy = py; prev_ix = px;
    }
    check(bad == 0, "emitted in z-slowest / x-fastest ladder order");
  }

  /* the first vector must be G = 0 (ladder starts at frequency 0 on all axes) */
  check(out[0] == 0 && out[1] == 0 && out[2] == 0, "first G-vector is (0,0,0)");

  free(out);
}

static void test_scatter_gamma_gives_real(void) {
  int dims[3] = {8, 8, 8};
  int count = dims[0] * dims[1] * dims[2];
  double* box = calloc((size_t)count * 2, sizeof(double));
  /* a small gamma half-space: origin plus three vectors */
  int gvecs[12] = {0, 0, 0,  1, 0, 0,  0, 1, 0,  1, 2, -3};
  double coeffs[8] = {0.7, 0.0,  0.3, 0.4,  -0.2, 0.5,  0.15, -0.25};
  int i, bad = 0;
  double max_im = 0.0;

  printf("wf_scatter gamma expansion -> real space\n");
  check(wf_scatter(box, dims, coeffs, gvecs, 4, WF_GAMMA_X) == WF_OK, "scatter returns WF_OK");
  check(wf_ifft3(box, dims, 1) == WF_OK, "ifft returns WF_OK");

  for (i = 0; i < count; i++) {
    double im = fabs(box[i * 2 + 1]);
    if (im > max_im) max_im = im;
    if (im > 1e-12) bad++;
  }
  printf("  max |Im| = %g\n", max_im);
  check(max_im < 1e-12, "gamma-expanded wavefunction is real to machine precision");

  free(box);
}

static void test_reduce_scalar(void) {
  int count = 4;
  double box[8] = {3.0, 4.0,  -1.0, 0.0,  0.0, 2.0,  0.5, 0.5};
  float out[4];
  double stats[4];
  double dv = 0.25;
  double total = 0.0, check_sum = 0.0;
  int i;

  printf("wf_reduce_scalar\n");
  for (i = 0; i < count; i++) total += (box[i * 2] * box[i * 2] + box[i * 2 + 1] * box[i * 2 + 1]) * dv;

  check(wf_reduce_scalar(box, count, WF_MODE_DENSITY, dv, out, stats) == WF_OK, "density returns WF_OK");
  for (i = 0; i < count; i++) check_sum += out[i] * dv;
  check_close(check_sum, 1.0, 1e-6, "sum |psi|^2 dV == 1");
  check(stats[0] >= 0.0, "density min is non-negative");
  check_close(stats[1], out[0], 0.0, "density max matches the stored float32 exactly");

  check(wf_reduce_scalar(box, count, WF_MODE_SIGNED, dv, out, stats) == WF_OK, "signed returns WF_OK");
  /* element 1 is (-1, 0): magnitude carries sign(Re) so it must be negative */
  check(out[1] < 0.0, "signed mode keeps sign(Re) on element 1");
  check(out[0] > 0.0, "signed mode positive on element 0");
  check_sum = 0.0;
  for (i = 0; i < count; i++) check_sum += (double)out[i] * out[i] * dv;
  check_close(check_sum, 1.0, 1e-6, "sum |psi|^2 dV == 1 in signed mode too");

  check(wf_reduce_scalar(box, count, WF_MODE_REAL, dv, out, stats) == WF_OK, "real returns WF_OK");
  check(stats[0] < 0.0 && stats[1] > 0.0, "real mode spans negative and positive");
}

int main(void) {
  test_next_smooth();
  test_fft_against_naive();
  test_fft_larger();
  test_gvec_order_and_gamma();
  test_scatter_gamma_gives_real();
  test_reduce_scalar();

  printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "ALL PASSED",
         failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
