class ColoredComponent {
  constructor({ colors = [] } = {}) {
    this.colors = colors; // list of color strings (e.g. hex)
  }

  assignDefaultColors(count) {
    if (this.colors.length < count) {
      this.colors = Array.from({ length: count }, () => ColoredComponent.randomColor());
    }
  }

  static randomColor() {
    return (
      "#" +
      Math.floor(Math.random() * 16777215)
        .toString(16)
        .padStart(6, "0")
    );
  }
}

