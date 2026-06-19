/**
 * Incremental UTF-8 decoder
 * invalid bytes 0x80-0xFF are mapped to U+DC80..U+DCFF.
 * This emulates Python's errors="surrogateescape" semantics
 */
class Utf8SurrogateEscapeDecoder {
  constructor() {
    /** @type {number[]} */
    this._pending = [];
  }

  /**
   * @param {Uint8Array} chunk
   * @param {boolean} final
   * @returns {string}
   */
  decode(chunk, final = false) {
    const bytes = [];
    if (this._pending.length) {
      bytes.push(...this._pending);
      this._pending = [];
    }
    for (let i = 0; i < chunk.length; i++) bytes.push(chunk[i]);

    let out = "";
    let i = 0;

    const pushSurrogate = (b) => {
      // U+DC00 + byte
      out += String.fromCharCode(0xdc00 + b);
    };

    while (i < bytes.length) {
      const b0 = bytes[i];

      // ASCII fast-path
      if (b0 <= 0x7f) {
        out += String.fromCharCode(b0);
        i += 1;
        continue;
      }

      // Determine sequence length
      let need = 0;
      let code = 0;

      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1;
        code = b0 & 0x1f;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2;
        code = b0 & 0x0f;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3;
        code = b0 & 0x07;
      } else {
        // Invalid leading byte
        pushSurrogate(b0);
        i += 1;
        continue;
      }

      // Not enough bytes available
      if (i + need >= bytes.length) {
        if (!final) {
          this._pending = bytes.slice(i);
          break;
        }
        // final: treat remaining as invalid
        pushSurrogate(b0);
        i += 1;
        continue;
      }

      // Validate continuation bytes and build codepoint
      let ok = true;
      let cp = code;
      for (let k = 1; k <= need; k++) {
        const bx = bytes[i + k];
        if ((bx & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (bx & 0x3f);
      }

      if (!ok) {
        // Invalid sequence: surrogateescape the lead byte only
        // then continue parsing from next byte.
        pushSurrogate(b0);
        i += 1;
        continue;
      }

      // Apply UTF-8 constraints (overlongs, surrogate range, max)
      if (need === 1) {
        // min 0x80 already ensured by b0>=0xC2
      } else if (need === 2) {
        // overlong check
        if (cp < 0x800) ok = false;
        // surrogates invalid
        if (cp >= 0xd800 && cp <= 0xdfff) ok = false;
      } else if (need === 3) {
        if (cp < 0x10000) ok = false;
        if (cp > 0x10ffff) ok = false;
      }

      if (!ok) {
        pushSurrogate(b0);
        i += 1;
        continue;
      }

      // Append codepoint
      if (cp <= 0xffff) {
        out += String.fromCharCode(cp);
      } else {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10));
        out += String.fromCharCode(0xdc00 + (cp & 0x3ff));
      }
      i += 1 + need;
    }

    return out;
  }
}

function _splitOnceWhitespace(s) {
  const m = /\s+/.exec(s);
  if (!m) return [s];
  const i = m.index;
  const j = i + m[0].length;
  return [s.slice(0, i), s.slice(j)];
}

/**
 * Async line iterator over a ReadableStream<Uint8Array>.
 * lines include trailing "\n" when present (and may include "\r\n" as part of the line).
 *
 * @param {ReadableStream<Uint8Array>} stream
 */
async function* _iterLinesFromReadableStream(stream) {
  const reader = stream.getReader();
  const decoder = new Utf8SurrogateEscapeDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, false);

      // Split by "\n" while preserving it (like Python readline iteration)
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx + 1);
        buf = buf.slice(idx + 1);
        yield line;
      }
    }

    // Flush decoder and emit remaining buffer as last line (without forcing "\n")
    buf += decoder.decode(new Uint8Array(0), true);
    if (buf.length > 0) yield buf;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * rewindable_iterator: async iterator wrapper that allows rewinding by ONE step,
 * matching the Python semantics (including the optional replacement string).
 */
