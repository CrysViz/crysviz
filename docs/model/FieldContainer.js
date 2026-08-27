import { Field } from './Field.js';
import { FieldCatalog } from './FieldCatalog.js';

export class FieldContainer {
  constructor({
    fileName = null, // name of the file from which the field was loaded (e.g., "CHGCAR", "CUBE", etc.)
    source = null, // source of the field data (e.g., "CHGCAR", "CUBE", etc.)
    fieldCount = 0, // number of fields contained
    fields = [], // array of Field instances
    // Optional tree view over the fields (model/FieldCatalog.js). Formats whose
    // fields are all loaded at parse time (cube, CHGCAR) leave this null and a
    // flat catalog is synthesised on demand, so `container.fields` keeps working
    // unchanged. Formats with subcategories and lazily-loaded entries (WAVECAR:
    // spin -> k-point -> band) supply one, and for those `fields` is only the
    // subset that has actually been realised.
    catalog = null,
    // Set for formats that are a proxy over a file rather than a parsed copy of
    // it — currently only model/WavefunctionSource.js. Lets the UI offer the
    // cache controls and the panel show what the file contains.
    proxySource = null,
  } = {}) {
    this.fileName = fileName ? fileName : "Unspecified";
    this.source = source ? source : "Unknown";
    this.fields = this._ensureListOfClass(fields, Field);
    this.fieldCount = this.fields.length;
    this._catalog = catalog;
    this.proxySource = proxySource;
    // Set when a field file was attached to a structure whose cell differs from
    // the file's own (render/Render3DFieldModule.js parseWavecarFile). The field
    // panel surfaces it as a banner, because the isosurface is only meaningful
    // if the viewer knows the two cells are not the same.
    /** @type {{structureLattice: number[][], fileLattice: number[][], deviation: number} | null} */
    this.cellMismatch = null;
  }

  /**
   * The tree view over this container's fields.
   *
   * Synthesised as a flat catalog the first time it is asked for when the
   * format did not supply one, so every consumer can go through the same
   * interface regardless of which reader produced the container.
   * @returns {FieldCatalog}
   */
  get catalog() {
    if (!this._catalog) {
      this._catalog = FieldCatalog.flat(this.fields, this.source);
    }
    return this._catalog;
  }

  set catalog(value) {
    this._catalog = value;
  }

  /**
   * Fields that currently hold data.
   *
   * For an eagerly-parsed format this is just `fields`. For a proxy format it is
   * whatever the user has loaded so far, which is what the field browser and
   * every menu built on it must show.
   * @returns {Field[]}
   */
  loadedFields() {
    if (this._catalog) return this._catalog.loadedFields();
    return this.fields;
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
