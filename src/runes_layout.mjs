// Where text stands: how wide its characters are, where a long line wraps, which lines a fold
// hides, how deep a line is indented, and what Enter should do after it. No DOM here: all of
// it is arithmetic on lines of text, so it can be tested under Node.
//
// Columns count UTF-16 units, as the rest of the editor does. A "cell" is the width of one
// ordinary character; a tab runs to the next tab stop, and wide characters (CJK, emoji) take two.

let TAB = 4;
export const tab_size = () => TAB;
export function set_tab(n) { TAB = Math.max(1, Math.min(16, n | 0)) || 4; plainCache.clear(); }

// --- Characters --------------------------------------------------------------------------------

const ASCII = /^[\x20-\x7e]*$/;
const WIDE = /[ᄀ-ᅟ⌚⌛〈〉⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const NOTHING = /^[​-‏⁠﻿­]+$/;
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** How many cells one character (a whole grapheme: an emoji with its joiners, a letter with its accents) takes. */
export function cell_width(cluster) {
  if (cluster.length === 1 && cluster.charCodeAt(0) < 0x1100) return 1;
  if (NOTHING.test(cluster)) return 0;
  // An emoji shown as a picture (U+FE0F asks for that), a flag, or anything wide.
  return WIDE.test(cluster) || cluster.includes("️") || /[\u{1F1E6}-\u{1F1FF}]/u.test(cluster) ? 2 : 1;
}

/** Whether a character may not be as wide as the font's own, so that it is given a cell of its own to sit in. */
export function odd(cluster) {
  const c = cluster.codePointAt(0);
  if (c < 0x2000) return cluster.length > 2;
  // Box drawing, blocks and the Nerd Font's own signs are the font's, at one cell.
  if ((c >= 0x2500 && c <= 0x259F) || (c >= 0xE000 && c <= 0xF8FF) || (c >= 0xF0000 && c <= 0x10FFFF)) return false;
  // Typographic quotes, dashes and the like: one cell in any monospace font.
  if (c >= 0x2010 && c <= 0x2027) return false;
  return true;
}

// A line's characters: where each starts (UTF-16), and how many cells it takes. Lines of
// plain ASCII without tabs need none of this, and are never measured.
const plainCache = new Map();
function measured(text) {
  let m = plainCache.get(text);
  if (m) return m;
  const starts = [], widths = [];
  if (segmenter && !/^[\x00-˿]*$/.test(text)) {
    for (const part of segmenter.segment(text)) { starts.push(part.index); widths.push(part.segment === "\t" ? -1 : cell_width(part.segment)); }
  } else {
    for (let i = 0; i < text.length; i++) { starts.push(i); widths.push(text[i] === "\t" ? -1 : 1); }
  }
  starts.push(text.length);
  m = { starts, widths };
  if (plainCache.size > 4000) plainCache.clear();
  plainCache.set(text, m);
  return m;
}
const simple = (text) => ASCII.test(text);

/** The cells between two columns of a line, tab stops counted from `from`. */
export function cells(text, from, to) {
  if (to <= from) return 0;
  if (simple(text)) return Math.min(to, text.length) - Math.min(from, text.length);
  const { starts, widths } = measured(text);
  let v = 0;
  for (let i = 0; i < widths.length; i++) {
    if (starts[i] < from) continue;
    if (starts[i] >= to) break;
    v += widths[i] < 0 ? TAB - (v % TAB) : widths[i];
  }
  return v;
}

/** The visual column of a column. */
export const vcol = (text, col) => cells(text, 0, col);

/** The column nearest to a number of cells past `from`, never beyond `to`. */
export function col_in(text, from, to, target) {
  to = Math.min(to, text.length);
  if (simple(text)) return Math.max(from, Math.min(to, from + Math.round(target)));
  const { starts, widths } = measured(text);
  let v = 0;
  for (let i = 0; i < widths.length; i++) {
    if (starts[i] < from) continue;
    if (starts[i] >= to) return to;
    const w = widths[i] < 0 ? TAB - (v % TAB) : widths[i];
    if (v + w / 2 > target) return starts[i];
    v += w;
  }
  return to;
}
export const col_at = (text, target) => col_in(text, 0, text.length, target);

/** The next place a cursor can stand, left or right of a column: never inside a character. */
export function step(text, col, forward) {
  if (simple(text)) return Math.max(0, Math.min(text.length, col + (forward ? 1 : -1)));
  const { starts } = measured(text);
  if (forward) { for (const s of starts) if (s > col) return s; return text.length; }
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < col) return starts[i];
  return 0;
}

