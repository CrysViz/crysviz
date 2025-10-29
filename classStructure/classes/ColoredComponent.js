export class ColoredComponent {
  constructor({ colors = {}, defaultColors= {}} = {}) {
    this.colors = colors; // list of color strings (e.g. hex)
    this.defaultColors = defaultColors; 
  }

}
