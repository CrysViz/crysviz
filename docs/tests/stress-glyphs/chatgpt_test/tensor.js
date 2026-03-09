import { Matrix, EigenvalueDecomposition } from
  'https://cdn.jsdelivr.net/npm/ml-matrix@6.10.0/+esm';


export function eigensystemStress(T) {
  const M = new Matrix(T);
  const evd = new EigenvalueDecomposition(M);

  let evals = evd.realEigenvalues;
  let evecs = evd.eigenvectorMatrix.to2DArray();

  // sort by descending eigenvalue
  const idx = [0,1,2].sort((a,b)=>evals[b]-evals[a]);
  evals = idx.map(i=>evals[i]);
  evecs = idx.map(i=>evecs.map(r=>r[i]));

  return { evals, evecs };
}

/**
 * Map principal stresses to superquadric shape
 * Size is intentionally fixed for visual comparability
 */
export function stressToSuperquadric1(evals) {
  const l1 = Math.abs(evals[0]) + 1e-6;
  const l2 = Math.abs(evals[1]) + 1e-6;
  const l3 = Math.abs(evals[2]) + 1e-6;

  const k = 3.0;   // shape exaggeration factor
  const alpha = 1 + k * (1 - l2 / l1);
  const beta  = 1 + k * (1 - l3 / l1);

  return { alpha, beta, scale: 1.0 };
}

export function stressToSuperquadric(evals) {
  const [l1,l2,l3] = evals;
  const L = (l1 - l2)/l1;  // linearity
  const P = (l2 - l3)/l1;  // planarity
  const k = 3.0;
  return { alpha: 1 + k*L, beta: 1 + k*P, scale: 1.0 };
}

/**
 * 3x3 orientation matrix from eigenvectors
 */
export function orientationMatrix(evecs) {
  return [
    evecs[0][0], evecs[1][0], evecs[2][0],
    evecs[0][1], evecs[1][1], evecs[2][1],
    evecs[0][2], evecs[1][2], evecs[2][2]
  ];
}
