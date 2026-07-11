export class ColoredObject {
  /** @param {{color?:any, defaultColor?:any}} [opts] */
  constructor({ color = [], defaultColor= []} = {}) {
    this.color = color; 
    this.defaultColor = defaultColor; 
  }

}
