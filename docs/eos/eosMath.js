// Birch-Murnaghan equation-of-state math: unit conversion, curve equations,
// and the column/format sniffing shared by the EOS panel and its fit/plot
// helpers. No DOM access and no fitting here — see eosFit.js for that.

export const CONVERSION_FACTORS = {
  volume: { 'Å³': 1, 'Bohr³': 0.1481847124 },
  pressure: { 'GPa': 1, 'kBar': 0.1 },
  energy: { 'eV': 1, 'Ry': 13.605693, 'Hartree': 27.211386246 },
};

// Birch-Murnaghan pressure-volume constant (Å³·GPa -> eV).
export const A3_GPA_TO_EV = 0.006241509;

export function birchMurnaghanEnergy(V, E0, V0, K0, K0Prime) {
  const eta = Math.pow(V0 / V, 2 / 3);
  const etaMinus1 = eta - 1;
  const term1 = Math.pow(etaMinus1, 3) * K0Prime;
  const term2 = Math.pow(etaMinus1, 2) * (6 - 4 * eta);
  return E0 + (9 * V0 * K0 / 16) * A3_GPA_TO_EV * (term1 + term2);
}

export function birchMurnaghanPressure(V, V0, K0, K0Prime) {
  const ratio = V0 / V;
  const r53 = Math.pow(ratio, 5 / 3);
  const r73 = Math.pow(ratio, 7 / 3);
  const r23 = Math.pow(ratio, 2 / 3);
  const term3 = 1 + (3 / 4) * (K0Prime - 4) * (r23 - 1);
  return (3 * K0 / 2) * (r73 - r53) * term3;
}

/** Detect which whitespace-separated column holds P / E / V, by header name
 *  first, then by loose header substring, then by data statistics. Energy is
 *  optional — a P/V-only file (no energy column found) is valid; P and V are
 *  required. */
export function detectColumns(lines) {
  const firstLine = lines[0].trim();
  const hasHeaders = /^[^0-9\-+.\s]+$/.test(firstLine.split(/\s+/)[0]);
  let headers = [];
  let dataStartIndex = 0;

  if (hasHeaders) {
    headers = firstLine.split(/\s+/).map((h) => h.trim().toLowerCase());
    dataStartIndex = 1;
  } else {
    const nCols = lines[0].trim().split(/\s+/).length;
    headers = Array(nCols).fill().map((_, i) => `col${i + 1}`);
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
      if (/^(p|pressure|press)$/i.test(header) && pIndex === -1) pIndex = i;
      else if (/^(e|energy|energ)$/i.test(header) && eIndex === -1) eIndex = i;
      else if (/^(v|volume|vol)$/i.test(header) && vIndex === -1) vIndex = i;
      else if (/^(bohr|a\.u\.|au)$/i.test(header) && vIndex === -1) vIndex = i;
    }
  }

  if (hasHeaders && (pIndex === -1 || vIndex === -1)) {
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (pIndex === -1 && (/p/.test(header) || /pressure/.test(header) || /press/.test(header))) pIndex = i;
      else if (eIndex === -1 && (/e/.test(header) || /energy/.test(header) || /energ/.test(header))) eIndex = i;
      else if (vIndex === -1 && (/v/.test(header) || /volume/.test(header) || /vol/.test(header))) vIndex = i;
      else if (vIndex === -1 && (/bohr/.test(header) || /a\.u\./.test(header) || /au/.test(header))) vIndex = i;
    }
  }

  if (pIndex === -1 || vIndex === -1) {
    const stats = Array(headers.length).fill().map(() => (
      { min: Infinity, max: -Infinity, allPositive: true }
    ));
    for (const row of allData) {
      for (let i = 0; i < row.length; i++) {
        if (!isNaN(row[i])) {
          stats[i].min = Math.min(stats[i].min, row[i]);
          stats[i].max = Math.max(stats[i].max, row[i]);
          if (row[i] < 0) stats[i].allPositive = false;
        }
      }
    }
    for (let i = 0; i < stats.length; i++) {
      if (pIndex === -1 && stats[i].min >= -200 && stats[i].max <= 2000 && !stats[i].allPositive) pIndex = i;
      else if (eIndex === -1 && stats[i].max <= 0 && stats[i].min >= -10000) eIndex = i;
      else if (vIndex === -1 && stats[i].min > 0 && stats[i].max < 100000) vIndex = i;
    }
  }

  if (pIndex === -1 || vIndex === -1) {
    throw new Error('Could not detect P and V columns. Please ensure your file has columns for Pressure and Volume (Energy is optional).');
  }

  const hasEnergy = eIndex !== -1;
  return {
    pressures: allData.map((row) => row[pIndex]),
    energies: hasEnergy ? allData.map((row) => row[eIndex]) : null,
    volumes: allData.map((row) => row[vIndex]),
    columnInfo: { p: pIndex, e: hasEnergy ? eIndex : -1, v: vIndex, headers, hasHeaders: !!hasHeaders, hasEnergy },
  };
}

// Header aliases for the reference file, matched against the leading run of
// ASCII letters (e.g. "V(Å³)" -> "v", "Press_GPa" -> "press").
const headerWord = (tok) => tok.toLowerCase().match(/^[a-z]+/)?.[0] || '';
const isPHeader = (c) => c === 'p' || c.startsWith('press');
const isVHeader = (c) => c === 'v' || c.startsWith('vol');
const isErrHeader = (c) => c === 'e' || c.startsWith('err') || c.startsWith('sigma') || c.startsWith('unc');

/** Parse a reference comparison file: pressure, volume, error columns, in any
 *  order — detected directly from the first line's tokens (P/p, V/v,
 *  Error/error, tolerant of units/decorations), falling back to the
 *  conventional P/V/error order for whichever isn't recognized. */
export function parseReferenceData(lines) {
  const firstTokens = lines[0].trim().split(/\s+/);
  let pIndex = -1, vIndex = -1, errIndex = -1;
  firstTokens.forEach((tok, i) => {
    const c = headerWord(tok);
    if (pIndex === -1 && isPHeader(c)) pIndex = i;
    else if (vIndex === -1 && isVHeader(c)) vIndex = i;
    else if (errIndex === -1 && isErrHeader(c)) errIndex = i;
  });
  // A header row is recognized once we've matched at least P and V from it;
  // otherwise the first line is data, in the conventional P/V/error order.
  const hasHeaders = pIndex !== -1 && vIndex !== -1;
  const dataStartIndex = hasHeaders ? 1 : 0;
  if (!hasHeaders) {
    pIndex = 0; vIndex = 1; errIndex = 2;
  } else {
    if (pIndex === -1) pIndex = 0;
    if (vIndex === -1) vIndex = 1;
    if (errIndex === -1) errIndex = 2;
  }

  const pressures = [];
  const volumes = [];
  const errors = [];
  for (let i = dataStartIndex; i < lines.length; i++) {
    const values = lines[i].trim().split(/\s+/).map(Number);
    if (values.length >= 3) {
      pressures.push(values[pIndex]);
      volumes.push(values[vIndex]);
      errors.push(values[errIndex]);
    }
  }

  return { pressures, volumes, errors, hasHeaders };
}

export function formatParam(value, error) {
  if (value === undefined || value === null) return 'N/A';
  if (error !== undefined && error !== null && Number.isFinite(error)) {
    return `${value.toFixed(6)} ± ${error.toFixed(6)}`;
  }
  return value.toFixed(6);
}