/**
 * Coloured pieces of a line, between two columns, with every character that may not be one
 * cell wide given a box of exactly its cells: so what is drawn stands where it is counted.
 * A piece is [text, style].
 */
export function fitted(pieces, text, from, to) {
  const whole = from <= 0 && to >= text.length;
  if (whole && simple(text)) return pieces;
  const out = [];
  let at = 0;
  const plain = /^[\x00-῿]*$/.test(text);
  for (const [piece, style] of pieces) {
    const start = Math.max(at, from), end = Math.min(at + piece.length, to);
    const begins = at;
    at += piece.length;
    if (end <= start) continue;
    const part = piece.slice(start - begins, end - begins);
    if (plain || !segmenter) { out.push([part, style]); continue; }
    let run = "";
    for (const { segment } of segmenter.segment(part)) {
      if (segment.codePointAt(0) < 0x2000 && segment.length <= 2) { run += segment; continue; }
      const w = cell_width(segment);
      if (!odd(segment) && w === 1) { run += segment; continue; }
      if (run) { out.push([run, style]); run = ""; }
      out.push([segment, (style ? style + ";" : "") + `display:inline-block;width:${w}ch;text-align:center;overflow:hidden;vertical-align:top;height:var(--row)`]);
    }
    if (run) out.push([run, style]);
  }
  return out;
}

// --- Indentation ---------------------------------------------------------------------------------

const lead = (text) => /^[ \t]*/.exec(text)[0];

/** How a file is indented, going by its lines: "\t", some spaces, or "" when it does not say. */
export function detect_indent(lines) {
  let tabs = 0, spaced = 0, previous = 0;
  const steps = new Map();
  let seen = 0;
  for (const text of lines) {
    if (seen++ > 4000) break;
    if (!text.trim()) continue;
    const indent = lead(text);
    if (indent.includes("\t")) { tabs += 1; previous = 0; continue; }
    const n = indent.length;
    if (n) spaced += 1;
    const by = Math.abs(n - previous);
    if (by > 1 && by <= 8) steps.set(by, (steps.get(by) ?? 0) + 1);
    previous = n;
  }
  if (tabs > spaced) return "\t";
  if (!spaced) return "";
  let best = 0, most = 0;
  for (const [by, count] of steps) if (count > most || (count === most && by < best)) { best = by; most = count; }
  return best ? " ".repeat(best) : "";
}

// A language's configuration file, read once: its rules for Enter and for indentation.
const rulesCache = new Map();
const regex = (r) => {
  try { return r == null ? null : typeof r === "string" ? new RegExp(r) : new RegExp(r.pattern, (r.flags ?? "").replace(/[^imsu]/g, "")); }
  catch { return null; }
};
function rulesOf(source) {
  let rules = rulesCache.get(source);
  if (rules) return rules;
  rules = { enter: [], increase: null, decrease: null, brackets: [["{", "}"], ["[", "]"], ["(", ")"]] };
  try {
    const json = JSON.parse(source || "{}");
    if (Array.isArray(json.brackets)) rules.brackets = json.brackets.filter((b) => Array.isArray(b) && typeof b[0] === "string" && typeof b[1] === "string" && b[0] && b[1]).map((b) => [b[0], b[1]]);
    for (const rule of Array.isArray(json.onEnterRules) ? json.onEnterRules : []) {
      const before = regex(rule.beforeText);
      if (!before) continue;
      rules.enter.push({ before, after: regex(rule.afterText), above: regex(rule.previousLineText), action: rule.action ?? {} });
    }
    rules.increase = regex(json.indentationRules?.increaseIndentPattern);
    rules.decrease = regex(json.indentationRules?.decreaseIndentPattern);
  } catch {}
  if (rulesCache.size > 200) rulesCache.clear();
  rulesCache.set(source, rules);
  return rules;
}
const ACTIONS = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

/**
 * A language's rules with more laid over them: what an extension says as it runs comes
 * before what the language's own file says. Both are JSON text; so is what comes back.
 */
