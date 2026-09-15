// A small YAML reader for the subset phonopy writes (band.yaml, mesh.yaml,
// qpoints.yaml, phonopy.yaml, irreps.yaml): block mappings and sequences by
// indentation, flow sequences (`[ a, b ]`, possibly nested), plain / quoted
// scalars and `#` comments. It is not a general YAML implementation — anchors,
// multi-line strings, flow mappings and complex keys are not phonopy output
// and are rejected with a clear error rather than mis-parsed.
//
// Written line-oriented for speed: a band.yaml with eigenvectors easily has
// several hundred thousand `- [ re, im ]` lines, and the fast path for those
// (a split on commas, no regex per number) is what keeps a 30 MB file in the
// one-second range.

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+)$/;

/** Turn a plain scalar into a number / boolean / null / string. */
function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (NUMBER_RE.test(s)) return Number(s);
  const q = s[0];
  if ((q === '"' || q === "'") && s[s.length - 1] === q && s.length >= 2) {
    const inner = s.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\/bfnrt])/g, (_, c) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c] ?? c)) : inner.replace(/''/g, "'");
  }
  return s;
}

/** Strip a trailing ` # comment` that is outside quotes and brackets. */
function stripComment(text) {
  let inQuote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") inQuote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '#' && depth === 0 && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Parse a flow sequence `[ ... ]` (nested allowed) starting at text[0] === '['.
 *  Returns [value, indexAfterClosingBracket]. */
function parseFlow(text, start) {
  const out = [];
  let i = start + 1;
  let token = '';
  const flushToken = () => {
    if (token.trim() !== '') out.push(scalar(token));
    token = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '[') {
      const [inner, next] = parseFlow(text, i);
      out.push(inner);
      i = next;
      continue;
    }
    if (c === ']') {
      flushToken();
      return [out, i + 1];
    }
    if (c === ',') {
      flushToken();
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new Error('YAML: unterminated quoted string');
      token += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    token += c;
    i++;
  }
  throw new Error('YAML: unterminated flow sequence');
}

/** Fast path for the overwhelmingly common `[ number, number, ... ]` line. */
function parseNumericFlow(text) {
  const close = text.lastIndexOf(']');
  if (text.indexOf('[', 1) >= 0 || close < 0) return null;
  const parts = text.slice(1, close).split(',');
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (!NUMBER_RE.test(p)) return null;
    out[i] = Number(p);
  }
  return out;
}

function parseValue(text) {
  const t = text.trim();
  if (t === '') return null;
  if (t[0] === '[') {
    const fast = parseNumericFlow(t);
    if (fast) return fast;
    const [value] = parseFlow(t, 0);
    return value;
  }
  if (t[0] === '{' || t[0] === '&' || t[0] === '*' || t[0] === '|' || t[0] === '>') {
    throw new Error(`YAML: unsupported syntax near "${t.slice(0, 20)}"`);
  }
  return scalar(t);
}

/** Find the first `: ` (or trailing `:`) that splits a mapping entry into key
 *  and value, ignoring colons inside quotes. Returns -1 for a non-mapping line. */
function keySplit(text) {
  let inQuote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; continue; }
    if (c === '[') return -1; // a flow sequence value line, never a key
    if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ' || text[i + 1] === '\t')) return i;
  }
  return -1;
}

/**
 * Parse phonopy-style YAML text into plain JS values (objects, arrays,
 * numbers, strings, booleans, null).
 * @param {string} text
 */
export function parsePhonopyYaml(text) {
  // Pre-pass: [indent, content] per meaningful line, comments already stripped.
  const rawLines = String(text).split(/\r?\n/);
  /** @type {{indent:number, text:string}[]} */
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    if (line.startsWith('---') || line.startsWith('...')) continue;
    if (line.indexOf('\t') >= 0) line = line.replace(/\t/g, ' ');
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent++;
    if (indent === line.length) continue;
    if (line[indent] === '#') continue;
    let content = line.slice(indent);
    if (content.indexOf('#') >= 0) content = stripComment(content);
    content = content.trimEnd();
    if (content === '') continue;
    lines.push({ indent, text: content });
  }

  let pos = 0;

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent !== indent) throw new Error(`YAML: bad indentation at line "${first.text}"`);
    if (isSeqItem(first.text)) return parseSequence(indent);
    if (keySplit(first.text) < 0) {
      // A scalar or flow sequence continued on its own (deeper) line, as in
      // phonopy.yaml's `displacement:\n    [ dx, dy, dz ]`.
      pos++;
      return parseValue(first.text);
    }
    return parseMapping(indent);
  }

  function isSeqItem(t) {
    return t === '-' || t.startsWith('- ');
  }

  function parseSequence(indent) {
    const out = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML: bad indentation in sequence at "${line.text}"`);
      if (!isSeqItem(line.text)) break; // parent mapping continues
      const rest = line.text === '-' ? '' : line.text.slice(2);
      const restTrim = rest.trim();
      if (restTrim === '') {
        pos++;
        // Nested block (deeper indent) or an empty item.
        if (pos < lines.length && lines[pos].indent > indent) out.push(parseBlock(lines[pos].indent));
        else out.push(null);
        continue;
      }
      if (restTrim[0] !== '[' && !restTrim.startsWith('"') && !restTrim.startsWith("'") && keySplit(restTrim) >= 0) {
        // `- key: value` — a mapping whose first entry shares the dash line.
        // Re-home the line at the key's column and parse it as a mapping.
        const keyIndent = indent + (line.text.length - line.text.slice(2).trimStart().length);
        lines[pos] = { indent: keyIndent, text: restTrim };
        out.push(parseMapping(keyIndent));
        continue;
      }
      out.push(parseValue(restTrim));
      pos++;
    }
    return out;
  }

  function parseMapping(indent) {
    const out = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML: bad indentation in mapping at "${line.text}"`);
      if (isSeqItem(line.text)) break; // a same-indent sequence belongs to the parent key
      const split = keySplit(line.text);
      if (split < 0) throw new Error(`YAML: expected "key: value", got "${line.text}"`);
      const key = String(scalar(line.text.slice(0, split)));
      const rest = line.text.slice(split + 1).trim();
      pos++;
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) {
          out[key] = parseBlock(lines[pos].indent);
        } else if (pos < lines.length && lines[pos].indent === indent && isSeqItem(lines[pos].text)) {
          out[key] = parseSequence(indent);
        } else {
          out[key] = null;
        }
      } else {
        out[key] = parseValue(rest);
      }
    }
    return out;
  }

  if (!lines.length) return null;
  const root = parseBlock(lines[0].indent);
  if (pos < lines.length) throw new Error(`YAML: unexpected content at "${lines[pos].text}"`);
  return root;
}
