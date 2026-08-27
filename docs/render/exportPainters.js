// One drawing interface, two backends, so the export overlays (measurement
// labels, axes legend, colour bars, composition legend) are laid out ONCE and
// can come out either as pixels (PNG) or as editable SVG elements.
//
// CanvasPainter is a thin shim over the 2D context — the PNG path must keep
// producing exactly what it produced before this abstraction existed.
// SvgPainter accumulates markup instead, under rules that keep the result
// openable and editable in Inkscape rather than merely valid SVG:
//
//   - No dominant-baseline / alignment-baseline. Inkscape's renderer support
//     for them is patchy, so every text is emitted on the ALPHABETIC baseline
//     with the top/middle/bottom offset folded into the y coordinate using the
//     font's own metrics (measured on a scratch canvas).
//   - text-anchor for horizontal alignment (that one Inkscape handles).
//   - Rich text as <tspan>s carrying font-weight/style/size, with sup/sub as a
//     dy shift that the next tspan cancels — Inkscape keeps the run editable
//     as a single text object that way.
//   - Colours are split into #rrggbb + a separate *-opacity attribute:
//     rgba()/hsl() in a presentation attribute is CSS Color 4 territory and
//     older Inkscape drops it silently (the element renders black).
//   - xml:space="preserve" so leading/trailing spaces in labels survive.
//   - Unique ids on everything, and layers as <g inkscape:groupmode="layer">
//     with no clip-path (a clipped layer is a nuisance to edit — primitives
//     that fall entirely off the page are dropped instead).

import { parseLegendSegments, drawLegendRichText } from '../utils/index.js';

/**
 * Shape/paint options. Not every backend or primitive honours every field —
 * `stops`/`horizontal` are gradientRect's, `className` is the vector path's.
 * @typedef {object} PaintStyle
 * @property {string|null} [fill]
 * @property {string|null} [stroke]
 * @property {number} [lineWidth]
 * @property {number} [alpha]
 * @property {string} [cap]
 * @property {string} [label]
 * @property {string} [className]
 * @property {{offset:number, color:string}[]} [stops]
 * @property {boolean} [horizontal]
 */

/**
 * @typedef {object} FontSpec
 * @property {number} [fontPx]
 * @property {string|number} [weight]
 * @property {string} [style]
 * @property {string} [family]
 */

/**
 * @typedef {FontSpec & {
 *   align?: 'left'|'center'|'right',
 *   baseline?: 'top'|'middle'|'bottom'|'alphabetic',
 *   fill?: string,
 *   alpha?: number,
 *   rotateDeg?: number,
 *   label?: string,
 * }} TextStyle
 */

/**
 * @typedef {{width:number, ascent:number, descent:number,
 *   inkAscent:number, inkDescent:number}} ExportTextMetrics
 */

/** Font stack for SVG output. The app's own face is very unlikely to be
 *  installed on the machine that opens the file, so name real fallbacks. */
export const SVG_FONT_FAMILY = "'CrysViz Sans', 'DejaVu Sans', Arial, sans-serif";

const CANVAS_FONT_FAMILY = "'CrysViz Sans', sans-serif";

// Mirrors utils/LegendRichText.js — the SVG rich-text path has to reproduce
// the same sup/sub geometry the canvas path draws.
const SCRIPT_SCALE = 0.7;
const SCRIPT_SHIFT = 0.35;

