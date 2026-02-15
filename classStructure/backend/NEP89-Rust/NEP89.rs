use ndarray::{Array1, Array2, ArrayView1};
use wasm_bindgen::prelude::*;
use autodiff::*;
use std::collections::HashMap;
use lazy_static::lazy_static;

// Constants from the NEP89 potential
const C3B: [f64; 60] = [
    0.238732414637843, 0.119366207318922, 0.119366207318922, 0.099471839432435, 0.596831036594608,
    0.596831036594608, 0.149207759148652, 0.149207759148652, 0.139260575205408, 0.104445431404056,
    0.104445431404056, 1.044454314040563, 1.044454314040563, 0.174075719006761, 0.174075719006761,
    0.011190581936149, 0.223811638722978, 0.223811638722978, 0.111905819361489, 0.111905819361489,
    1.566681471060845, 1.566681471060845, 0.195835183882606, 0.195835183882606, 0.013677377921960,
    0.102580334414698, 0.102580334414698, 2.872249363611549, 2.872249363611549, 0.119677056817148,
    0.119677056817148, 2.154187022708661, 2.154187022708661, 0.215418702270866, 0.215418702270866,
    0.004041043476943, 0.169723826031592, 0.169723826031592, 0.106077391269745, 0.106077391269745,
    0.424309565078979, 0.424309565078979, 0.127292869523694, 0.127292869523694, 2.800443129521260,
    2.800443129521260, 0.233370260793438, 0.233370260793438, 0.004662742473395, 0.004079899664221,
    0.004079899664221, 0.024479397985326, 0.024479397985326, 0.012239698992663, 0.012239698992663,
    0.538546755677165, 0.538546755677165, 0.134636688919291, 0.134636688919291, 3.500553911901575,
    3.500553911901575, 0.250039565135827, 0.250039565135827, 0.000082569397966, 0.005944996653579,
    0.005944996653579, 0.104037441437634, 0.104037441437634, 0.762941237209318, 0.762941237209318,
    0.114441185581398, 0.114441185581398, 5.950941650232678, 5.950941650232678, 0.141689086910302,
    0.141689086910302, 4.250672607309055, 4.250672607309055, 0.265667037956816, 0.265667037956816,
];

const C4B: [f64; 5] = [-0.007499480826664, -0.134990654879954, 0.067495327439977, 0.404971964639861, -0.809943929279723];
const C5B: [f64; 3] = [0.026596810706114, 0.053193621412227, 0.026596810706114];

