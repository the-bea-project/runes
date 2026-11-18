// Rune Canvas: a board to draw on, kept as a file in the project (.rux) so that a drawing of
// how something works lives beside the code it explains and is versioned with it.
//
// This module is in two halves. The first is the drawing itself as plain data: reading a file
// (which is never trusted), writing it back in a form that reads well in a diff, and the
// geometry (what is under a point, where an arrow meets a shape). It needs no page and is
// tested as it is. The second half is the <runes-canvas> element: the board on screen.
//
// The file is JSON:
//
//   { "rune": "canvas", "version": 1, "elements": [ { "id": "…", "type": "rect", … }, … ] }
//
// with one element to a line. Colours are names ("ink", "blue"…), not numbers, so that one
// drawing reads well on a dark theme and on a light one. Where the board was scrolled to and
// how far it was zoomed are not in the file: they would change it every time it was looked at.

export const EXTENSION = ".rux";
export const VERSION = 1;

export const SHAPES = ["rect", "diamond", "ellipse"];
export const TYPES = [...SHAPES, "line", "arrow", "draw", "text"];
export const COLOURS = ["ink", "grey", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"];
export const WIDTHS = [1, 2, 4];
export const DASHES = ["solid", "dashed", "dotted"];
// The sizes on offer by name. Writing can be any size between the two bounds: it is scaled
// by pulling its corner, and stepped up and down from the panel.
export const SIZES = [14, 20, 28, 40];
export const SMALLEST = 6, LARGEST = 400;
/** A size for writing: a whole number within bounds, or the usual one for what is not a size. */
export const cleanSize = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(LARGEST, Math.max(SMALLEST, Math.round(value))) : 20);
export const MOST_GROUPS = 8;
export const HEADS = ["none", "end", "both"];
export const ALIGNS = ["left", "center", "right"];

const MOST = 5000, FAR = 1e6;

// What each colour is on a dark ground and on a light one.
export const PALETTE = {
  dark: { ink: "#e8edf2", grey: "#8b98a5", red: "#ff7b85", orange: "#ffa05c", amber: "#ffd166", green: "#5ee0a8", teal: "#4fd6d6", blue: "#7cb7ff", violet: "#b79cff", pink: "#ff8fd0" },
  light: { ink: "#1b2a32", grey: "#667884", red: "#c92a3a", orange: "#c75a12", amber: "#9a6b00", green: "#0b7f55", teal: "#087a91", blue: "#1f5fc4", violet: "#6a45c9", pink: "#b8327f" },
};

const number = (value, fallback, low = -FAR, high = FAR) => (typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback);
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const words = (value, most) => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").slice(0, most) : "");
const round = (n) => Math.round(n * 10) / 10;

let made = 0;
/** A name for a new element: short, and not one the drawing already has. */
export function freshId(taken = new Set()) {
  for (;;) {
    const id = (Date.now() % 46656).toString(36).padStart(3, "0") + (made++ % 1296).toString(36).padStart(2, "0") + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
    if (!taken.has(id)) return id;
  }
}

/** A path inside the project that an element may point to: relative, forward slashes, never climbing out. An optional ":line" at the end. */
export function cleanLink(value) {
  const link = words(value, 400).trim().replace(/\\/g, "/");
  if (!link || link.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.split("/").some((part) => part === ".." || part === "")) return "";
  return link;
}

