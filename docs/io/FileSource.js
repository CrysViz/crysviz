/**
 * A uniform, lazily-read handle over "the bytes of a file".
 *
 * Every reader in `io/` used to be handed a fully-materialised string, because
 * `ui/StructureInputModule.js` called `FileReader.readAsText()` before it knew
 * what the file was. That is fine for a POSCAR and impossible for a WAVECAR,
 * which is routinely multi-GB and is only ever read a record at a time.
 *
 * `FileSource` hides *where* the bytes come from so a reader can ask for a byte
 * range without anyone having decided to buffer the whole file first:
 *
 *   - `fromFile`        Blob-backed. `readBytes` slices, so nothing outside the
 *                       requested range is ever read into memory.
 *   - `fromArrayBuffer` already-in-memory bytes (addons, the CLI host, .traj).
 *   - `fromString`      already-in-memory text (pasted structures, defaults).
 *
 * Text formats keep working exactly as before by calling `readAllText()`; only
 * formats that declare themselves random-access pay any attention to the rest.
 *
 * All read methods are async even when the data is already in memory, so a
 * caller never has to branch on which kind of source it holds.
 */

/** @type {TextDecoder | null} */
let sharedDecoder = null;

function decoder() {
  // Non-fatal: `readHead` is used for format sniffing and will regularly be
  // pointed at binary files, where invalid sequences must become replacement
  // characters rather than throw.
  if (!sharedDecoder) sharedDecoder = new TextDecoder('utf-8', { fatal: false });
  return sharedDecoder;
}

export class FileSource {
  /**
   * Prefer the `from*` factories; this constructor is internal.
   * @param {{kind: string, blob?: Blob, bytes?: Uint8Array, text?: string}} init
   */
  constructor(init) {
    /** @type {string} 'blob' | 'bytes' | 'text' */
    this.kind = init.kind;
    /** @type {Blob | null} */
    this._blob = init.blob || null;
    /** @type {Uint8Array | null} */
    this._bytes = init.bytes || null;
    /** @type {string | null} */
    this._text = init.text === undefined ? null : init.text;
  }

  /** @param {Blob} blob A File or Blob; never read in full. */
  static fromFile(blob) {
    return new FileSource({ kind: 'blob', blob });
  }

  /** @param {ArrayBuffer | Uint8Array} buffer */
  static fromArrayBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return new FileSource({ kind: 'bytes', bytes });
  }

  /** @param {string} text */
  static fromString(text) {
    return new FileSource({ kind: 'text', text: String(text) });
  }

  /**
   * Wrap whatever `loadStructure` was handed. Existing callers pass a string or
   * an ArrayBuffer and keep working unchanged; a FileSource passes through.
   * @param {FileSource | ArrayBuffer | Uint8Array | string} content
   * @returns {FileSource}
   */
  static from(content) {
    if (content instanceof FileSource) return content;
    if (typeof content === 'string') return FileSource.fromString(content);
    if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
      return FileSource.fromArrayBuffer(content);
    }
    // `content` has been narrowed away from every declared type by now, so the
    // Blob branch needs the cast: this exists for callers outside the annotated
    // set (addons handing over a File directly).
    if (typeof Blob !== 'undefined' && /** @type {any} */ (content) instanceof Blob) {
      return FileSource.fromFile(/** @type {Blob} */ (/** @type {any} */ (content)));
    }
    throw new TypeError('FileSource.from: unsupported content type');
  }

  /**
   * Size in bytes. For a text source this forces the UTF-8 encoding, so avoid
   * it on the text path unless the number is actually needed.
   * @returns {number}
   */
  get size() {
    if (this.kind === 'blob') return this._blob.size;
    if (this.kind === 'bytes') return this._bytes.byteLength;
    return this._encodedText().byteLength;
  }

  /** @returns {Uint8Array} */
  _encodedText() {
    if (!this._bytes) this._bytes = new TextEncoder().encode(this._text);
    return this._bytes;
  }

  /**
   * Read `length` bytes starting at `offset`.
   *
   * Reads that run past the end are clamped rather than throwing, matching
   * Blob.slice; callers that care check the returned byteLength.
   *
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async readBytes(offset, length) {
    const start = Math.max(0, Math.floor(offset));
    const end = start + Math.max(0, Math.floor(length));

    if (this.kind === 'blob') {
      const slice = this._blob.slice(start, end);
      return new Uint8Array(await slice.arrayBuffer());
    }

    const all = this.kind === 'bytes' ? this._bytes : this._encodedText();
    // subarray, not slice: this is a view, so a large random-access read costs
    // no copy. Callers that need to keep the bytes past the next read of the
    // same source must copy them (WavefunctionSource does).
    return all.subarray(start, Math.min(end, all.byteLength));
  }

  /**
   * First `n` bytes plus a lossy text decode of them, for format detection.
   *
   * Cheap for every source kind, which is what lets `io/formats.js` pass a head
   * to every descriptor without caring whether content sniffing is switched on.
   *
   * @param {number} [n]
   * @returns {Promise<{bytes: Uint8Array, text: string}>}
   */
  async readHead(n = 4096) {
    if (this.kind === 'text') {
      // Slice the string BEFORE encoding. Going through readBytes would encode
      // the entire text just to look at its first few KB, which for a 17 MB
      // cube file is a full extra pass on every single load. Slicing by
      // characters can yield slightly more than `n` bytes for multi-byte input,
      // which is harmless for a head.
      const bytes = new TextEncoder().encode(this._text.slice(0, n));
      return { bytes, text: this._text.slice(0, n) };
    }
    const bytes = await this.readBytes(0, n);
    return { bytes, text: decoder().decode(bytes) };
  }

  /**
   * The whole file as text. This is what every existing text reader gets, and
   * it is deliberately the only method that materialises everything.
   * @returns {Promise<string>}
   */
  async readAllText() {
    if (this.kind === 'text') return this._text;
    if (this.kind === 'bytes') return decoder().decode(this._bytes);
    return this._blob.text();
  }

  /**
   * The whole file as bytes. Used by the formats that are binary but small
   * enough to hold at once (ASE .traj).
   * @returns {Promise<ArrayBuffer>}
   */
  async readAllBytes() {
    if (this.kind === 'blob') return this._blob.arrayBuffer();
    const all = this.kind === 'bytes' ? this._bytes : this._encodedText();
    // Hand back a standalone buffer: parsers wrap this in typed-array views and
    // must not alias our retained copy.
    // `.buffer` is typed ArrayBuffer|SharedArrayBuffer; these views are always
    // built over a plain ArrayBuffer here (TextEncoder output or a Blob read).
    return /** @type {ArrayBuffer} */ (all.buffer.slice(
      all.byteOffset, all.byteOffset + all.byteLength));
  }
}