/** @param {FontSpec} [spec] */
function fontShorthand({ fontPx = 14, weight = '', style = '', family = CANVAS_FONT_FAMILY } = {}) {
  const s = style ? `${style} ` : '';
  const w = weight ? `${weight} ` : '';
  return `${s}${w}${fontPx}px ${family}`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Canvas 2D backend: the PNG export path. Every method is the same sequence of
 * context calls the export used to make inline, so the output is byte-for-byte
 * the same drawing.
 */
export class CanvasPainter {
  /** @param {CanvasRenderingContext2D} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** Backends that emit vector markup set this; layout code branches on it
     *  only where the two genuinely cannot share (the gizmo blit). */
    this.isVector = false;
  }

  beginGroup() { /* layers are an SVG concept */ }

  endGroup() { /* layers are an SVG concept */ }

  /** @param {PaintStyle} [opts] */
  roundRect(x, y, w, h, r, opts = {}) {
    const { fill, stroke, lineWidth = 1, alpha = 1 } = opts;
    const ctx = this.ctx;
    const prevAlpha = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    roundRectPath(ctx, x, y, w, h, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke && lineWidth > 0) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.globalAlpha = prevAlpha;
  }

  /** @param {PaintStyle} [opts] */
  circle(cx, cy, r, opts = {}) {
    const { fill, stroke, lineWidth = 1 } = opts;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke && lineWidth > 0) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  /** @param {PaintStyle} [opts] */
  line(x1, y1, x2, y2, opts = {}) {
    const { stroke, lineWidth = 1, cap = 'butt' } = opts;
    const ctx = this.ctx;
    if (!stroke || !(lineWidth > 0)) return;
    const prevCap = ctx.lineCap;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineCap = /** @type {CanvasLineCap} */ (cap);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.lineCap = prevCap;
  }

  /** Closed polygon through `points` ([{x,y}, …]).
   *  @param {{x:number,y:number}[]} points
   *  @param {PaintStyle} [opts] */
  polygon(points, opts = {}) {
    const { fill, stroke, lineWidth = 1 } = opts;
    if (points.length < 3) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke && lineWidth > 0) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  /** Axis-aligned gradient fill inside a rounded rect. `horizontal` runs the
   *  stops left→right; otherwise bottom→top (the colour bars' own convention).
   *  @param {PaintStyle} [opts] */
  gradientRect(x, y, w, h, r, opts = {}) {
    const { stops = [], horizontal = true } = opts;
    const ctx = this.ctx;
    const grad = horizontal
      ? ctx.createLinearGradient(x, 0, x + w, 0)
      : ctx.createLinearGradient(0, y + h, 0, y);
    for (const s of stops) grad.addColorStop(s.offset, s.color);
    ctx.fillStyle = grad;
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fill();
  }

  /** @param {TextStyle} [opts] */
  text(str, x, y, opts = {}) {
    if (!str) return;
    const ctx = this.ctx;
    const { align = 'left', baseline = 'alphabetic', fill, alpha = 1, rotateDeg = 0 } = opts;
    const prevAlpha = ctx.globalAlpha;
    if (rotateDeg) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((rotateDeg * Math.PI) / 180);
    }
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.font = fontShorthand(opts);
    ctx.textAlign = /** @type {CanvasTextAlign} */ (align);
    ctx.textBaseline = /** @type {CanvasTextBaseline} */ (baseline);
    if (fill) ctx.fillStyle = fill;
    ctx.fillText(str, rotateDeg ? 0 : x, rotateDeg ? 0 : y);
    ctx.globalAlpha = prevAlpha;
    if (rotateDeg) ctx.restore();
  }

  /** @param {TextStyle} [opts] */
  richText(raw, x, y, opts = {}) {
    const ctx = this.ctx;
    const { fontPx = 14, align = 'left', baseline = 'alphabetic', fill, rotateDeg = 0 } = opts;
    if (rotateDeg) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((rotateDeg * Math.PI) / 180);
    }
    drawLegendRichText(ctx, raw, rotateDeg ? 0 : x, rotateDeg ? 0 : y,
      { fontPx, align, baseline, color: fill });
    if (rotateDeg) ctx.restore();
  }

  image(canvasEl, x, y, w, h) {
    this.ctx.drawImage(canvasEl, x, y, w, h);
  }

  /** @param {FontSpec} [font]
   *  @returns {ExportTextMetrics} */
  measureText(str, font = {}) {
    const ctx = this.ctx;
    const saved = ctx.font;
    ctx.font = fontShorthand(font);
    const m = ctx.measureText(str);
    ctx.font = saved;
    return textMetrics(m, font.fontPx || 14);
  }
}

/** Canvas TextMetrics -> the numbers the baseline maths needs. `ascent`/
 *  `descent` come from the FONT box (stable across strings, which is what a
 *  baseline conversion needs); `inkAscent`/`inkDescent` are the string's own
 *  drawn extent, for callers centring on the glyphs actually present. */
function textMetrics(m, fontPx) {
  const inkAscent = m.actualBoundingBoxAscent || fontPx * 0.8;
  const inkDescent = m.actualBoundingBoxDescent || fontPx * 0.2;
  return {
    width: m.width,
    ascent: m.fontBoundingBoxAscent || inkAscent,
    descent: m.fontBoundingBoxDescent || inkDescent,
    inkAscent,
    inkDescent,
  };
}

