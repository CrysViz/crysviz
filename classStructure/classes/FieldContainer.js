import { Field } from './Field.js';

export class FieldContainer {
  constructor({
    fileName = null, // name of the file from which the field was loaded (e.g., "CHGCAR", "CUBE", etc.)
    source = null, // source of the field data (e.g., "CHGCAR", "CUBE", etc.)
    fieldCount = 0, // number of fields contained
    fields = [], // array of Field instances
  } = {}) {
    this.fileName = fileName ? fileName : "Unspecified";
    this.source = source ? source : "Unknown";
    this.fields = this._ensureListOfClass(fields, Field);
    this.fieldCount = this.fields.length;
  }

  _ensureListOfClass(input, ClassType) {
    if (!Array.isArray(input)) {
      input = [input];
    }

    return input.map(item =>
      item instanceof ClassType ? item : new ClassType(item)
    );
  }
}