export function merge_rules(source, extra) {
  let base = {}, more = {};
  try { base = JSON.parse(source || "{}") ?? {}; } catch {}
  try { more = JSON.parse(extra || "{}") ?? {}; } catch { return source; }
  const merged = { ...base };
  if (Array.isArray(more.onEnterRules)) merged.onEnterRules = [...more.onEnterRules, ...(Array.isArray(base.onEnterRules) ? base.onEnterRules : [])].slice(0, 400);
  if (more.indentationRules) merged.indentationRules = { ...(base.indentationRules ?? {}), ...Object.fromEntries(Object.entries(more.indentationRules).filter(([, v]) => v != null)) };
  if (Array.isArray(more.brackets) && more.brackets.length) merged.brackets = more.brackets;
  return JSON.stringify(merged);
}

/**
 * What Enter does, given the text before and after the cursor on its line and the line above:
 * [how, text to add, characters of indentation to take away]. `how` is 0 keep the indentation,
 * 1 one step deeper, 2 deeper with what follows the cursor put back at the old depth below
 * (between a pair of brackets), 3 one step back.
 */
export function enter_rule(source, before, after, above) {
  const rules = rulesOf(source);
  for (const rule of rules.enter) {
    if (!rule.before.test(before)) continue;
    if (rule.after && !rule.after.test(after)) continue;
    if (rule.above && !rule.above.test(above)) continue;
    const how = ACTIONS[rule.action.indent ?? rule.action.indentAction] ?? 0;
    return [how, String(rule.action.appendText ?? ""), Number(rule.action.removeText) || 0];
  }
  const left = before.trimEnd(), right = after.trimStart();
  for (const [open, close] of rules.brackets) {
    if (!left.endsWith(open)) continue;
    return [right.startsWith(close) ? 2 : 1, "", 0];
  }
  if (rules.increase?.test(before)) return [1, "", 0];
  return [0, "", 0];
}

/** Whether a line, as just typed, is one the language draws back a step (`}`, `else:`, `end`). */
export function outdents(source, text) {
  const rules = rulesOf(source);
  if (rules.decrease) return rules.decrease.test(text);
  const trimmed = text.trim();
  return rules.brackets.some(([, close]) => trimmed === close);
}

/** The bracket that pairs with the one at (or just before) a place: [found, line, col, line, col]. */
export function bracket_pair(lines, line, col, source) {
  const all = Array.isArray(lines) ? lines : lines.toArray();
  const { brackets } = rulesOf(source);
  const text = all[line] ?? "";
  const tryAt = (c) => {
    if (c < 0 || c >= text.length) return null;
    for (const [open, close] of brackets) {
      if (open.length !== 1 || close.length !== 1 || open === close) continue;
      if (text[c] === open) return seek(all, line, c, open, close, 1);
      if (text[c] === close) return seek(all, line, c, close, open, -1);
    }
    return null;
  };
  const found = tryAt(col) ?? tryAt(col - 1);
  return found ? [true, ...found] : [false, 0, 0, 0, 0];
}
function seek(all, line, col, self, other, dir) {
  let depth = 0, seen = 0;
  for (let l = line; l >= 0 && l < all.length; l += dir) {
    const text = all[l];
    for (let c = l === line ? col : dir > 0 ? 0 : text.length - 1; c >= 0 && c < text.length; c += dir) {
      if (++seen > 400000) return null;
      if (text[c] === self) depth += 1;
      else if (text[c] === other && --depth === 0) return dir > 0 ? [line, col, l, c] : [l, c, line, col];
    }
  }
  return null;
}

// --- Folding, and how deep each line is ------------------------------------------------------------

const tables = new Map();
/**
 * For every line: how many cells it is indented (blank lines take the lesser of their
 * neighbours', as the guides run through them), and the last line of the block it opens (-1
 * when it opens none). A block is the lines indented deeper than the one above them.
 */