/** One element made safe: every field is of its kind and within bounds, and nothing else is kept. Null for what is not an element. */
export function cleanElement(raw, taken = new Set()) {
  if (!raw || typeof raw !== "object" || !TYPES.includes(raw.type)) return null;
  const id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) && !taken.has(raw.id) ? raw.id : freshId(taken);
  const el = {
    id, type: raw.type,
    x: round(number(raw.x, 0)), y: round(number(raw.y, 0)), w: round(number(raw.w, 0)), h: round(number(raw.h, 0)),
    stroke: oneOf(raw.stroke, COLOURS, "ink"), fill: oneOf(raw.fill, ["none", ...COLOURS], "none"),
    width: oneOf(raw.width, WIDTHS, 2), dash: oneOf(raw.dash, DASHES, "solid"),
    round: raw.round !== false, sketch: raw.sketch !== false, seed: Math.floor(number(raw.seed, 1, 0, 2 ** 31 - 1)),
    text: words(raw.text, 4000), size: cleanSize(raw.size), align: oneOf(raw.align, ALIGNS, raw.type === "text" ? "left" : "center"),
    link: cleanLink(raw.link),
  };
  // The groups an element is part of, the innermost first: a group can be grouped again.
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).filter((g) => typeof g === "string" && /^[\w-]{1,40}$/.test(g));
  if (groups.length) el.groups = [...new Set(groups)].slice(0, MOST_GROUPS);
  if (el.type === "arrow" || el.type === "line") {
    el.head = oneOf(raw.head, HEADS, el.type === "arrow" ? "end" : "none");
    el.from = typeof raw.from === "string" && /^[\w-]{1,40}$/.test(raw.from) ? raw.from : "";
    el.to = typeof raw.to === "string" && /^[\w-]{1,40}$/.test(raw.to) ? raw.to : "";
    // Where the line bends on its way: points it passes through, in order, on the board.
    el.bends = (Array.isArray(raw.bends) ? raw.bends : []).slice(0, MOST_BENDS)
      .filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [round(number(p[0], 0)), round(number(p[1], 0))]);
  }
  if (el.type === "draw") {
    el.points = (Array.isArray(raw.points) ? raw.points : []).slice(0, 4000)
      .filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [round(number(p[0], 0)), round(number(p[1], 0))]);
    if (el.points.length < 2) return null;
  }
  if (el.type === "text" && !el.text.trim()) return null;
  return el;
}

/**
 * Reads a file's text. An empty file is an empty board. `problem` says why a file could not be
 * read as a drawing (it is then shown as text instead); a drawing with odd things in it is
 * read as far as it makes sense, and the odd things are dropped.
 */
export function parse(text) {
  if (typeof text !== "string" || !text.trim()) return { elements: [], problem: "" };
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { elements: [], problem: "This file is not valid JSON: " + String(e.message).slice(0, 120) }; }
  if (!raw || typeof raw !== "object" || raw.rune !== "canvas" || !Array.isArray(raw.elements)) return { elements: [], problem: "This file is not a Rune Canvas drawing." };
  if (typeof raw.version === "number" && raw.version > VERSION) return { elements: [], problem: "This drawing was made by a newer Runes (format " + raw.version + "). Update Runes to open it." };
  const taken = new Set(), elements = [];
  for (const item of raw.elements.slice(0, MOST)) {
    const el = cleanElement(item, taken);
    if (el) { taken.add(el.id); elements.push(el); }
  }
  // An arrow tied to something that is not there is simply not tied.
  for (const el of elements) {
    if (el.from && !taken.has(el.from)) el.from = "";
    if (el.to && !taken.has(el.to)) el.to = "";
  }
  return { elements, problem: "" };
}

// What is written for each kind, in this order; a field at its usual value is left out.
const USUAL = { stroke: "ink", fill: "none", width: 2, dash: "solid", round: true, sketch: true, text: "", size: 20, link: "", from: "", to: "" };
const ORDER = ["id", "type", "x", "y", "w", "h", "bends", "points", "text", "size", "align", "stroke", "fill", "width", "dash", "round", "sketch", "head", "from", "to", "link", "groups", "seed"];

