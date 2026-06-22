// =============================================
// CONSTANTS AND UNIT CONVERSION
// =============================================
window.unitSettings = {
    energy: 'eV',
    pressure: 'GPa',
    volume: 'Å³'
};

// Conversion factors: FROM user units TO SI units (Å³, GPa, eV)
window.CONVERSION_FACTORS = {
    volume: {
        'Å³': 1,
        'Bohr³': 0.1481847124  // 1 Bohr³ = 0.1481847124 Å³
    },
    pressure: {
        'GPa': 1,
        'kBar': 0.1  // 1 kBar = 0.1 GPa
    },
    energy: {
        'eV': 1,
        'Ry': 13.605693,  // 1 Ry = 13.605693 eV
        'Hartree': 27.211386246  // 1 Hartree = 27.211386246 eV
    }
};

// Legacy UNITS object for backward compatibility (FIXED for SI)
window.UNITS = {
    BOHR3_TO_ANGSTROM3: 0.1481847124,
    RY_TO_EV: 13.605693,
    HARTREE_TO_EV: 27.211386246,
    KBAR_TO_GPA: 0.1,
    A3_GPA_TO_EV: 0.006241509  // FIXED: Å³·GPa → eV
};

window.COLORS = {
    DATA: "#d4950f",
    PV_FIT: "#0f3ad4", //"#bc5090",
    EV_FIT: "#04c9b9"
};

// =============================================
// AUTO-DETECT UNITS FROM DATA
// =============================================
window.detectDataUnits = function(volumes, energies, pressures) {
    // Typical ranges for different unit systems
    const unitRanges = {
        volume: {
            'Å³': { min: 10, max: 5000 },
            'Bohr³': { min: 10, max: 5000 }
        },
        energy: {
            'eV': { min: -1000, max: 0 },
            'Ry': { min: -10, max: 0 },
            'Hartree': { min: -10, max: 0 }
        },
        pressure: {
            'GPa': { min: -10, max: 500 },
            'kBar': { min: -100, max: 5000 }
        }
    };

    // Detect volume units (use column header if available)
    const volMin = Math.min(...volumes);
    const volMax = Math.max(...volumes);
    let volUnit = 'Å³';
    
    // If volumes are in typical Bohr³ range AND energies suggest atomic units, use Bohr³
    const eMin = Math.min(...energies);
    const eMax = Math.max(...energies);
    if (eMin >= -10 && eMax <= 0 && volMin >= 10 && volMax <= 5000) {
        volUnit = 'Bohr³';
    }

    // Detect energy units
    let energyUnit = 'eV';
    if (eMin >= -10 && eMax <= 0) {
        energyUnit = 'Ry';  // or Hartree, we'll treat Ry as Hartree equivalent
    }

    // Detect pressure units
    const pMin = Math.min(...pressures);
    const pMax = Math.max(...pressures);
    let pressureUnit = 'GPa';
    if (pMin >= -100 && pMax <= 5000) {
        pressureUnit = 'kBar';
    }

    return { volume: volUnit, energy: energyUnit, pressure: pressureUnit };
};

// =============================================
// UPDATE UNITS BASED ON USER SELECTION
// =============================================
window.updateUnits = function() {
    window.unitSettings.energy = document.getElementById('energy-units')?.value || 'eV';
    window.unitSettings.pressure = document.getElementById('pressure-units')?.value || 'GPa';
    window.unitSettings.volume = document.getElementById('volume-units')?.value || 'Å³';

    // Update legacy UNITS (but A3_GPA_TO_EV stays FIXED for SI)
    window.UNITS.BOHR3_TO_ANGSTROM3 = window.CONVERSION_FACTORS.volume[window.unitSettings.volume];
    window.UNITS.RY_TO_EV = window.CONVERSION_FACTORS.energy[window.unitSettings.energy] || 1;
    window.UNITS.KBAR_TO_GPA = window.CONVERSION_FACTORS.pressure[window.unitSettings.pressure];
    // A3_GPA_TO_EV remains FIXED at 0.006241509 (SI units only)
    window.UNITS.A3_GPA_TO_EV = 0.006241509;
};

// =============================================
// BIRCH-MURNAGHAN FUNCTIONS (Numerically Stable)
// =============================================
window.birchMurnaghanEnergy = function(V, E0, V0, K0, K0Prime) {
    const eta = Math.pow(V0 / V, 2/3);
    const eta_minus_1 = eta - 1;
    const term1 = Math.pow(eta_minus_1, 3) * K0Prime;
    const term2 = Math.pow(eta_minus_1, 2) * (6 - 4 * eta);
    return E0 + (9 * V0 * K0 / 16) * window.UNITS.A3_GPA_TO_EV * (term1 + term2);
};

window.birchMurnaghanPressure = function(V, V0, K0, K0Prime) {
    const ratio = V0 / V;
    const r53 = Math.pow(ratio, 5/3);
    const r73 = Math.pow(ratio, 7/3);
    const r23 = Math.pow(ratio, 2/3);
    const term3 = 1 + (3/4) * (K0Prime - 4) * (r23 - 1);
    return (3 * K0 / 2) * (r73 - r53) * term3;
};