export function shape(key, version, lines) {
  const kept = tables.get(key);
  if (kept && kept.version === version && kept.tab === TAB) return kept;
  const all = Array.isArray(lines) ? lines : lines.toArray();
  const n = all.length;
  const depth = new Int32Array(n), ends = new Int32Array(n).fill(-1), blank = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const text = all[i];
    if (!text.trim()) { blank[i] = 1; continue; }
    depth[i] = cells(text, 0, lead(text).length);
  }
  // Blank lines: as deep as the shallower of the lines around them.
  let above = 0;
  for (let i = 0; i < n; i++) {
    if (!blank[i]) { above = depth[i]; continue; }
    let j = i; while (j < n && blank[j]) j++;
    const below = j < n ? depth[j] : 0;
    for (let k = i; k < j; k++) depth[k] = Math.min(above, below);
    i = j - 1;
  }
  // Each line's block ends before the next line that is no deeper than it.
  const open = [];
  let lastText = -1;
  for (let i = 0; i < n; i++) {
    if (blank[i]) continue;
    while (open.length && depth[open[open.length - 1]] >= depth[i]) {
      const start = open.pop();
      if (lastText > start) ends[start] = lastText;
    }
    open.push(i);
    lastText = i;
  }
  for (const start of open) if (lastText > start) ends[start] = lastText;
  const table = { version, tab: TAB, depth, ends, blank, n };
  if (tables.size > 60) tables.delete(tables.keys().next().value);
  tables.set(key, table);
  return table;
}
export const fold_end = (table, line) => (line >= 0 && line < table.n ? table.ends[line] : -1);
export const depth_of = (table, line) => (line >= 0 && line < table.n ? table.depth[line] : 0);
/** The line that opens the innermost block a line is in, or -1. */
export function block_of(table, line) {
  for (let i = Math.min(line, table.n - 1); i >= 0; i--) if (table.ends[i] >= line && (i < line || table.ends[i] > line)) return i;
  return -1;
}
/** Every line that opens a block, for "fold all": [start, end] pairs, outermost only. */
export function all_blocks(table) {
  const out = [];
  for (let i = 0; i < table.n; i++) if (table.ends[i] > i) { out.push([i, table.ends[i]]); i = table.ends[i]; }
  return out;
}

/**
 * What an edit does to the folds of a file: those above the change stay, those below move
 * with the lines, and one the change reaches into opens. Folds are [start, end] pairs.
 */
export function folds_after(folds, before, after) {
  const a = Array.isArray(before) ? before : before.toArray(), b = Array.isArray(after) ? after : after.toArray();
  if (!folds.length) return folds;
  let first = 0;
  const max = Math.min(a.length, b.length);
  while (first < max && a[first] === b[first]) first++;
  let tail = 0;
  while (tail < max - first && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const oldEnd = a.length - tail, by = b.length - a.length;
  const out = [];
  for (const [s, e] of folds) {
    if (e < first) out.push([s, e]);
    else if (s >= oldEnd) out.push([s + by, e + by]);
    // A change on the opening line alone leaves what is folded under it as it was.
    else if (s === first && oldEnd <= s + 1 && by === 0) out.push([s, e]);
  }
  return out;
}

// --- Layout: from lines to the rows that are drawn ---------------------------------------------------

/** Where a line wraps, at `width` cells: the columns its rows start at. Breaks after a space when there is one. */
export function wrap_points(text, width) {
  if (width <= 0 || (simple(text) && text.length <= width)) return null;
  const { starts, widths } = measured(text);
  const points = [0];
  let v = 0, lastBreak = -1;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i] < 0 ? TAB - (v % TAB) : widths[i];
    if (v + w > width && starts[i] > points[points.length - 1]) {
      const from = points[points.length - 1];
      const at = lastBreak > from ? lastBreak : starts[i];
      points.push(at);
      // Start the new row and count again what has already been put on it.
      v = 0;
      for (let j = starts.indexOf(at); j < i; j++) v += widths[j] < 0 ? TAB - (v % TAB) : widths[j];
      lastBreak = -1;
    }
    v += widths[i] < 0 ? TAB - (v % TAB) : widths[i];
    const ch = text[starts[i]];
    if (ch === " " || ch === "\t") lastBreak = starts[i + 1];
  }
  return points.length > 1 ? points : null;
}

const current = new Map();
/**
 * How a file is laid out in one editor: `wrap` cells to a row (0 for no wrapping), and the
 * folds, as [first hidden line - 1, last hidden line] pairs. Kept until any of that changes.
 */
