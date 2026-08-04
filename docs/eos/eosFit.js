// SciPy (via Pyodide, in-browser) Birch-Murnaghan curve fitting for the EOS
// panel. Pyodide + numpy/scipy are heavy (several MB) so they are only
// imported the first time a fit is actually requested.

const PYODIDE_MODULE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.mjs';
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/';

let pyodidePromise = null;

/**
 * Load Pyodide + numpy/scipy once and cache it. `onStatus(text)` is called
 * with human-readable progress; safe to omit.
 * @param {(text: string) => void} [onStatus]
 */
export function ensurePyodideReady(onStatus = () => {}) {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      onStatus('Loading Pyodide…');
      const { loadPyodide } = await import(PYODIDE_MODULE_URL);
      const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      onStatus('Loading numpy…');
      await pyodide.loadPackage('numpy');
      onStatus('Loading scipy…');
      await pyodide.loadPackage('scipy');
      onStatus('Ready');
      return pyodide;
    })().catch((error) => {
      pyodidePromise = null; // allow retry on next call
      const unavailable = new Error('SciPy fitting is unavailable offline; connect to the network and try again.');
      unavailable.cause = error;
      onStatus(unavailable.message);
      throw unavailable;
    });
  }
  return pyodidePromise;
}

const BM_PYTHON_FUNCTIONS = `
import numpy as np
from scipy.optimize import curve_fit

def birch_murnaghan_energy(V, E0, V0, K0, K0Prime):
    A3_GPA_TO_EV = 0.006241509
    eta = (V0 / V) ** (2/3)
    eta_minus_1 = eta - 1
    term1 = (eta_minus_1 ** 3) * K0Prime
    term2 = (eta_minus_1 ** 2) * (6 - 4 * eta)
    return E0 + (9 * V0 * K0 / 16) * A3_GPA_TO_EV * (term1 + term2)

def birch_murnaghan_pressure(V, V0, K0, K0Prime):
    ratio = V0 / V
    r53 = ratio ** (5/3)
    r73 = ratio ** (7/3)
    r23 = ratio ** (2/3)
    term3 = 1 + (3/4) * (K0Prime - 4) * (r23 - 1)
    return (3 * K0 / 2) * (r73 - r53) * term3

def estimate_k0(volumes, pressures):
    v0 = volumes[np.argmin(np.abs(pressures))]
    sum_num, sum_den = 0.0, 0.0
    for i in range(len(volumes)):
        dV = volumes[i] - v0
        if abs(dV) / v0 < 0.05:
            sum_num += pressures[i] * dV
            sum_den += dV * dV
    return v0, (-v0 * (sum_num / sum_den) if sum_den != 0 else 300.0)
`;

function nullResult(nParams) {
  return { params: Array(nParams).fill(0), errors: Array(nParams).fill(undefined), fitStats: { rms: 0, maxRes: 0, nPoints: 0 } };
}

/** Fit just the Birch-Murnaghan P-V curve. Shared by the energy-less primary
 *  dataset path and the reference-dataset overlay. */
async function runPVFit(pyodide, volumes, pressures) {
  pyodide.globals.set('js_pv_volumes', volumes);
  pyodide.globals.set('js_pv_pressures', pressures);

  const pythonCode = `${BM_PYTHON_FUNCTIONS}
import json

volumes = np.array(js_pv_volumes)
pressures = np.array(js_pv_pressures)
v0_initial, k0_estimate = estimate_k0(volumes, pressures)

try:
    popt, pcov = curve_fit(
        birch_murnaghan_pressure, volumes, pressures,
        p0=[v0_initial, k0_estimate, 4.0], maxfev=5000
    )
    errors = [float(x) for x in np.sqrt(np.diag(pcov))] if pcov is not None else [None, None, None]
    res = pressures - birch_murnaghan_pressure(volumes, *popt)
    rms = float(np.sqrt(np.mean(res ** 2)))
    max_res = float(np.max(np.abs(res)))
except Exception:
    popt = [v0_initial, k0_estimate, 4.0]
    errors = [None, None, None]
    rms = 0.0
    max_res = 0.0

json.dumps({'params': [float(x) for x in popt], 'errors': errors,
            'fitStats': {'rms': rms, 'maxRes': max_res, 'nPoints': int(len(pressures))}})
`;

  try {
    const resultJson = await pyodide.runPythonAsync(pythonCode);
    return JSON.parse(resultJson);
  } catch (error) {
    console.error('P-V fit failed:', error);
    return nullResult(3);
  }
}