// =============================================
// PENALTY FOR K0' (3-7 range)
// =============================================
window.penaltyK0Prime = function(params) {
    const K0Prime = params[3];
    return 0.1 * (Math.max(0, K0Prime - 7) ** 2 + Math.max(0, 3 - K0Prime) ** 2);
};

// =============================================
// COLUMN DETECTION
// =============================================
window.detectColumns = function(lines) {
    const firstLine = lines[0].trim();
    const hasHeaders = /^[^0-9\-+.\s]+$/.test(firstLine.split(/\s+/)[0]);
    let headers = [];
    let dataStartIndex = 0;

    if (hasHeaders) {
        headers = firstLine.split(/\s+/).map(h => h.trim().toLowerCase());
        dataStartIndex = 1;
    } else {
        const nCols = lines[0].trim().split(/\s+/).length;
        headers = Array(nCols).fill().map((_, i) => `col${i+1}`);
    }

    const allData = [];
    for (let i = dataStartIndex; i < lines.length; i++) {
        const values = lines[i].trim().split(/\s+/).map(Number);
        if (values.length === headers.length) allData.push(values);
    }

    let pIndex = -1, eIndex = -1, vIndex = -1;
    if (hasHeaders) {
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i];
            if (header.includes('p') || header.includes('pressure')) pIndex = i;
            else if (header.includes('e') || header.includes('energy')) eIndex = i;
            else if (header.includes('v') || header.includes('volume')) vIndex = i;
            // Check for atomic units in headers
            else if (header.includes('bohr') || header.includes('a.u.')) {
                if (vIndex === -1) vIndex = i;
            }
        }
    }

    if (pIndex === -1 || eIndex === -1 || vIndex === -1) {
        const stats = Array(headers.length).fill().map(() => ({ min: Infinity, max: -Infinity }));
        for (const row of allData) {
            for (let i = 0; i < row.length; i++) {
                if (!isNaN(row[i])) {
                    stats[i].min = Math.min(stats[i].min, row[i]);
                    stats[i].max = Math.max(stats[i].max, row[i]);
                }
            }
        }
        for (let i = 0; i < stats.length; i++) {
            if (pIndex === -1 && stats[i].min >= -10 && stats[i].max <= 2000) pIndex = i;
            else if (eIndex === -1 && stats[i].max <= 0 && stats[i].min >= -1000) eIndex = i;
            else if (vIndex === -1 && stats[i].min > 0 && stats[i].max < 10000) vIndex = i;
        }
    }

    if (pIndex === -1 || eIndex === -1 || vIndex === -1) {
        throw new Error("Could not detect P, E, V columns");
    }

    return {
        pressures: allData.map(row => row[pIndex]),
        energies: allData.map(row => row[eIndex]),
        volumes: allData.map(row => row[vIndex]),
        columnInfo: { p: pIndex, e: eIndex, v: vIndex, headers, hasHeaders: !!hasHeaders }
    };
};

// =============================================
// FITTING UTILITIES
// =============================================
window.estimateK0FromPV = function(volumes, pressures) {
    let minPressure = Infinity, v0Index = 0;
    for (let i = 0; i < pressures.length; i++) {
        if (Math.abs(pressures[i]) < Math.abs(minPressure)) {
            minPressure = pressures[i];
            v0Index = i;
        }
    }
    const v0 = volumes[v0Index];
    let sumNum = 0, sumDen = 0;
    for (let i = 0; i < volumes.length; i++) {
        const dV = volumes[i] - v0;
        if (Math.abs(dV) / v0 < 0.05) {
            sumNum += pressures[i] * dV;
            sumDen += dV * dV;
        }
    }
    return { v0, k0: sumDen === 0 ? 300 : -v0 * (sumNum / sumDen) };
};

// =============================================
// NUMERICAL JACOBIAN (SciPy-Like)
// =============================================
window.numericalJacobian = function(x, y, func, params, eps = 1e-6) {
    const n = params.length;
    const m = x.length;
    const J = Array(m).fill().map(() => Array(n).fill(0));
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            const h = Math.max(eps * Math.max(Math.abs(params[j]), 1), 1e-6);
            const p1 = [...params];
            const p2 = [...params];
            p1[j] += h;
            p2[j] -= h;
            const f1 = func(x[i], ...p1);
            const f2 = func(x[i], ...p2);
            J[i][j] = (f1 - f2) / (2 * h);
        }
    }
    return J;
};

// =============================================
// LINEAR ALGEBRA UTILITIES
// =============================================
window.solveLinearSystem = function(A, b) {
    const n = A.length;
    const x = Array(n).fill(0);
    const Amat = A.map(row => [...row]);
    for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(Amat[k][i]) > Math.abs(Amat[maxRow][i])) maxRow = k;
        }
        [Amat[i], Amat[maxRow]] = [Amat[maxRow], Amat[i]];
        [b[i], b[maxRow]] = [b[maxRow], b[i]];
        if (Math.abs(Amat[i][i]) < 1e-12) return null;
        for (let k = i + 1; k < n; k++) {
            const factor = Amat[k][i] / Amat[i][i];
            for (let j = i; j < n; j++) {
                Amat[k][j] -= factor * Amat[i][j];
            }
            b[k] -= factor * b[i];
        }
    }
    for (let i = n - 1; i >= 0; i--) {
        if (Math.abs(Amat[i][i]) < 1e-12) return null;
        x[i] = b[i];
        for (let j = i + 1; j < n; j++) {
            x[i] -= Amat[i][j] * x[j];
        }
        x[i] /= Amat[i][i];
    }
    return x;
};

