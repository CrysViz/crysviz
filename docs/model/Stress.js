import { ColoredObject } from './ColoredObject.js';


export class Stress extends ColoredObject {
  constructor({ tensor = [[0,0,0],[0,0,0],[0,0,0]], scaling = [], color = [], stressGroup = null } = {}) {
    const defaultColor = [];
    super({ color, defaultColor});
    this.tensor = Stress._validateTensor(tensor);
    this.pearson = Stress._computePearsonMeasure(this.tensor);
    this.scaling = scaling;
    this.stressGroup = stressGroup;
  }

  get N() {
    return this.scaling.length;
  }

  get pressure() {
    return this._computePressure(this.tensor)
  }

  setTensor(tensor) {
    this.tensor = Stress._validateTensor(tensor);
    this._pressure = this._computePressure(this.tensor);
  }

  _computePressure(tensor) {
  if (!tensor || tensor.length !== 3 || tensor.some(row => row.length !== 3)) {
    throw new Error("Tensor must be a 3x3 array");
  }

  // Sum of diagonal elements
  const trace = tensor[0][0] + tensor[1][1] + tensor[2][2];

  // Pressure = -1/3 * trace
  const pressure = -trace / 3;

  return pressure;
}

  static _computePearsonMeasure(tensor) {
    return -1 ;
  }

  static _validateTensor(tensor) {
    if (!Array.isArray(tensor) || tensor.length !== 3) throw new Error("tensor must be a 3×3 array");
    for (let i = 0; i < 3; i++) {
      if (!Array.isArray(tensor[i]) || tensor[i].length !== 3) throw new Error("tensor must be a 3×3 array");
      for (let j = 0; j < 3; j++) {
        const v = tensor[i][j];
        if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`tensor[${i}][${j}] must be a finite number`);
      }
    }
    return tensor;
  }
}