/** The drawing as the text of its file: one element to a line, fields in a fixed order, so a change shows as a small diff. */
export function serialize(elements) {
  const lines = elements.map((el) => {
    const out = {};
    for (const key of ORDER) {
      if (!(key in el)) continue;
      if (key in USUAL && el[key] === USUAL[key]) continue;
      if (key === "align" && el.align === (el.type === "text" ? "left" : "center")) continue;
      if (key === "head" && el.head === (el.type === "arrow" ? "end" : "none")) continue;
      if (key === "bends" && !el.bends?.length) continue;
      if (key === "groups" && !el.groups?.length) continue;
      if ((key === "size" || key === "align") && !el.text) continue;
      if (key === "round" && !SHAPES.includes(el.type)) continue;
      if (key === "fill" && !SHAPES.includes(el.type)) continue;
      if ((key === "w" || key === "h") && el.type === "text") continue;
      out[key] = el[key];
    }
    return "    " + JSON.stringify(out);
  });
  return '{\n  "rune": "canvas",\n  "version": ' + VERSION + ',\n  "elements": [' + (lines.length ? "\n" + lines.join(",\n") + "\n  " : "") + "]\n}\n";
}

// --- Geometry -------------------------------------------------------------------------------------

/** The box an element takes up: { x, y, w, h } with w and h not negative. `measure(el)` gives a text's size. */
export function box(el, measure) {
  if (el.type === "text") { const m = measure ? measure(el) : { w: el.w || 10, h: el.h || el.size * 1.3 }; return { x: el.x, y: el.y, w: m.w, h: m.h }; }
  if (el.type === "draw") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of el.points) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
    return { x: el.x + x0, y: el.y + y0, w: x1 - x0, h: y1 - y0 };
  }
  if (el.bends?.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of traced(el)) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
}

// --- Lines that bend ---------------------------------------------------------------------------------
// A line or arrow runs from (x, y) to (x + w, y + h). With `bends`, it passes through each of
// those points on the way, as one smooth curve.

export const MOST_BENDS = 24;
const isLine = (el) => el.type === "line" || el.type === "arrow";

/** The points a line passes through: its start, its bends, its end. */
export const nodes = (el) => [[el.x, el.y], ...(el.bends ?? []), [el.x + el.w, el.y + el.h]];

/** The control points of the smooth curve through `p`, piece by piece: [from, c1, c2, to]. */
function pieces(p) {
  const out = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] ?? p[i + 1];
    out.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return out;
}
const along = ([a, b, c, d], t) => {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
};

/** A line as many short straight pieces: for telling what is under a point, and how much room it takes. */
export function traced(el, steps = 10) {
  const p = nodes(el);
  if (p.length === 2) return p;
  const out = [p[0]];
  for (const piece of pieces(p)) for (let i = 1; i <= steps; i++) out.push(along(piece, i / steps));
  return out;
}

/** The middle of each stretch between two of a line's points: where a new bend can be pulled out. */
export function middles(el) {
  const p = nodes(el);
  if (p.length === 2) return [[el.x + el.w / 2, el.y + el.h / 2]];
  return pieces(p).map((piece) => along(piece, 0.5));
}

/** The middle of the whole line, for its label. */
export function middle(el) {
  const p = traced(el, 12);
  if (p.length === 2) return [el.x + el.w / 2, el.y + el.h / 2];
  let total = 0;
  const lengths = [];
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); lengths.push(d); total += d; }
  let half = total / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (half <= lengths[i]) { const t = lengths[i] ? half / lengths[i] : 0; return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t]; }
    half -= lengths[i];
  }
  return p[p.length - 1];
}