window.invertMatrix = function(matrix) {
    const n = matrix.length;
    const inverse = Array(n).fill().map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) inverse[i][i] = 1;
    for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(matrix[k][i]) > Math.abs(matrix[maxRow][i])) maxRow = k;
        }
        [matrix[i], matrix[maxRow]] = [matrix[maxRow], matrix[i]];
        [inverse[i], inverse[maxRow]] = [inverse[maxRow], inverse[i]];
        if (Math.abs(matrix[i][i]) < 1e-12) return null;
        const pivot = matrix[i][i];
        for (let j = 0; j < n; j++) {
            matrix[i][j] /= pivot;
            inverse[i][j] /= pivot;
        }
        for (let k = 0; k < n; k++) {
            if (k !== i) {
                const factor = matrix[k][i];
                for (let j = 0; j < n; j++) {
                    matrix[k][j] -= factor * matrix[i][j];
                    inverse[k][j] -= factor * inverse[i][j];
                }
            }
        }
    }
    return inverse;
};

window.calculateFitStats = function(x, y, func, params) {
    const residuals = x.map((xi, i) => y[i] - func(xi, ...params));
    const n = x.length;
    const nParams = params.length;
    const rms = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / n);
    const maxRes = Math.max(...residuals.map(r => Math.abs(r)));
    const redChi2 = residuals.reduce((sum, r) => sum + r * r, 0) / (n - nParams);
    return { rms, maxRes, nPoints: n, redChi2, nParams };
};

window.calculateParameterErrors = function(x, y, func, params, fitStats) {
    const n = x.length;
    const nParams = params.length;
    const J = window.numericalJacobian(x, y, func, params);
    const JtJ = Array(nParams).fill().map(() => Array(nParams).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < nParams; j++) {
            for (let k = 0; k < nParams; k++) {
                JtJ[j][k] += J[i][j] * J[i][k];
            }
        }
    }
    const covMatrix = window.invertMatrix(JtJ);
    if (!covMatrix) return null;
    for (let i = 0; i < nParams; i++) {
        for (let j = 0; j < nParams; j++) {
            covMatrix[i][j] *= fitStats.redChi2;
        }
    }
    return Array(nParams).fill().map((_, i) => Math.sqrt(covMatrix[i][i]));
};

// =============================================
// LEVENBERG-MARQUARDT (SciPy-Like + Penalty)
// =============================================
window.levenbergMarquardt = function(
    x,
    y,
    func,
    initialParams,
    maxIterations = 5000,
    penaltyFunc = null
) {
    let params = [...initialParams];
    let lambda = 1e-3;
    const nData = x.length;
    const nParams = params.length;
    let prevError = Infinity;

    for (let iter = 0; iter < maxIterations; iter++) {
        const residuals = x.map((xi, i) => y[i] - func(xi, ...params));
        let error = residuals.reduce((s, r) => s + r * r, 0);
        if (penaltyFunc) error += penaltyFunc(params);
        if (Math.abs(prevError - error) < 1e-14 * (1 + error)) break;
        prevError = error;

        const J = window.numericalJacobian(x, y, func, params);
        const JtJ = Array(nParams).fill().map(() => Array(nParams).fill(0));
        const Jtr = Array(nParams).fill(0);
        for (let i = 0; i < nData; i++) {
            for (let j = 0; j < nParams; j++) {
                Jtr[j] += J[i][j] * residuals[i];
                for (let k = 0; k < nParams; k++) {
                    JtJ[j][k] += J[i][j] * J[i][k];
                }
            }
        }

        const A = JtJ.map(row => [...row]);
        for (let i = 0; i < nParams; i++) {
            A[i][i] += lambda * A[i][i];
        }

        const delta = window.solveLinearSystem(A, [...Jtr]);
        if (!delta) {
            lambda *= 10;
            continue;
        }

        const trialParams = params.map((p, i) => p + delta[i]);
        let trialError = x.reduce((sum, xi, i) => {
            const r = y[i] - func(xi, ...trialParams);
            return sum + r * r;
        }, 0);
        if (penaltyFunc) trialError += penaltyFunc(trialParams);

        if (trialError < error) {
            params = trialParams;
            lambda = Math.max(1e-12, lambda * 0.3);
        } else {
            lambda *= 10;
        }
    }

    const fitStats = window.calculateFitStats(x, y, func, params);
    const errors = window.calculateParameterErrors(x, y, func, params, fitStats);
    return { params, errors, fitStats };
};

window.formatParam = function(value, error) {
    if (error !== undefined) {
        return `${value.toFixed(10)} ± ${error.toFixed(10)}`;
    }
    return value.toFixed(10);
};