// --- SVG backend ------------------------------------------------------------

let scratchCtx = null;
/** Shared offscreen 2D context, used only for text metrics and colour
 *  normalisation — the SVG painter never rasterises anything. */
function scratch() {
  if (!scratchCtx) {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    scratchCtx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  }
  return scratchCtx;
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Trim float noise out of coordinates — a 4 MB SVG of 17-digit numbers is
 *  slower to open and no more accurate at any printable size. */
export function num(v) {
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Any CSS colour -> {hex:'#rrggbb', alpha:number}. Goes through a canvas
 * fillStyle round-trip so named colours, hsl(), 4/8-digit hex and computed
 * `rgba(r, g, b, a)` strings all resolve without a parser of our own.
 * @returns {{hex:string, alpha:number} | null} null for fully transparent /
 *   unparseable input, which callers treat as "don't emit the paint".
 */
export function normalizeColor(css) {
  if (!css) return null;
  const ctx = scratch();
  ctx.fillStyle = '#000000';
  ctx.fillStyle = css;
  const resolved = String(ctx.fillStyle);
  if (resolved.startsWith('#')) return { hex: resolved, alpha: 1 };
  const m = resolved.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter((p) => p !== '').map(Number);
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (!(alpha > 0)) return null;
  const hex = `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, '0')).join('')}`;
  return { hex, alpha };
}

/** fill/stroke attribute pair for one paint, opacity split out (see header). */
function paintAttrs(kind, css, extraAlpha = 1) {
  const c = normalizeColor(css);
  if (!c) return `${kind}="none"`;
  const a = c.alpha * extraAlpha;
  return a >= 0.999
    ? `${kind}="${c.hex}"`
    : `${kind}="${c.hex}" ${kind}-opacity="${num(a)}"`;
}

const ANCHOR = { left: 'start', center: 'middle', right: 'end' };

/**
 * SVG backend. Accumulates `<defs>` and body markup; the document skeleton is
 * assembled by render/SvgExportModule.js.
 */
export class SvgPainter {
  /**
   * @param {{width?:number, height?:number, idPrefix?:string,
   *   fontFamily?:string}} [opts] width/height bound the page: primitives that
   *   fall entirely outside it are dropped (layers carry no clip-path).
   */
  constructor({ width = 0, height = 0, idPrefix = 'cv', fontFamily = SVG_FONT_FAMILY } = {}) {
    this.isVector = true;
    this.width = width;
    this.height = height;
    this.idPrefix = idPrefix;
    this.fontFamily = fontFamily;
    /** @type {string[]} */
    this.bodyParts = [];
    /** @type {string[]} */
    this.defsParts = [];
    this.counter = 0;
    this.depth = 0;
  }

  /** Unique, human-readable element id (Inkscape's XML editor shows these). */
  id(kind) {
    this.counter += 1;
    return `${this.idPrefix}-${kind}-${this.counter}`;
  }

  push(markup) {
    this.bodyParts.push('  '.repeat(this.depth + 1) + markup);
  }

  pushDefs(markup) {
    this.defsParts.push('    ' + markup);
  }

  /** Raw markup produced elsewhere (render/SvgSceneVector.js), indented into
   *  the current group. */
  raw(markup, defs = '') {
    if (markup) this.bodyParts.push(markup);
    if (defs) this.defsParts.push(defs);
  }

  body() { return this.bodyParts.join('\n'); }

  defs() { return this.defsParts.join('\n'); }

  /** True when the box lies wholly outside the page (with slack, so a label
   *  poking over the edge still exports). */
  culled(x0, y0, x1, y1, slack = 0) {
    if (!(this.width > 0) || !(this.height > 0)) return false;
    return x1 < -slack || y1 < -slack || x0 > this.width + slack || y0 > this.height + slack;
  }

  beginGroup(label, id) {
    this.push(`<g inkscape:groupmode="layer" inkscape:label="${escapeXml(label)}" `
      + `id="${escapeXml(id || this.id('layer'))}">`);
    this.depth += 1;
  }

  endGroup() {
    this.depth = Math.max(0, this.depth - 1);
    this.push('</g>');
  }

  /** @param {PaintStyle} [opts] */
  roundRect(x, y, w, h, r, opts = {}) {
    const { fill, stroke, lineWidth = 1, alpha = 1, label } = opts;
    if (this.culled(x, y, x + w, y + h)) return;
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    const attrs = [
      `id="${this.id('rect')}"`,
      label ? `inkscape:label="${escapeXml(label)}"` : '',
      `x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"`,
      rr > 0 ? `rx="${num(rr)}" ry="${num(rr)}"` : '',
      paintAttrs('fill', fill, alpha),
      stroke && lineWidth > 0
        ? `${paintAttrs('stroke', stroke, alpha)} stroke-width="${num(lineWidth)}"`
        : 'stroke="none"',
    ].filter(Boolean).join(' ');
    this.push(`<rect ${attrs} />`);
  }

  /** @param {PaintStyle} [opts] */
  circle(cx, cy, r, opts = {}) {
    const { fill, stroke, lineWidth = 1, label, className } = opts;
    if (this.culled(cx - r, cy - r, cx + r, cy + r)) return;
    const attrs = [
      `id="${this.id('circle')}"`,
      label ? `inkscape:label="${escapeXml(label)}"` : '',
      className ? `class="${escapeXml(className)}"` : '',
      `cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}"`,
      paintAttrs('fill', fill),
      stroke && lineWidth > 0
        ? `${paintAttrs('stroke', stroke)} stroke-width="${num(lineWidth)}"`
        : 'stroke="none"',
    ].filter(Boolean).join(' ');
    this.push(`<circle ${attrs} />`);
  }

  /** @param {PaintStyle} [opts] */
  line(x1, y1, x2, y2, opts = {}) {
    const { stroke, lineWidth = 1, cap = 'butt', label } = opts;
    if (!stroke || !(lineWidth > 0)) return;
    if (this.culled(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2),
      lineWidth)) return;
    const attrs = [
      `id="${this.id('line')}"`,
      label ? `inkscape:label="${escapeXml(label)}"` : '',
      `x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"`,
      paintAttrs('stroke', stroke),
      `stroke-width="${num(lineWidth)}" stroke-linecap="${cap}" fill="none"`,
    ].filter(Boolean).join(' ');
    this.push(`<line ${attrs} />`);
  }

  /** @param {{x:number,y:number}[]} points
   *  @param {PaintStyle} [opts] */
  polygon(points, opts = {}) {
    const { fill, stroke, lineWidth = 1, label } = opts;
    if (points.length < 3) return;
    const xs = points.map((q) => q.x);
    const ys = points.map((q) => q.y);
    if (this.culled(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) return;
    const attrs = [
      `id="${this.id('poly')}"`,
      label ? `inkscape:label="${escapeXml(label)}"` : '',
      `points="${points.map((q) => `${num(q.x)},${num(q.y)}`).join(' ')}"`,
      paintAttrs('fill', fill),
      stroke && lineWidth > 0
        ? `${paintAttrs('stroke', stroke)} stroke-width="${num(lineWidth)}"`
        : 'stroke="none"',
    ].filter(Boolean).join(' ');
    this.push(`<polygon ${attrs} />`);
  }

  /** @param {PaintStyle} [opts] */
  gradientRect(x, y, w, h, r, opts = {}) {
    const { stops = [], horizontal = true, label } = opts;
    if (this.culled(x, y, x + w, y + h)) return;
    const gid = this.id('grad');
    // objectBoundingBox units so the gradient follows the rect if it is later
    // resized in Inkscape. Vertical runs bottom (min) -> top (max).
    const coords = horizontal
      ? 'x1="0" y1="0" x2="1" y2="0"'
      : 'x1="0" y1="1" x2="0" y2="0"';
    const stopMarkup = stops.map((s) => {
      const c = normalizeColor(s.color);
      return `      <stop offset="${num(s.offset)}" stop-color="${c ? c.hex : '#000000'}" />`;
    }).join('\n');
    this.pushDefs(`<linearGradient id="${gid}" ${coords}>\n${stopMarkup}\n    </linearGradient>`);
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    const attrs = [
      `id="${this.id('rect')}"`,
      label ? `inkscape:label="${escapeXml(label)}"` : '',
      `x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"`,
      rr > 0 ? `rx="${num(rr)}" ry="${num(rr)}"` : '',
      `fill="url(#${gid})" stroke="none"`,
    ].filter(Boolean).join(' ');
    this.push(`<rect ${attrs} />`);
  }

  /** Alphabetic-baseline y for a requested canvas-style baseline.
   *  @param {FontSpec} font */
  baselineY(y, baseline, font) {
    if (baseline === 'alphabetic' || !baseline) return y;
    const m = this.measureText('Mg', font);
    if (baseline === 'top') return y + m.ascent;
    if (baseline === 'bottom') return y - m.descent;
    return y + (m.ascent - m.descent) / 2; // 'middle' == the em-box centre
  }

  /** @param {TextStyle} opts */
  textAttrs(x, y, opts) {
    const { align = 'left', fontPx = 14, weight, style, fill, alpha = 1, rotateDeg = 0, label } = opts;
    return [
      `id="${this.id('text')}"`,
      label ? `inkscape:label="${escapeXml(label)}"` : '',
      `x="${num(x)}" y="${num(y)}"`,
      `font-family="${escapeXml(this.fontFamily)}"`,
      `font-size="${num(fontPx)}px"`,
      weight ? `font-weight="${escapeXml(String(weight))}"` : '',
      style ? `font-style="${escapeXml(String(style))}"` : '',
      `text-anchor="${ANCHOR[align] || 'start'}"`,
      paintAttrs('fill', fill || '#000000', alpha),
      rotateDeg ? `transform="rotate(${num(rotateDeg)} ${num(x)} ${num(y)})"` : '',
      'xml:space="preserve"',
    ].filter(Boolean).join(' ');
  }

  /** @param {TextStyle} [opts] */
  text(str, x, y, opts = {}) {
    if (!str) return;
    const { baseline = 'alphabetic', fontPx = 14 } = opts;
    const ty = this.baselineY(y, baseline, opts);
    if (this.culled(x, ty - fontPx * 2, x, ty + fontPx * 2, fontPx * 8)) return;
    this.push(`<text ${this.textAttrs(x, ty, opts)}>${escapeXml(str)}</text>`);
  }

  /** @param {TextStyle} [opts] */
  richText(raw, x, y, opts = {}) {
    if (!raw) return;
    const { fontPx = 14, baseline = 'alphabetic' } = opts;
    const segments = parseLegendSegments(raw).filter((s) => s.text !== '\n');
    if (!segments.length) return;
    const ty = this.baselineY(y, baseline, { fontPx });
    if (this.culled(x, ty - fontPx * 2, x, ty + fontPx * 2, fontPx * 8)) return;
    // dy is cumulative in SVG, so a sup/sub run has to be cancelled by the
    // next tspan or everything after it stays shifted.
    let shift = 0;
    const tspans = segments.map((seg) => {
      const want = seg.script === 'sup' ? -fontPx * SCRIPT_SHIFT
        : seg.script === 'sub' ? fontPx * SCRIPT_SHIFT : 0;
      const dy = want - shift;
      shift = want;
      const attrs = [
        `id="${this.id('tspan')}"`,
        seg.script ? `font-size="${num(fontPx * SCRIPT_SCALE)}px"` : '',
        seg.bold ? 'font-weight="bold"' : '',
        seg.italic ? 'font-style="italic"' : '',
        dy ? `dy="${num(dy)}"` : '',
      ].filter(Boolean).join(' ');
      return `<tspan ${attrs}>${escapeXml(seg.text)}</tspan>`;
    }).join('');
    this.push(`<text ${this.textAttrs(x, ty, { ...opts, fontPx })}>${tspans}</text>`);
  }

  /** Embeds a canvas as a base64 PNG. Inkscape reads xlink:href; browsers and
   *  SVG2 tools read href — emit both. */
  /** @param {PaintStyle} [opts] */
  image(canvasEl, x, y, w, h, opts = {}) {
    const href = canvasEl.toDataURL('image/png');
    const attrs = [
      `id="${this.id('image')}"`,
      opts.label ? `inkscape:label="${escapeXml(opts.label)}"` : '',
      `x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"`,
      'preserveAspectRatio="none" image-rendering="optimizeQuality"',
      `href="${href}" xlink:href="${href}"`,
    ].filter(Boolean).join(' ');
    this.push(`<image ${attrs} />`);
  }

  /** @param {FontSpec} [font]
   *  @returns {ExportTextMetrics} */
  measureText(str, font = {}) {
    const ctx = scratch();
    ctx.font = fontShorthand(font);
    return textMetrics(ctx.measureText(str), font.fontPx || 14);
  }
}
