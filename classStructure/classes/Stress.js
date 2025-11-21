import { ColoredObject } from './ColoredObject.js';


export class Stress extends ColoredObject {
  constructor({ tensor = [[0,0,0],[0,0,0],[0,0,0]], scaling = [], colors = [], stressGroup = null } = {}) {
    const defaultColors = [];
    super({ colors, defaultColors });
    this.tensor = Stress._validateTensor(tensor);
    this.pressure = Stress._computePressure(this.tensor);
    this.pearson = Stress._computePearsonMeasure(this.tensor);
    this.scaling = scaling;
    this.stressGroup = stressGroup;
  }

  get N() {
    return this.scaling.length;
  }

  get pressure() {
    return this._pressure;
  }

  setTensor(tensor) {
    this.tensor = Stress._validateTensor(tensor);
    this._pressure = Stress._computePressure(this.tensor);
  }

  static _computePressure(tensor) {
    const tr = tensor[0][0] + tensor[1][1] + tensor[2][2];
    return tr / 3.0; // flip sign if you use compression-positive convention
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