export function layout(group, key, version, lines, wrap, folds) {
  const folded = (Array.isArray(folds) ? folds : folds.toArray()).map((f) => (Array.isArray(f) ? f : [f[0], f[1]]));
  const sign = folded.map((f) => f[0] + "-" + f[1]).join(",");
  const kept = current.get(group);
  if (kept && kept.key === key && kept.version === version && kept.wrap === wrap && kept.sign === sign && kept.tab === TAB) return kept;
  const all = Array.isArray(lines) ? lines : lines.toArray();
  const n = all.length;
  const made = { group, key, version, wrap, sign, tab: TAB, all, n, plain: !wrap && !folded.length, rows: n, folded };
  if (!made.plain) {
    const hidden = new Uint8Array(n);
    for (const [s, e] of folded) for (let i = Math.max(0, s + 1); i <= e && i < n; i++) hidden[i] = 1;
    const top = new Int32Array(n + 1);
    const segs = new Map();
    const vis = [];
    let row = 0;
    for (let i = 0; i < n; i++) {
      top[i] = hidden[i] ? Math.max(0, row - 1) : row;
      if (hidden[i]) continue;
      vis.push(i);
      const points = wrap ? wrap_points(all[i], wrap) : null;
      if (points) segs.set(i, points);
      row += points ? points.length : 1;
    }
    top[n] = row;
    Object.assign(made, { hidden, top, segs, vis, rows: row });
  }
  current.set(group, made);
  return made;
}
export const layout_of = (group) => current.get(Number(group)) ?? current.get(String(group)) ?? null;
export const layout_rows = (l) => l.rows;
export const is_hidden = (l, line) => !l.plain && !!l.hidden[line];

const segment = (l, line, col) => {
  const points = l.plain ? null : l.segs.get(line);
  if (!points) return [0, 0, Infinity];
  let k = points.length - 1;
  while (k > 0 && points[k] > col) k--;
  return [k, points[k], k + 1 < points.length ? points[k + 1] : Infinity];
};
/** The row a place is drawn on, and how many cells from the row's left edge. */
export function spot(l, line, col) {
  if (l.plain) return [line, vcol(l.all[line] ?? "", col)];
  line = Math.max(0, Math.min(line, l.n - 1));
  if (l.hidden[line]) return [l.top[line], 0];
  const [k, from] = segment(l, line, col);
  return [l.top[line] + k, cells(l.all[line] ?? "", from, col)];
}
/** The first row of a line. */
export const row_of = (l, line) => (l.plain ? line : l.top[Math.max(0, Math.min(line, l.n))]);

/** A stretch of one line, as the boxes it covers: a list of [row, left, width] in cells. */
export function spans(l, line, from, to) {
  const text = l.all[line] ?? "";
  if (l.plain) return [[line, vcol(text, from), Math.max(cells(text, from, to), 0)]];
  if (l.hidden[line]) return [];
  const points = l.segs.get(line);
  if (!points) return [[l.top[line], cells(text, 0, from), cells(text, from, to)]];
  const out = [];
  for (let k = 0; k < points.length; k++) {
    const a = points[k], b = k + 1 < points.length ? points[k + 1] : Infinity;
    const s = Math.max(from, a), e = Math.min(to, b);
    if (e < s || (e === s && !(from === to && s >= a && s < b))) continue;
    out.push([l.top[line] + k, cells(text, a, s), cells(text, s, Math.min(e, text.length)) + (e > text.length ? e - text.length : 0)]);
  }
  return out;
}

/** The line a row belongs to, and which of the line's rows it is. */
function lineOfRow(l, row) {
  if (l.plain) return [Math.max(0, Math.min(row, l.n - 1)), 0];
  row = Math.max(0, Math.min(row, l.rows - 1));
  let lo = 0, hi = l.vis.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (l.top[l.vis[mid]] <= row) lo = mid; else hi = mid - 1; }
  const line = l.vis[lo] ?? 0;
  return [line, row - l.top[line]];
}
export const line_at_row = (l, row) => lineOfRow(l, row)[0];

/** The rows to draw, from `first` on: [row, line, from, to, which of the line's rows, of how many]. */
export function rows_from(l, first, count) {
  const out = [];
  const last = Math.min(l.rows, first + count);
  if (l.plain) { for (let r = Math.max(0, first); r < last; r++) out.push([r, r, 0, (l.all[r] ?? "").length, 0, 1]); return out; }
  for (let r = Math.max(0, first); r < last; ) {
    const [line, k0] = lineOfRow(l, r);
    const points = l.segs.get(line) ?? [0];
    for (let k = k0; k < points.length && r < last; k++, r++) out.push([r, line, points[k], k + 1 < points.length ? points[k + 1] : (l.all[line] ?? "").length, k, points.length]);
  }
  return out;
}