/**
 * Fit the P-V curve, and the E-V curve too if energies are provided (a
 * P/V-only dataset skips the E-V fit and returns evResult: null).
 * Returns { pvResult: {params:[V0,K0,K0Prime], errors, fitStats}, evResult:
 * {params:[E0,V0,K0,K0Prime], errors, fitStats} | null } — E0 is the total
 * energy (not an offset from minEnergy).
 * @param {(text: string) => void} [onStatus]
 */
export async function fitEOS(volumes, energies, pressures, onStatus = () => {}) {
  const pyodide = await ensurePyodideReady(onStatus);
  onStatus('Fitting with SciPy…');
  const hasEnergy = Array.isArray(energies) && energies.length > 0;

  if (!hasEnergy) {
    const pvResult = await runPVFit(pyodide, volumes, pressures);
    return { pvResult, evResult: null };
  }

  pyodide.globals.set('js_volumes', volumes);
  pyodide.globals.set('js_energies', energies);
  pyodide.globals.set('js_pressures', pressures);

  const pythonCode = `${BM_PYTHON_FUNCTIONS}
import json

volumes = np.array(js_volumes)
energies = np.array(js_energies)
pressures = np.array(js_pressures)

min_energy_idx = np.argmin(energies)
evV0_initial = float(volumes[min_energy_idx])
min_pressure_idx = np.argmin(np.abs(pressures))
pvV0_initial = float(volumes[min_pressure_idx])
v0_offset = 1e-10 * max(pvV0_initial, evV0_initial)
pvV0_initial += v0_offset
evV0_initial -= v0_offset

_, pvK0_estimate = estimate_k0(volumes, pressures)

try:
    pv_popt, pv_pcov = curve_fit(
        birch_murnaghan_pressure, volumes, pressures,
        p0=[pvV0_initial, pvK0_estimate, 4.0], maxfev=5000
    )
    pv_errors = [float(x) for x in np.sqrt(np.diag(pv_pcov))] if pv_pcov is not None else [None, None, None]
    pv_res = pressures - birch_murnaghan_pressure(volumes, *pv_popt)
    pv_rms = float(np.sqrt(np.mean(pv_res ** 2)))
    pv_max_res = float(np.max(np.abs(pv_res)))
except Exception:
    pv_popt = [pvV0_initial, pvK0_estimate, 4.0]
    pv_errors = [None, None, None]
    pv_rms = 0.0
    pv_max_res = 0.0

min_energy = float(np.min(energies))
try:
    ev_popt, ev_pcov = curve_fit(
        lambda V, E0, V0, K0, K0Prime: birch_murnaghan_energy(V, E0, V0, K0, K0Prime) + min_energy,
        volumes, energies,
        p0=[0.0, float(pv_popt[0]), float(pv_popt[1]), float(pv_popt[2])], maxfev=5000
    )
    ev_errors = [float(x) for x in np.sqrt(np.diag(ev_pcov))] if ev_pcov is not None else [None, None, None, None]
    ev_res = energies - (birch_murnaghan_energy(volumes, *ev_popt) + min_energy)
    ev_rms = float(np.sqrt(np.mean(ev_res ** 2)))
    ev_max_res = float(np.max(np.abs(ev_res)))
except Exception:
    ev_popt = [0.0, float(pv_popt[0]), float(pv_popt[1]), float(pv_popt[2])]
    ev_errors = [None, None, None, None]
    ev_rms = 0.0
    ev_max_res = 0.0

result_json = json.dumps([
    {'params': [float(x) for x in pv_popt], 'errors': pv_errors,
     'fitStats': {'rms': pv_rms, 'maxRes': pv_max_res, 'nPoints': int(len(pressures))}},
    {'params': [float(x) for x in ev_popt], 'errors': ev_errors,
     'fitStats': {'rms': ev_rms, 'maxRes': ev_max_res, 'nPoints': int(len(energies))}},
])
result_json
`;

  try {
    const resultJson = await pyodide.runPythonAsync(pythonCode);
    const [pvResult, evResult] = JSON.parse(resultJson);
    const minEnergy = Math.min(...energies);
    evResult.params[0] = (evResult.params[0] || 0) + minEnergy;
    return { pvResult, evResult };
  } catch (error) {
    console.error('EOS SciPy fitting failed:', error);
    return { pvResult: nullResult(3), evResult: nullResult(4) };
  }
}

/**
 * Fit just the P-V curve (used for the reference-dataset overlay).
 * @param {(text: string) => void} [onStatus]
 */
export async function fitReferencePV(volumes, pressures, onStatus = () => {}) {
  const pyodide = await ensurePyodideReady(onStatus);
  return runPVFit(pyodide, volumes, pressures);
}
