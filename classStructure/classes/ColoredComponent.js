export class ColoredComponent {
  constructor({ color=null, defaultColor=null,colors = {}, defaultColors= {}} = {}) {
    this.colors = colors; // list of color strings (e.g. hex)
    this.defaultColors = defaultColors; 
    this.color = color;
    this.defaultColor = defaultColor;
  }

}