/** The line with a new bend at a point, in the stretch after its `after`-th point (0 is the start). */
export function bendAdded(el, after, x, y) {
  const bends = [...(el.bends ?? [])];
  if (bends.length >= MOST_BENDS) return el;
  bends.splice(Math.max(0, Math.min(after, bends.length)), 0, [round(x), round(y)]);
  return { ...el, bends };
}
export function bendMoved(el, index, x, y) {
  if (!el.bends || index < 0 || index >= el.bends.length) return el;
  return { ...el, bends: el.bends.map((b, i) => (i === index ? [round(x), round(y)] : b)) };
}
export function bendRemoved(el, index) {
  if (!el.bends || index < 0 || index >= el.bends.length) return el;
  return { ...el, bends: el.bends.filter((_, i) => i !== index) };
}
/** Whether a bend adds nothing: it lies on the straight way between its neighbours. */
export function bendIsStraight(el, index, slack = 5) {
  const p = nodes(el);
  const a = p[index], b = p[index + 1], c = p[index + 2];
  return !!(a && b && c) && toSegment(b[0], b[1], a[0], a[1], c[0], c[1]) <= slack;
}

/** An element moved by (dx, dy): a line takes its bends with it. */
export function shifted(el, dx, dy) {
  const next = { ...el, x: el.x + dx, y: el.y + dy };
  if (el.bends?.length) next.bends = el.bends.map(([bx, by]) => [bx + dx, by + dy]);
  return next;
}

/**
 * A line as a path: through its bends in one smooth curve. Drawn by hand it is gone over
 * twice, not quite in the same place; `sketch` off gives the curve exactly.
 */