lazy_static! {
    static ref Z_COEFFICIENTS: HashMap<usize, Array2<f64>> = {
        let mut m = HashMap::new();
        m.insert(1, arr2(&[[0.0, 1.0], [1.0, 0.0]]));
        m.insert(2, arr2(&[[-1.0, 0.0, 3.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]));
        m.insert(3, arr2(&[[0.0, -3.0, 0.0, 5.0], [-1.0, 0.0, 5.0, 0.0], [0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]]));
        m.insert(4, arr2(&[[3.0, 0.0, -30.0, 0.0, 35.0], [0.0, -3.0, 0.0, 7.0, 0.0], [-1.0, 0.0, 7.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0]]));
        m.insert(5, arr2(&[[0.0, 15.0, 0.0, -70.0, 0.0, 63.0], [1.0, 0.0, -14.0, 0.0, 21.0, 0.0], [0.0, -1.0, 0.0, 3.0, 0.0, 0.0], [-1.0, 0.0, 9.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]]));
        m.insert(6, arr2(&[[-5.0, 0.0, 105.0, 0.0, -315.0, 0.0, 231.0], [0.0, 5.0, 0.0, -30.0, 0.0, 33.0, 0.0], [1.0, 0.0, -18.0, 0.0, 33.0, 0.0, 0.0], [0.0, -3.0, 0.0, 11.0, 0.0, 0.0, 0.0], [-1.0, 0.0, 11.0, 0.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]));
        m.insert(7, arr2(&[[0.0, -35.0, 0.0, 315.0, 0.0, -693.0, 0.0, 429.0], [-5.0, 0.0, 135.0, 0.0, -495.0, 0.0, 429.0, 0.0], [0.0, 15.0, 0.0, -110.0, 0.0, 143.0, 0.0, 0.0], [3.0, 0.0, -66.0, 0.0, 143.0, 0.0, 0.0, 0.0], [0.0, -3.0, 0.0, 13.0, 0.0, 0.0, 0.0, 0.0], [-1.0, 0.0, 13.0, 0.0, 0.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]));
        m.insert(8, arr2(&[[35.0, 0.0, -1260.0, 0.0, 6930.0, 0.0, -12012.0, 0.0, 6435.0], [0.0, -35.0, 0.0, 385.0, 0.0, -1001.0, 0.0, 715.0, 0.0], [-1.0, 0.0, 33.0, 0.0, -143.0, 0.0, 143.0, 0.0, 0.0], [0.0, 3.0, 0.0, -26.0, 0.0, 39.0, 0.0, 0.0, 0.0], [1.0, 0.0, -26.0, 0.0, 65.0, 0.0, 0.0, 0.0, 0.0], [0.0, -1.0, 0.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0], [-1.0, 0.0, 15.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]));
        m
    };
}

fn arr2(data: &[[f64; 3]]) -> Array2<f64> {
    Array2::from_shape_vec((data.len(), 3), data.concat().to_vec()).unwrap()
}

// Radial basis function
fn radial_basis(r: f64, rc: f64, n: usize) -> f64 {
    let x = r / rc;
    if x >= 1.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    for i in 0..n {
        sum += C3B[i] * x.powi(i as i32);
    }
    sum
}

// Legendre polynomial
fn legendre_polynomial(l: usize, x: f64) -> f64 {
    if l == 0 {
        return 1.0;
    }
    if l == 1 {
        return x;
    }
    let mut p0 = 1.0;
    let mut p1 = x;
    let mut p2 = 0.0;
    for i in 2..=l {
        p2 = ((2 * i - 1) as f64 * x * p1 - (i - 1) as f64 * p0) / i as f64;
        p0 = p1;
        p1 = p2;
    }
    p2
}

// Descriptor generation
pub fn generate_descriptors(
    positions: &Array2<f64>,
    atom_types: &Array1<usize>,
    cutoff: f64,
    n_max: usize,
    l_max: usize,
) -> Vec<Array1<f64>> {
    let mut descriptors = Vec::new();
    for i in 0..positions.nrows() {
        let mut descriptor = Array1::zeros(n_max * (l_max + 1));
        for j in 0..positions.nrows() {
            if i == j {
                continue;
            }
            let dx = positions[[i, 0]] - positions[[j, 0]];
            let dy = positions[[i, 1]] - positions[[j, 1]];
            let dz = positions[[i, 2]] - positions[[j, 2]];
            let r = (dx * dx + dy * dy + dz * dz).sqrt();
            if r < cutoff {
                let x = r / cutoff;
                let cos_theta = dz / r;
                for n in 0..n_max {
                    let rb = radial_basis(r, cutoff, n);
                    for l in 0..=l_max {
                        let pl = legendre_polynomial(l, cos_theta);
                        let idx = n * (l_max + 1) + l;
                        descriptor[idx] += rb * pl;
                    }
                }
            }
        }
        descriptors.push(descriptor);
    }
    descriptors
}

// Neural network layer
struct DenseLayer {
    weights: Array2<f64>,
    biases: Array1<f64>,
}

impl DenseLayer {
    fn new(weights: Array2<f64>, biases: Array1<f64>) -> Self {
        DenseLayer { weights, biases }
    }

    fn forward(&self, input: ArrayView1<f64>) -> Array1<f64> {
        self.weights.dot(&input) + &self.biases
    }
}

// NEP89 model
pub struct NEP89 {
    layers: Vec<DenseLayer>,
}

impl NEP89 {
    pub fn new(weights: Vec<f64>) -> Self {
        // Initialize layers based on weights
        // This is a placeholder; adapt to the actual weights format
        let layer1_weights = Array2::from_shape_vec((10, 10), weights[0..100].to_vec()).unwrap();
        let layer1_biases = Array1::from_vec(weights[100..110].to_vec());
        let layer1 = DenseLayer::new(layer1_weights, layer1_biases);

        NEP89 {
            layers: vec![layer1],
        }
    }

    pub fn predict_energy(&self, descriptors: ArrayView1<f64>) -> f64 {
        let mut output = descriptors.to_owned();
        for layer in &self.layers {
            output = layer.forward(output.view());
        }
        output[0] // Assuming single output for energy
    }
}

// Force calculations with autodiff
fn compute_forces(
    positions: &Array2<f64>,
    atom_types: &Array1<usize>,
    model: &NEP89,
    cutoff: f64,
    n_max: usize,
    l_max: usize,
) -> Array2<f64> {
    let mut forces = Array2::zeros((positions.nrows(), 3));
    for i in 0..positions.nrows() {
        let mut pos = positions.to_owned();
        let e = |x: f64| {
            pos[[i, 0]] = x;
            let descriptors = generate_descriptors(&pos, atom_types, cutoff, n_max, l_max);
            model.predict_energy(descriptors[0].view())
        };
        let de_dx = autodiff::forward::gradient(e, positions[[i, 0]]);
        forces[[i, 0]] = -de_dx;

        // Repeat for y and z
        let e = |y: f64| {
            pos[[i, 1]] = y;
            let descriptors = generate_descriptors(&pos, atom_types, cutoff, n_max, l_max);
            model.predict_energy(descriptors[0].view())
        };
        let de_dy = autodiff::forward::gradient(e, positions[[i, 1]]);
        forces[[i, 1]] = -de_dy;

        let e = |z: f64| {
            pos[[i, 2]] = z;
            let descriptors = generate_descriptors(&pos, atom_types, cutoff, n_max, l_max);
            model.predict_energy(descriptors[0].view())
        };
        let de_dz = autodiff::forward::gradient(e, positions[[i, 2]]);
        forces[[i, 2]] = -de_dz;
    }
    forces
}

// WASM integration
#[wasm_bindgen]
pub struct NEP89Wasm {
    model: NEP89,
    cutoff: f64,
    n_max: usize,
    l_max: usize,
}

#[wasm_bindgen]
impl NEP89Wasm {
    #[wasm_bindgen(constructor)]
    pub fn new(weights: Vec<f64>, cutoff: f64, n_max: usize, l_max: usize) -> Self {
        NEP89Wasm {
            model: NEP89::new(weights),
            cutoff,
            n_max,
            l_max,
        }
    }

    #[wasm_bindgen]
    pub fn predict_energy(&self, descriptors: Vec<f64>) -> f64 {
        let descriptors = ArrayView1::from(&descriptors);
        self.model.predict_energy(descriptors)
    }

    #[wasm_bindgen]
    pub fn compute_forces(
        &self,
        positions: Vec<f64>,
        atom_types: Vec<usize>,
    ) -> Vec<f64> {
        let positions = Array2::from_shape_vec((atom_types.len(), 3), positions).unwrap();
        let atom_types = Array1::from_vec(atom_types);
        let forces = compute_forces(&positions, &atom_types, &self.model, self.cutoff, self.n_max, self.l_max);
        forces.into_raw_vec()
    }
}