/** The place under a row and a number of cells: [line, column, beyond the end of the text]. */
export function place(l, row, x) {
  const [line, k] = lineOfRow(l, row);
  const text = l.all[line] ?? "";
  const points = l.plain ? null : l.segs.get(line);
  const from = points ? points[Math.min(k, points.length - 1)] : 0;
  const to = points && k + 1 < points.length ? points[k + 1] : text.length;
  let col = col_in(text, from, to, x);
  // The end of a wrapped row belongs to that row, not to the start of the next.
  if (points && k + 1 < points.length && col >= to) col = step(text, to, false);
  return [line, col, to >= text.length && x > cells(text, from, to) + 0.5];
}

/**
 * Up or down by rows, staying in the column the cursor set out from (`goal`, in cells from
 * the row's edge, or -1 to take it from where the cursor is): [line, column, goal].
 */
export function vertical(l, line, col, goal, by) {
  const [row, left] = spot(l, line, col);
  const want = goal < 0 ? left : goal;
  const target = Math.max(0, Math.min(l.rows - 1, row + by));
  const [toLine, toCol] = place(l, target, want);
  return [toLine, toCol, want];
}

// --- Merge conflicts -------------------------------------------------------------------------------

const conflictTables = new Map();
/**
 * The conflicts git has left in a file: for each, the lines of its markers. `<<<<<<<` opens
 * one, `=======` parts ours from theirs, `>>>>>>>` closes it, and `|||||||` (when git was
 * asked for it) starts what both sides began from.
 */
export function conflicts(key, version, lines) {
  const kept = conflictTables.get(key);
  if (kept && kept.version === version) return kept;
  const all = Array.isArray(lines) ? lines : lines.toArray();
  const found = [];
  const kind = new Uint8Array(all.length);
  let open = null;
  for (let i = 0; i < all.length; i++) {
    const text = all[i];
    if (text.length < 7) continue;
    const c = text.charCodeAt(0);
    if (c !== 60 && c !== 61 && c !== 62 && c !== 124) continue;
    if (text.startsWith("<<<<<<<") && (text.length === 7 || text[7] === " ")) open = { start: i, base: -1, mid: -1, end: -1, ours: text.slice(8).trim(), theirs: "" };
    else if (open && open.mid < 0 && text.startsWith("|||||||") && (text.length === 7 || text[7] === " ")) open.base = i;
    else if (open && open.mid < 0 && text === "=======") open.mid = i;
    else if (open && open.mid >= 0 && text.startsWith(">>>>>>>") && (text.length === 7 || text[7] === " ")) {
      open.end = i; open.theirs = text.slice(8).trim();
      found.push(open);
      const oursEnd = open.base >= 0 ? open.base : open.mid;
      for (let l = open.start; l <= open.end; l++) kind[l] = l === open.start || l === open.mid || l === open.end || l === open.base ? 1 : l < oursEnd ? 2 : l < open.mid ? 4 : 3;
      open = null;
    }
  }
  const table = { version, found, kind };
  if (conflictTables.size > 60) conflictTables.delete(conflictTables.keys().next().value);
  conflictTables.set(key, table);
  return table;
}
/** 0 not in a conflict, 1 a marker, 2 ours, 3 theirs, 4 what both began from. */
export const conflict_kind = (table, line) => table.kind[line] ?? 0;
export const conflict_count = (table) => table.found.length;
/** [first line, last line, our side's name, their side's name] for each conflict. */
export const conflict_list = (table) => table.found.map((c) => [c.start, c.end, c.ours, c.theirs]);
/** The conflict a line is in (or the next one below it): its index, or -1. */
export function conflict_at(table, line, next) {
  for (let i = 0; i < table.found.length; i++) {
    const c = table.found[i];
    if (line >= c.start && line <= c.end && !next) return i;
    if (next && c.start > line) return i;
  }
  return next && table.found.length ? 0 : -1;
}
/**
 * The lines a conflict becomes when it is settled: "ours", "theirs" or "both" (ours, then
 * theirs). Gives [first line, last line, the lines to put there], or null.
 */
export function conflict_taken(table, lines, index, which) {
  const c = table.found[index];
  if (!c) return null;
  const all = Array.isArray(lines) ? lines : lines.toArray();
  const ours = all.slice(c.start + 1, c.base >= 0 ? c.base : c.mid), theirs = all.slice(c.mid + 1, c.end);
  return [c.start, c.end, which === "ours" ? ours : which === "theirs" ? theirs : [...ours, ...theirs]];
}