export function strokeCurve(el, random, sketch) {
  const p = nodes(el);
  if (p.length === 2) return strokeLine(p[0][0], p[0][1], p[1][0], p[1][1], random, sketch);
  let d = "";
  for (let pass = 0; pass < (sketch ? 2 : 1); pass++) {
    const j = sketch ? () => (random() - 0.5) * 2.4 : () => 0;
    const moved = p.map(([px, py], i) => (i === 0 || i === p.length - 1 ? [px + j() * 0.6, py + j() * 0.6] : [px + j(), py + j()]));
    const parts = pieces(moved);
    d += `M${f(parts[0][0][0])} ${f(parts[0][0][1])}`;
    for (const [, c1, c2, to] of parts) d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(to[0])} ${f(to[1])}`;
  }
  return d;
}

/** Where a line is coming from as it arrives at its end (or sets out from its start): for the arrowhead. */
export function approach(el, atEnd) {
  const p = traced(el, 10);
  return atEnd ? p[p.length - 2] : p[1];
}

/** The box around several elements, or null for none. */
export function around(elements, measure) {
  if (!elements.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of elements) { const b = box(el, measure); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const toSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * Whether a point touches an element. An outline is touched on its line; a shape that is
 * filled, or has writing in it, is touched anywhere inside. `near` is how close counts.
 */
export function hits(el, px, py, near = 6, measure) {
  const b = box(el, measure);
  const reach = near + (el.width ?? 2) / 2;
  if (px < b.x - reach || py < b.y - reach || px > b.x + b.w + reach || py > b.y + b.h + reach) return false;
  if (el.type === "text") return true;
  if (el.type === "line" || el.type === "arrow") {
    const p = traced(el);
    for (let i = 1; i < p.length; i++) if (toSegment(px, py, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= reach) return true;
    return false;
  }
  if (el.type === "draw") {
    for (let i = 1; i < el.points.length; i++) {
      if (toSegment(px, py, el.x + el.points[i - 1][0], el.y + el.points[i - 1][1], el.x + el.points[i][0], el.y + el.points[i][1]) <= reach) return true;
    }
    return false;
  }
  const solid = el.fill !== "none" || !!el.text;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, hw = Math.max(b.w / 2, 0.01), hh = Math.max(b.h / 2, 0.01);
  if (el.type === "rect") {
    if (solid) return true;
    return !(px > b.x + reach && px < b.x + b.w - reach && py > b.y + reach && py < b.y + b.h - reach);
  }
  if (el.type === "ellipse") {
    const d = Math.hypot((px - cx) / hw, (py - cy) / hh);
    const slack = reach / Math.min(hw, hh);
    return solid ? d <= 1 + slack : Math.abs(d - 1) <= slack;
  }
  // A diamond: |dx|/hw + |dy|/hh is 1 on its outline.
  const d = Math.abs(px - cx) / hw + Math.abs(py - cy) / hh;
  const slack = reach / Math.min(hw, hh);
  return solid ? d <= 1 + slack : Math.abs(d - 1) <= slack;
}

/** The topmost element under a point (the last drawn is on top), or null. */
export function elementAt(elements, px, py, near, measure) {
  for (let i = elements.length - 1; i >= 0; i--) if (hits(elements[i], px, py, near, measure)) return elements[i];
  return null;
}

/** Where a line from a shape's middle towards a point leaves the shape, a little way out (`gap`). */
export function edgeToward(el, tx, ty, gap = 6, measure) {
  const b = box(el, measure);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, hw = b.w / 2 + gap, hh = b.h / 2 + gap;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy - hh];
  let t;
  if (el.type === "ellipse") t = 1 / Math.hypot(dx / hw, dy / hh);
  else if (el.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/**
 * Arrows and lines tied to shapes are redrawn to meet them: after anything moves, each tied
 * end goes to the edge of its shape, on the way to the other end. Returns the elements, with
 * new objects only for the lines that changed.
 */
export function retie(elements, measure) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  return elements.map((el) => {
    if ((el.type !== "arrow" && el.type !== "line") || (!el.from && !el.to)) return el;
    const a = byId.get(el.from), b = byId.get(el.to);
    if (!a && !b) return el.from || el.to ? { ...el, from: "", to: "" } : el;
    const centre = (s) => { const k = box(s, measure); return [k.x + k.w / 2, k.y + k.h / 2]; };
    let start = [el.x, el.y], end = [el.x + el.w, el.y + el.h];
    // Each tied end leaves its shape towards the other end, or towards the first bend on the way.
    const bends = el.bends ?? [];
    const aim = bends.length ? bends[bends.length - 1] : a ? centre(a) : start, target = bends.length ? bends[0] : b ? centre(b) : end;
    if (a) start = edgeToward(a, target[0], target[1], 6, measure);
    if (b) end = edgeToward(b, aim[0], aim[1], 6, measure);
    const next = { ...el, x: round(start[0]), y: round(start[1]), w: round(end[0] - start[0]), h: round(end[1] - start[1]), from: a ? el.from : "", to: b ? el.to : "" };
    return next.x === el.x && next.y === el.y && next.w === el.w && next.h === el.h && next.from === el.from && next.to === el.to ? el : next;
  });
}

/** A freehand stroke with the points that add nothing taken out (Ramer–Douglas–Peucker). */
export function simplify(points, tolerance = 1.2) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = toSegment(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1]);
      if (d > far) { far = d; at = i; }
    }
    if (far > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Moves and scales an element from one box to another: how a selection is resized. */
export function fit(el, from, to) {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const next = { ...el, x: round(to.x + (el.x - from.x) * sx), y: round(to.y + (el.y - from.y) * sy) };
  if (el.type === "draw") next.points = el.points.map(([px, py]) => [round(px * sx), round(py * sy)]);
  else if (el.type !== "text") { next.w = round(el.w * sx); next.h = round(el.h * sy); }
  // Writing has no box of its own to stretch: it is made larger or smaller, by the lesser
  // of the two ways the box changed, so that it still fits where it was.
  else next.size = cleanSize(el.size * Math.min(sx, sy));
  if (el.bends?.length) next.bends = el.bends.map(([bx, by]) => [round(to.x + (bx - from.x) * sx), round(to.y + (by - from.y) * sy)]);
  return next;
}

// --- Groups --------------------------------------------------------------------------------------
// Elements that are grouped are chosen, moved, copied and resized as one. Each carries the
// names of the groups it is in, innermost first, so a group can itself be part of a group.

/** The group an element is chosen with: its outermost, or "" when it is in none. */
export const groupOf = (el) => el.groups?.[el.groups.length - 1] ?? "";

/** A choice of elements, made whole: everything grouped with any of them is chosen with it. */
export function withGroups(elements, ids) {
  const picked = new Set(ids), groups = new Set();
  for (const el of elements) if (picked.has(el.id) && groupOf(el)) groups.add(groupOf(el));
  if (!groups.size) return picked;
  for (const el of elements) if (groups.has(groupOf(el))) picked.add(el.id);
  return picked;
}

/** Whether the chosen elements are exactly one group, whole. */
export function isGroup(elements, ids) {
  const chosen = elements.filter((el) => ids.has(el.id));
  const name = chosen.length > 1 ? groupOf(chosen[0]) : "";
  return !!name && chosen.every((el) => groupOf(el) === name) && elements.filter((el) => groupOf(el) === name).length === chosen.length;
}

/** The elements with the chosen ones made one group named `name`. Fewer than two is no group. */
export function grouped(elements, ids, name) {
  const chosen = elements.filter((el) => ids.has(el.id));
  if (chosen.length < 2 || !/^[\w-]{1,40}$/.test(name) || chosen.some((el) => (el.groups?.length ?? 0) >= MOST_GROUPS)) return elements;
  return elements.map((el) => (ids.has(el.id) ? { ...el, groups: [...(el.groups ?? []), name] } : el));
}

/** The elements with the chosen ones taken out of their outermost group: its parts are themselves again. */
export function ungrouped(elements, ids) {
  return elements.map((el) => {
    if (!ids.has(el.id) || !el.groups?.length) return el;
    const { groups, ...rest } = el;
    return groups.length > 1 ? { ...rest, groups: groups.slice(0, -1) } : rest;
  });
}

/** Copies of elements keep their grouping among themselves, under names of their own: a copy is not part of the group it was copied from. */
export function regrouped(items, taken = new Set()) {
  const names = new Map();
  return items.map((el) => {
    if (!el.groups?.length) return el;
    return { ...el, groups: el.groups.map((g) => { if (!names.has(g)) { const name = freshId(taken); taken.add(name); names.set(g, name); } return names.get(g); }) };
  });
}

// --- The look of a hand-drawn line ---

/** Numbers that look random and are the same every time for the same seed: a drawing must not shimmer as it is redrawn. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const f = (n) => Math.round(n * 100) / 100;

/** A line from a to b as a hand would draw it: not quite straight, and gone over twice. Clean when `sketch` is off. */
export function strokeLine(ax, ay, bx, by, random, sketch) {
  if (!sketch) return `M${f(ax)} ${f(ay)}L${f(bx)} ${f(by)}`;
  const length = Math.hypot(bx - ax, by - ay);
  const wobble = Math.min(2.2, 0.6 + length / 200), bow = Math.min(6, length / 40);
  let d = "";
  for (let pass = 0; pass < 2; pass++) {
    const j = () => (random() - 0.5) * 2 * wobble;
    const nx = -(by - ay) / (length || 1), ny = (bx - ax) / (length || 1);
    const k = (random() - 0.5) * 2 * bow;
    d += `M${f(ax + j())} ${f(ay + j())}Q${f((ax + bx) / 2 + nx * k + j())} ${f((ay + by) / 2 + ny * k + j())} ${f(bx + j())} ${f(by + j())}`;
  }
  return d;
}

/** The outline of a shape as a path. */
export function outline(el, random) {
  const b = box(el);
  const { x, y, w, h } = b;
  if (el.type === "ellipse") {
    const cx = x + w / 2, cy = y + h / 2;
    if (!el.sketch) return `M${f(x)} ${f(cy)}A${f(w / 2)} ${f(h / 2)} 0 1 0 ${f(x + w)} ${f(cy)}A${f(w / 2)} ${f(h / 2)} 0 1 0 ${f(x)} ${f(cy)}Z`;
    let d = "";
    for (let pass = 0; pass < 2; pass++) {
      const n = 14, start = random() * Math.PI * 2, points = [];
      const wobble = Math.min(2, 0.5 + Math.max(w, h) / 220);
      for (let i = 0; i < n; i++) {
        const t = start + (i / n) * Math.PI * 2;
        points.push([cx + Math.cos(t) * (w / 2 + (random() - 0.5) * 2 * wobble), cy + Math.sin(t) * (h / 2 + (random() - 0.5) * 2 * wobble)]);
      }
      // A smooth closed curve through the points.
      for (let i = 0; i < n; i++) {
        const p0 = points[(i + n - 1) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
        if (i === 0) d += `M${f(p1[0])} ${f(p1[1])}`;
        d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
      }
    }
    return d;
  }
  if (el.type === "diamond") {
    const top = [x + w / 2, y], right = [x + w, y + h / 2], bottom = [x + w / 2, y + h], left = [x, y + h / 2];
    if (!el.sketch) return `M${f(top[0])} ${f(top[1])}L${f(right[0])} ${f(right[1])}L${f(bottom[0])} ${f(bottom[1])}L${f(left[0])} ${f(left[1])}Z`;
    return [[top, right], [right, bottom], [bottom, left], [left, top]].map(([a, c]) => strokeLine(a[0], a[1], c[0], c[1], random, true)).join("");
  }
  const r = el.round ? Math.min(12, w / 4, h / 4) : 0;
  if (!el.sketch) {
    if (!r) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
    return `M${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}H${f(x + r)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z`;
  }
  const sides = [[x + r, y, x + w - r, y], [x + w, y + r, x + w, y + h - r], [x + w - r, y + h, x + r, y + h], [x, y + h - r, x, y + r]];
  const corners = [[x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  let d = "";
  sides.forEach(([ax, ay, bx, by], i) => {
    d += strokeLine(ax, ay, bx, by, random, true);
    if (r) { const next = sides[(i + 1) % 4]; d += `M${f(bx)} ${f(by)}Q${f(corners[i][0])} ${f(corners[i][1])} ${f(next[0])} ${f(next[1])}`; }
  });
  return d;
}

/** The same outline, exact, for filling and for telling inside from outside. */
export const cleanOutline = (el) => outline({ ...el, sketch: false });

/** A freehand stroke as a smooth path through its points. */
export function strokePath(el) {
  const p = el.points.map(([px, py]) => [el.x + px, el.y + py]);
  if (p.length === 2) return `M${f(p[0][0])} ${f(p[0][1])}L${f(p[1][0])} ${f(p[1][1])}`;
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) d += `Q${f(p[i][0])} ${f(p[i][1])} ${f((p[i][0] + p[i + 1][0]) / 2)} ${f((p[i][1] + p[i + 1][1]) / 2)}`;
  return d + `L${f(p[p.length - 1][0])} ${f(p[p.length - 1][1])}`;
}

/** The two strokes of an arrowhead at (x, y), for a line arriving from (fx, fy). */
export function arrowHead(x, y, fx, fy, size, random, sketch) {
  const angle = Math.atan2(y - fy, x - fx), spread = 0.45;
  const wing = (turn) => [x - Math.cos(angle + turn) * size, y - Math.sin(angle + turn) * size];
  const [a, b] = [wing(spread), wing(-spread)];
  return strokeLine(a[0], a[1], x, y, random, sketch) + strokeLine(b[0], b[1], x, y, random, sketch);
}

/** Text broken into lines no wider than `width`, by `wide(text)`, a measure of a line's width. Long words are kept whole. */
export function wrap(text, width, wide) {
  const out = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (line && !/^\s+$/.test(word) && wide((line + word).trimEnd()) > width) { out.push(line.trimEnd()); line = ""; }
      if (!line && /^\s+$/.test(word)) continue;
      line += word;
    }
    out.push(line.trimEnd());
  }
  return out;
}
