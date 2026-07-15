// Lightweight rich-text support for color-bar legends (ColorBarWidget.js):
// users can type a mix of real HTML tags (<b>, <i>, <sup>, <sub>, plus their
// <strong>/<em> synonyms) and simple LaTeX/markdown-style shorthand
// (**bold**, *italic*, ^{...}/^x superscript, _{...}/_x subscript,
// \textbf{}/\textit{}) into a legend, and see it rendered with real
// formatting both in the live DOM widget and in the redrawn PNG-export
// canvas. Deliberately NOT a full HTML/LaTeX parser — just enough shorthand
// to cover "Force (eV/Å²)" / "H₂O" / "**Charge Density**" style legends.
//
// Only a small tag whitelist ever reaches the DOM (sanitizeToRoot), and it's
// parsed via DOMParser rather than assigned through innerHTML on a live
// element — DOMParser-produced documents don't execute scripts or fetch
// image/resource attributes, so a stray <img onerror=...> or <script> in
// user input can't run before the whitelist walk strips it.

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'SUP', 'SUB', 'BR']);

export function normalizeLegendMarkup(raw) {
  let s = String(raw ?? '');

  // LaTeX-style commands (checked before the shorthand below so \textbf{**x**}
  // isn't double-processed — not that anyone should type that, but braces
  // inside braces would otherwise confuse the non-greedy replaces).
  s = s.replace(/\\textbf\{([^{}]*)\}/g, '<b>$1</b>');
  s = s.replace(/\\mathbf\{([^{}]*)\}/g, '<b>$1</b>');
  s = s.replace(/\\textit\{([^{}]*)\}/g, '<i>$1</i>');
  s = s.replace(/\\mathit\{([^{}]*)\}/g, '<i>$1</i>');

  // Superscript / subscript: a braced group for multi-character runs
  // ("Å^{2+}"), or — real LaTeX semantics, not "the next word" — a single
  // character with no braces ("H_2O" is H, subscript 2, then O; "x^10" is x,
  // superscript 1, then 0, exactly like actual LaTeX renders it).
  s = s.replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>');
  s = s.replace(/\^([A-Za-z0-9])/g, '<sup>$1</sup>');
  s = s.replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');

  // Markdown-style bold/italic — bold's ** must be consumed first, or the
  // italic rule would eat one * from each pair and leave the other stray.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');

  return s;
}

// Parses `html` in a scriptless, resource-inert DOMParser document, then
// strips anything outside ALLOWED_TAGS (unwrapping — not deleting — so the
// text inside a disallowed tag like <div>/<span> still survives) and drops
// every attribute off what's left (no href/src/style/on* survives). Returns
// the cleaned root element, still owned by the throwaway parser document —
// callers adopt its children into the live document via importNode.
function sanitizeToRoot(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;

  (function clean(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (!ALLOWED_TAGS.has(child.tagName)) {
        node.replaceChild(doc.createTextNode(child.textContent), child);
        continue;
      }
      for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
      clean(child);
    }
  })(root);

  return root;
}

/** Renders `raw` markup into `el`, replacing its current children. */
export function applyLegendHtml(el, raw) {
  const root = sanitizeToRoot(normalizeLegendMarkup(raw));
  el.replaceChildren(...Array.from(root.childNodes).map((n) => document.importNode(n, true)));
}

/** Strips all markup/tags down to plain text (font-metric measurement, aria-label). */
export function legendPlainText(raw) {
  const root = sanitizeToRoot(normalizeLegendMarkup(raw));
  return (root.textContent || '').replace(/\s+/g, ' ').trim();
}

// Flattens the sanitized tree into a run of {text, bold, italic, script}
// segments, in document order, for the canvas exporter (which has no DOM to
// lay rich text out with and has to draw each run's font/baseline itself).
function walkSegments(node, state, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) out.push({ text: child.textContent, ...state });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (tag === 'BR') { out.push({ text: '\n', ...state }); continue; }
    const next = { ...state };
    if (tag === 'B' || tag === 'STRONG') next.bold = true;
    else if (tag === 'I' || tag === 'EM') next.italic = true;
    else if (tag === 'SUP') next.script = 'sup';
    else if (tag === 'SUB') next.script = 'sub';
    walkSegments(child, next, out);
  }
}

export function parseLegendSegments(raw) {
  const root = sanitizeToRoot(normalizeLegendMarkup(raw));
  const out = [];
  walkSegments(root, { bold: false, italic: false, script: null }, out);
  return out;
}

const SCRIPT_SCALE = 0.7; // sup/sub font size, relative to the base run
const SCRIPT_SHIFT = 0.35; // sup/sub baseline offset, relative to fontPx
const DEFAULT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Draws `raw` legend markup onto a 2D canvas context as a single run of
 * differently-styled fillText calls (bold/italic font strings, sup/sub sized
 * down and baseline-shifted) — the canvas equivalent of what applyLegendHtml
 * renders via real DOM tags, used by ImageExportModule.js so exported PNGs
 * carry the same formatting the live widget shows. Honors ctx's current
 * transform (translate/rotate), so vertical mode's rotated legend still just
 * works. Returns the total rendered width (in the run's own, pre-rotation
 * horizontal axis).
 */
export function drawLegendRichText(ctx, raw, x, y, opts = {}) {
  const { fontPx = 14, fontFamily = DEFAULT_FONT_FAMILY, align = 'left', baseline = 'alphabetic', color } = opts;
  if (!raw) return 0;
  const segments = parseLegendSegments(raw).filter((s) => s.text !== '\n');
  if (!segments.length) return 0;

  const savedFont = ctx.font;
  const savedAlign = ctx.textAlign;
  const savedBaseline = ctx.textBaseline;
  const savedFill = ctx.fillStyle;
  if (color) ctx.fillStyle = color;

  const measured = segments.map((seg) => {
    const px = seg.script ? fontPx * SCRIPT_SCALE : fontPx;
    const weight = seg.bold ? 'bold ' : '';
    const style = seg.italic ? 'italic ' : '';
    ctx.font = `${style}${weight}${px}px ${fontFamily}`;
    return { ...seg, px, font: ctx.font, width: ctx.measureText(seg.text).width };
  });
  const totalWidth = measured.reduce((sum, m) => sum + m.width, 0);

  let cx;
  if (align === 'center') cx = x - totalWidth / 2;
  else if (align === 'right') cx = x - totalWidth;
  else cx = x;

  ctx.textAlign = 'left';
  ctx.textBaseline = baseline;
  for (const m of measured) {
    ctx.font = m.font;
    const dy = m.script === 'sup' ? -fontPx * SCRIPT_SHIFT : m.script === 'sub' ? fontPx * SCRIPT_SHIFT : 0;
    ctx.fillText(m.text, cx, y + dy);
    cx += m.width;
  }

  ctx.font = savedFont;
  ctx.textAlign = savedAlign;
  ctx.textBaseline = savedBaseline;
  ctx.fillStyle = savedFill;
  return totalWidth;
}
