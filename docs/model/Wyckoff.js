export class Wyckoff {
  constructor({
    element = null,
    dof = [],
    multiplier = null,
    generator =[],
  } = {}) {
    this.element = element;
    this.dof= dof;
    this.multiplier = multiplier;
    this.generator = generator;
    }
  }