export class rewindable_iterator {
  /**
   * @param {AsyncIterable<string> | Iterable<string>} iterator
   */
  constructor(iterator) {
    // Support both sync and async iterables (line sources are async in-browser)
    this._iter =
      iterator && typeof iterator[Symbol.asyncIterator] === "function"
        ? iterator[Symbol.asyncIterator]()
        : iterator[Symbol.iterator]();

    this._rewind = false;
    /** @type {string | null} */
    this._cache = null;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  /**
   * @returns {Promise<IteratorResult<string>>}
   */
  async next() {
    if (this._rewind) {
      this._rewind = false;
      // _cache must be non-null if rewinding succeeded
      return { value: /** @type {string} */ (this._cache), done: false };
    }

    const r = await this._iter.next();
    if (r.done) {
      return { value: undefined, done: true };
    }
    this._cache = r.value;
    return { value: r.value, done: false };
  }

  /**
   * Rewind one step. If rewindstr is provided, replace the cached value.
   * @param {string | null} rewindstr
   */
  rewind(rewindstr = null) {
    if (this._rewind) {
      throw new RuntimeError("Tried to backup more than one step.");
    } else if (this._cache === null) {
      throw new RuntimeError("Can't backup past the beginning.");
    }
    this._rewind = true;
    if (rewindstr !== null) {
      this._cache = rewindstr;
    }
  }
}

class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** @param {string | null} s */
function _cif_is_int(s) {
  if (s === null) return false;
  // minimal, conservative: exact integer
  return /^[+-]?\d+$/.test(s);
}

/** @param {string | null} s */
function _cif_is_float(s) {
  if (s === null) return false;
  // conservative CIF-like float incl. exponent and optional uncertainty in parentheses
  // examples: 1.23, -1.2e-3, 12(3), 1.23(4), .5, 5.
  return /^[+-]?(?:(?:\d+\.\d*)|(?:\d*\.\d+)|(?:\d+))(?:[eE][+-]?\d+)?(?:\(\d+\))?$/.test(s);
}

/** @param {string} s */
function cif_to_int(s) {
  return parseInt(s, 10);
}

/** @param {string} s */
function cif_to_float(s) {
  // strip CIF uncertainty "(...)" before parse, like common CIF tooling does
  const base = s.replace(/\(\d+\)$/, "");
  return parseFloat(base);
}

function _read_cif_rewind_if_needed(f, row, done_fields) {
  // Python: splitstr = row.lstrip().split(None, done_fields)
  // JS equivalent: lstrip then split on whitespace, max (done_fields+1) parts
  const lstrip = row.replace(/^\s+/, "");
  const parts = _splitMax(lstrip, /\s+/, done_fields + 1);
  if (parts.length > 1) {
    const rest = parts[parts.length - 1];
    if (rest.trim() !== "") {
      f.rewind(rest);
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Split a string by a regex separator, at most maxParts parts (like Python maxsplit).
 * @param {string} s
 * @param {RegExp} sep
 * @param {number} maxParts
 * @returns {string[]}
 */
function _splitMax(s, sep, maxParts) {
  if (maxParts <= 1) return [s];
  const out = [];
  let rest = s;
  while (out.length < maxParts - 1) {
    const m = sep.exec(rest);
    if (!m) break;
    const idx = m.index;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + m[0].length);
    // Reset lastIndex for non-global regex use; safe even if global
    sep.lastIndex = 0;
  }
  out.push(rest);
  return out;
}

async function _read_cif_loop(f, pragmatic = true, allow_cif2 = false, use_types = false) {
  let noteol = false;
  const loop_data = new Map();
  /** @type {string[]} */
  const header = [];

  for await (const row of f) {
    const striprow = row.trim();
    const lowrow = striprow.toLowerCase();
    if (lowrow.startsWith("_")) {
      loop_data.set(lowrow.slice(1), []);
      header.push(lowrow.slice(1));
      noteol = _read_cif_rewind_if_needed(f, row, 1);
    } else {
      f.rewind();
      break;
    }
  }

  while (true && header.length > 0) {
    let broke = false;

    for (let i = 0; i < header.length; i++) {
      let row;
      try {
        let r = await f.next();
        if (r.done) { broke = true; break; }
        row = r.value;

        while (row !== undefined && /^\s+$/.test(row)) {
          r = await f.next();
          if (r.done) { broke = true; break; }
          row = r.value;
        }
        if (broke) break;
      } catch {
        broke = true;
        break;
      }

      const striprow = row.trim();
      const lowrow = striprow.toLowerCase();

      if (!row || row.startsWith("_") || lowrow.startsWith("data_") || lowrow.startsWith("loop_")) {
        f.rewind();
        broke = true;
        break;
      }

      f.rewind();
      const [val, newNoteol] = await _read_cif_data_value(
        f, noteol, pragmatic, allow_cif2, use_types, true, false
      );
      noteol = newNoteol;

      if (val === null) {
        // Could be a comment line, etc.
        continue;
      }

      loop_data.get(header[i]).push(val);
    }

    if (broke) break;

    // Python's "for ... else: continue" means:
    // if we completed the whole header without breaking, read the next loop row.
    continue;
  }

  return loop_data;
}

async function _read_cif_data_value(
  f,
  noteol,
  pragmatic = true,
  allow_cif2 = false,
  use_types = false,
  inloop = false,
  inlist = false
) {
  /** @type {any} */
  let data_value = null;

  for await (const row of f) {
    const striprow = row.trim();

    if (striprow.startsWith("#") || striprow === "") {
      noteol = false;
      continue;
    } else if (!noteol && row.startsWith(";")) {
      let folded = false;
      let newline = false;
      data_value = "";

      if (row[1] === "\\" && row.slice(2).replace(/\r?\n$/, "") === "") {
        folded = true;
      } else if (/^\s*$/.test(row.slice(1))) {
        if (!pragmatic) {
          data_value = row.replace(/^\s+/, "").replace(/\r?\n$/, "");
          newline = true;
        }
      } else {
        data_value = row.replace(/^\s+/, "").slice(1).replace(/\r?\n$/, "");
        newline = true;
      }

      let stripirow = "";
      for await (const irow of f) {
        stripirow = irow.trim();
        if (irow.startsWith(";")) {
          break;
        }
        if (newline) {
          data_value += "\n";
          newline = true;
        }
        if (folded && irow.replace(/\r?\n$/, "").endsWith("\\")) {
          data_value += irow.replace(/\r?\n$/, "").replace(/\\$/, "");
          newline = false;
        } else {
          data_value += irow.replace(/\r?\n$/, "");
          newline = true;
        }
      }

      if (stripirow.length > 1) {
        f.rewind(stripirow.slice(1));
        noteol = true;
      } else {
        noteol = false;
      }
      break;
    } else if (striprow.startsWith("'") || striprow.startsWith('"')) {
      // CIF quoting rules: quote is "escaped" if NOT followed by whitespace.
      const quote = striprow[0];
      let starti = 1;
      let endi;
      let endq;

      let found = false;
      for (let chari = 1; chari < striprow.length - 1; chari++) {
        if (striprow[chari] === quote && /\s/.test(String(striprow[chari + 1]))) {
          endi = chari;
          endq = chari + 1;
          found = true;
          break;
        }
      }

      if (!found) {
        if (striprow[striprow.length - 1] !== quote) {
          starti = 0;
          endi = striprow.length;
          endq = striprow.length;
        } else {
          endi = striprow.length - 1;
          endq = striprow.length;
        }
      }

      data_value = striprow.slice(starti, endi);
      if (endq !== striprow.length) {
        f.rewind(striprow.slice(endq));
        noteol = true;
      } else {
        noteol = false;
      }
      break;
    } else if (allow_cif2 && inlist && striprow.startsWith("]")) {
      // TODO in Python: spec check; preserved behavior
      const splitstr = striprow.split("]", 2);
      if (splitstr.length > 1 && splitstr[1].length > 0) {
        f.rewind(splitstr[1]);
        noteol = true;
      }
      data_value = null;
      break;
    } else if (allow_cif2 && striprow.startsWith("[")) {
      if (striprow.length > 1) {
        f.rewind(striprow.slice(1));
        noteol = true;
      }
      data_value = [];
      while (true) {
        const inner = await _read_cif_data_value(
          f,
          noteol,
          pragmatic,
          allow_cif2,
          use_types,
          false,
          true
        );
        const innerval = inner[0];
        noteol = inner[1];
        if (innerval === null) break;
        data_value.push(innerval);
      }
      break;
    } else if (allow_cif2 && inlist && striprow.includes("]")) {
      const rb = striprow.indexOf("]");
      const splitstr2 = [striprow.slice(0, rb), striprow.slice(rb + 1)];
      const splitstr = _splitOnceWhitespace(splitstr2[0]);
      data_value = splitstr[0].trim();
      if (splitstr.length > 1) {
        f.rewind(splitstr[1] + "]" + splitstr2[1]);
      } else {
        f.rewind("]" + splitstr2[1]);
      }
      noteol = true;
      break;
    } else {
      let splitstr;
      if (pragmatic && !inloop) {
        // Preserve Python: re.split(r'\s+_|\s+data_|\s+loop_', striprow, maxsplit=1)
        splitstr = _reSplitOnce(striprow, /(?:\s+_|\s+data_|\s+loop_)/);
      } else {
        // Python: striprow.split(None, 1)
        splitstr = _splitMax(striprow, /\s+/, 2);
      }

      // Data after '#' is comment, unless inside text string (handled above)
      const left = splitstr[0];
      data_value = left.split("#", 1)[0].trim();

      let rightside = "";
      if (splitstr.length > 1) rightside = splitstr[1].trim();

      if (rightside !== "") {
        f.rewind(rightside);
        noteol = true;
      } else {
        noteol = false;
      }
      break;
    }
  }

  if (use_types) {
    if (_cif_is_int(data_value)) {
      data_value = cif_to_int(data_value);
    } else if (_cif_is_float(data_value)) {
      data_value = cif_to_float(data_value);
    }
  }

  return [data_value, noteol];
}

/**
 * Like Python re.split(..., maxsplit=1): split once at first match; delimiter removed.
 * If no match, returns [s].
 * @param {string} s
 * @param {RegExp} re
 * @returns {string[]}
 */
function _reSplitOnce(s, re) {
  const m = re.exec(s);
  if (!m) return [s];
  const idx = m.index;
  const end = idx + m[0].length;
  // delimiter removed
  return [s.slice(0, idx), s.slice(end)];
}

async function _read_cif_data_block(f, pragmatic = true, allow_cif2 = false, use_types = false) {
  const data_items = new Map();
  let loops = 0;

  for await (const row of f) {
    const striprow = row.trim();
    const lowrow = striprow.toLowerCase();

    if (striprow.startsWith("#")) {
      continue;
    } else if (lowrow.startsWith("data_")) {
      f.rewind();
      return data_items;
    } else if (lowrow.startsWith("loop_")) {
      _read_cif_rewind_if_needed(f, row, 1);
      const loopdata = await _read_cif_loop(f, pragmatic, allow_cif2, use_types);

      data_items.set("loop_" + String(loops), Array.from(loopdata.keys()));
      loops += 1;

      for (const [k, v] of loopdata.entries()) {
        data_items.set(k, v);
      }
    } else if (striprow.startsWith(";")) {
      // Multi-line string failed to tie to a name: skip (preserve behavior)
      for await (const irow of f) {
        if (irow.replace(/\r?\n$/, "") === ";") break;
      }
    } else if (striprow.startsWith("_")) {
      const lowsplit = lowrow.split(/\s+/);
      const data_name = lowsplit[0].slice(1);

      let noteol;
      if (lowsplit.length > 1) {
        noteol = true;
        const parts = _splitOnceWhitespace(striprow);
        const rightside = (parts.length > 1 ? parts[1] : "").trim();
        f.rewind(rightside);
      } else {
        noteol = false;
      }

      const dv = await _read_cif_data_value(f, noteol, pragmatic, allow_cif2, use_types, false, false);
      const data_value = dv[0];
      // noteol = dv[1]; // Python updates noteol but doesn't use it after assignment here

      data_items.set(data_name, data_value);
    }
  }

  return data_items;
}

/**
 * Generic CIF reader for ReadableStream<Uint8Array>.
 *
 * Returns a Promise resolving to: [datalist, header]
 * - datalist: Array<[data_block_name: string, data_block: Map<string, any>]>
 * - header: string of leading comment lines (those starting with '#')
 *
 * In each data_block:
 * - tag_name -> value
 * - loops: key 'loop_N' stores an array of column names, and each column name key stores its column array.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {boolean} pragmatic
 * @param {boolean} allow_cif2
 * @param {boolean} use_types
 * @returns {Promise<[Array<[string, Map<string, any>]>, string]>}
 */
export async function read_cif(stream, pragmatic = true, allow_cif2 = false, use_types = false) {
  const lineIter = _iterLinesFromReadableStream(stream);
  const f = new rewindable_iterator(lineIter);

  let header = "";
  /** @type {Array<[string, Map<string, any>]>} */
  const datalist = [];

  // Read header comments at top of file
  for await (const row of f) {
    if (row.trim().startsWith("#")) {
      header += row;
    } else {
      f.rewind();
      break;
    }
  }

  for await (const row of f) {
    const lowrow = row.trim().toLowerCase();
    if (lowrow.startsWith("data_")) {
      const data_block_name = lowrow.split("_", 2)[1].split(/\s+/)[0].trim();
      _read_cif_rewind_if_needed(f, row, 1);
      const data_block = await _read_cif_data_block(f, pragmatic, allow_cif2, use_types);
      datalist.push([data_block_name, data_block]);
    }
  }

  return [datalist, header];
}
