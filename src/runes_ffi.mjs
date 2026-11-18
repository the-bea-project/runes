// Runes' edge with the window: keyboard and clipboard, text measuring, TextMate
// tokenizing, VSIX archives, the minimap and terminal elements, and the host
// (the desktop shell, or an in-browser stand-in).
import { toList } from "../prelude.mjs";
import "./runes_canvas_view.mjs";
import "./runes_viewers.mjs";
import * as Layout from "./runes_layout.mjs";
import { nameFor, printed, wasShown } from "./runes_secrets.mjs";

// The npm packages are loaded when the editor boots, not when this file is read,
// so that `bea run` in plain Node can still say how Ink is meant to be started.
let textmate, oniguruma, unzipSync, strFromU8;
async function libraries() {
  textmate = await import("vscode-textmate");
  oniguruma = await import("vscode-oniguruma");
  ({ unzipSync, strFromU8 } = await import("fflate"));
}

const base = () => new URL("./", document.baseURI);

// --- Strings, in UTF-16 units (Gleam's own string functions walk graphemes) -------------

export const len = (s) => s.length;
export const cut = (s, from, to) => s.slice(from, to);
export const index_of = (s, q, from) => s.indexOf(q, from);
export const last_index_of = (s, q, from) => (from < 0 ? -1 : s.lastIndexOf(q, from));

/** Every column where a query appears in a line. */
export function matches(line, query) {
  const out = [];
  if (!query) return toList(out);
  for (let i = line.indexOf(query); i !== -1 && out.length < 200; i = line.indexOf(query, i + query.length)) out.push(i);
  return toList(out);
}

// Where text stands (cell widths, wrapping, folds, indentation) is worked out in runes_layout.mjs.
export const vcol = Layout.vcol;
export const col_at = Layout.col_at;
/** The next place left or right of a column where a cursor can stand: never inside a character. */
export const char_step = Layout.step;
export const detect_indent = (lines) => Layout.detect_indent(lines.toArray());
export const enter_rule = Layout.enter_rule;
export const outdents = Layout.outdents;
export const merge_rules = Layout.merge_rules;
// Merge conflicts in a file, by git's markers.
export const conflicts = Layout.conflicts;
export const conflict_kind = Layout.conflict_kind;
export const conflict_count = Layout.conflict_count;
export const conflict_list = (table) => toList(Layout.conflict_list(table));
export const conflict_at = Layout.conflict_at;
export function conflict_taken(table, lines, index, which) {
  const found = Layout.conflict_taken(table, lines, index, which);
  return found ? [true, found[0], found[1], toList(found[2])] : [false, 0, 0, toList([])];
}
let onLanguage = () => {};
/** `said(language, rules)` when an extension, as it runs, says how a language is indented. */
export function language_listen(said) { onLanguage = said; }
// Asked for on every drawing of the editor: the answer for the same text and place is kept.
let pairAsked = [null, -1, -1, "", null];
export function bracket_pair(lines, line, col, source) {
  if (pairAsked[0] === lines && pairAsked[1] === line && pairAsked[2] === col && pairAsked[3] === source) return pairAsked[4];
  const found = Layout.bracket_pair(lines, line, col, source);
  pairAsked = [lines, line, col, source, found];
  return found;
}
/** The widest of the rows on show, in cells. */
export function widest_row(l, first, count) {
  let most = 0;
  for (const [, line, from, to] of Layout.rows_from(l, first, count)) most = Math.max(most, Layout.cells(l.all[line] ?? "", from, to));
  return most;
}
export const shape = Layout.shape;
export const fold_end = Layout.fold_end;
export const depth_of = Layout.depth_of;
export const block_of = Layout.block_of;
export const all_blocks = (table) => toList(Layout.all_blocks(table));
export const folds_after = (folds, before, after) => toList(Layout.folds_after(folds.toArray(), before, after));
export const layout = Layout.layout;
export const layout_rows = Layout.layout_rows;
export const layout_plain = (l) => l.plain;
export const spot = Layout.spot;
export const row_of = Layout.row_of;
export const line_at_row = Layout.line_at_row;
export const spans = (l, line, from, to) => toList(Layout.spans(l, line, from, to));
/** The width of a tab, in cells; set from the settings. */
export function set_tab(n) {
  Layout.set_tab(n);
  if (inPage) document.documentElement.style.setProperty("--tab", String(Layout.tab_size()));
}
/** Up or down by rows in an editor, as it is laid out now: [line, column, goal]. */
export function visual_step(group, line, col, goal, by) {
  const l = Layout.layout_of(group);
  return l ? Layout.vertical(l, line, col, goal, by) : [line + by, col, goal];
}

const WORD = /[\p{L}\p{N}_]/u;

/** Where the word (or run of spaces, or of symbols) ends, going left or right. */
export function word_edge(line, col, forward) {
  const kind = (c) => (c === undefined ? 0 : WORD.test(c) ? 1 : /\s/.test(c) ? 2 : 3);
  let i = col;
  if (forward) {
    while (i < line.length && kind(line[i]) === 2) i++;
    const k = kind(line[i]);
    while (i < line.length && kind(line[i]) === k) i++;
  } else {
    while (i > 0 && kind(line[i - 1]) === 2) i--;
    const k = kind(line[i - 1]);
    while (i > 0 && kind(line[i - 1]) === k) i--;
  }
  return i;
}

/** The word a column sits in, as [start, end]. */
export function word_at(line, col) {
  let a = col, b = col;
  while (a > 0 && WORD.test(line[a - 1])) a--;
  while (b < line.length && WORD.test(line[b])) b++;
  return [a, b];
}

/** Words of the document that start with a prefix, nearest the cursor first. */
export function words(lines, prefix, around) {
  const all = lines.toArray();
  const seen = new Set([prefix]);
  const out = [];
  const from = Math.max(0, around - 1500), to = Math.min(all.length, around + 1500);
  const order = [];
  for (let d = 0; d < to - from; d++) {
    if (around - d >= from) order.push(around - d);
    if (d > 0 && around + d < to) order.push(around + d);
  }
  for (const i of order) {
    for (const m of all[i].matchAll(/[\p{L}_][\p{L}\p{N}_]{2,}/gu)) {
      if (m[0].startsWith(prefix) && !seen.has(m[0])) {
        seen.add(m[0]);
        out.push(m[0]);
        if (out.length >= 12) return toList(out);
      }
    }
  }
  return toList(out);
}

/** A VS Code snippet body as plain text, with the first tab stop as [start, end]. */
export function expand_snippet(body, indent) {
  let out = "", first = null, stops = [];
  const walk = (s) => {
    for (let i = 0; i < s.length; ) {
      const rest = s.slice(i);
      let m;
      if ((m = /^\\([$}\\])/.exec(rest))) { out += m[1]; i += 2; }
      else if ((m = /^\$(\d+)/.exec(rest))) { stops.push([+m[1], out.length, out.length]); i += m[0].length; }
      else if ((m = /^\$\{(\d+)\}/.exec(rest))) { stops.push([+m[1], out.length, out.length]); i += m[0].length; }
      else if ((m = /^\$\{(\d+)[:|]/.exec(rest))) {
        // Find the matching brace, then expand what is inside.
        let depth = 1, j = i + m[0].length;
        for (; j < s.length && depth > 0; j++) {
          if (s[j] === "\\") j++;
          else if (s[j] === "{" && s[j - 1] === "$") depth++;
          else if (s[j] === "}") depth--;
        }
        let inner = s.slice(i + m[0].length, j - 1);
        if (m[0].endsWith("|")) inner = inner.replace(/\|$/, "").split(",")[0];
        const start = out.length;
        walk(inner);
        stops.push([+m[1], start, out.length]);
        i = j;
      }
      else if ((m = /^\$\{?[A-Z_]+(?::([^}]*))?\}?/.exec(rest))) { out += m[1] ?? ""; i += m[0].length; }
      else { out += s[i]; i++; }
    }
  };
  walk(body.replace(/\n/g, "\n" + indent).replace(/\t/g, "  "));
  stops.sort((a, b) => (a[0] || 1e9) - (b[0] || 1e9));
  first = stops[0] ?? [0, out.length, out.length];
  return [out, first[1], first[2]];
}

// --- Keyboard, clipboard, mouse -----------------------------------------------------------

let clip = "";
const input = () => document.getElementById("runes-input");
/** Chords that run commands; Bea keeps this current so the browser's own handling is stopped. */
let bound = new Set();
/** Chords that still reach the workbench while a terminal has the keyboard. */
const THROUGH_TERMINAL = /^(ctrl\+(`|j|b|p|shift\+p|shift\+`|shift\+e|shift\+f|shift\+x|shift\+m|,|\\|1|2|3|shift\+space|alt\+m))$|^f1$/;

const CANVAS_KEYS = /^ctrl\+(z|y|a|d|g|c|x|v|\]|\[|0|=|\+|-|shift\+z|shift\+g|enter|arrow\w+|shift\+arrow\w+|backspace|delete|home|end)$/;
const FIELD_KEYS = /^(ctrl\+(a|z|y|c|x|v|d|\/|space|shift\+z|backspace|delete|home|end|arrow\w+|shift\+arrow\w+)|alt\+arrow\w+|shift\+alt\+f|f2|f8|shift\+f8|f12)$/;

export function set_chords(chords) {
  bound = new Set(chords.toArray());
}

// With Shift held, a key that types a sign is named by the key, not by the sign: Ctrl+Shift+[
// rather than Ctrl+Shift+{, as VS Code's key bindings name it.
const PLAIN_KEYS = { BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/" };
function chordOf(e) {
  const plain = e.shiftKey && (e.ctrlKey || e.metaKey || e.altKey) ? PLAIN_KEYS[e.code] : undefined;
  const key = plain ?? (e.key === " " ? "space" : e.key.toLowerCase());
  return [(e.ctrlKey || e.metaKey) && "ctrl", e.shiftKey && "shift", e.altKey && "alt", key].filter(Boolean).join("+");
}

export function listen(on_key, on_text, on_paste, on_resize, on_drop, on_zoom, on_pie, on_hover) {
  window.addEventListener("keydown", (e) => {
    if (e.isComposing || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const chord = chordOf(e);
    // The explorer has keys of its own (see tree_listen): there, Ctrl+Z undoes a deletion and
    // F2 renames what is pointed at, and neither is also the editor's.
    if (TREE_KEYS.has(chord) && e.target.closest?.(".tree.files") && !e.target.matches?.("input")) return;
    const inTerminal = !!e.target.closest?.("runes-terminal");
    if (inTerminal && !THROUGH_TERMINAL.test(chord)) return;
    // A drawing has keys of its own (tools, undo, the clipboard); the rest of the editor's
    // commands, those with Ctrl or Alt that the drawing does not use, still work over it.
    if (e.target.closest?.("runes-canvas") && !(/^(ctrl|alt|f\d)/.test(chord) && !CANVAS_KEYS.test(chord))) return;
    const editor = e.target === input();
    // In any other text field these keys belong to the field: select all, undo, clipboard, moving about.
    const field = !editor && e.target.matches?.("input:not([type=checkbox]):not([type=range]), textarea, select");
    if (field && FIELD_KEYS.test(chord)) return;
    const moves = e.key === "Tab" || e.key === "Enter" || e.key.startsWith("Arrow") || e.key.startsWith("Page");
    if (bound.has(chord) || (editor && moves)) e.preventDefault();
    // Enter in a one-line field acts on the field. Without this, when acting on it moves the
    // keyboard to the editor at once, the same key press would also type a new line there.
    if (!editor && e.key === "Enter" && e.target.matches?.("input")) e.preventDefault();
    on_key(e.key, e.ctrlKey || e.metaKey, e.shiftKey, e.altKey, editor, chord);
  }, true);
  document.addEventListener("input", (e) => {
    if (e.target !== input() || e.isComposing) return;
    const text = e.target.value;
    e.target.value = "";
    if (text) on_text(text);
  });
  document.addEventListener("compositionend", (e) => {
    if (e.target !== input()) return;
    const text = e.target.value;
    e.target.value = "";
    if (text) on_text(text);
  });
  document.addEventListener("paste", (e) => {
    if (e.target !== input()) return;
    e.preventDefault();
    on_paste((e.clipboardData.getData("text/plain") || "").replace(/\r\n?/g, "\n"));
  });
  for (const kind of ["copy", "cut"]) {
    document.addEventListener(kind, (e) => {
      if (e.target !== input()) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", clip);
    });
  }
  window.addEventListener("resize", () => on_resize());
  // While Ctrl is held the editor shows that a click will follow a name to its definition.
  const ctrlHeld = (e) => document.body.classList.toggle("ctrl-held", !!(e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey);
  window.addEventListener("keydown", ctrlHeld, true);
  window.addEventListener("keyup", ctrlHeld, true);
  window.addEventListener("blur", () => document.body.classList.remove("ctrl-held"));
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer?.files ?? []) {
      if (file.name.endsWith(".vsix")) on_drop(file.name, new Uint8Array(await file.arrayBuffer()));
    }
  });
  // Ctrl and the wheel change the text size, as in VS Code.
  window.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    on_zoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // The right button: held, it opens the pie menu and releasing picks; tapped, a menu of actions.
  let held = null;
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 2 || !e.target.closest?.(".group")) return;
    const { clientX: x, clientY: y } = e;
    held = { timer: setTimeout(() => { held.open = true; on_pie("hold", x, y); }, 190), open: false };
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (held?.open || document.querySelector(".pie")) on_pie(e.buttons ? "drag" : "move", e.clientX, e.clientY);
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 2 || !held) return;
    clearTimeout(held.timer);
    if (held.open) on_pie("release", e.clientX, e.clientY);
    else on_pie("tap", e.clientX, e.clientY);
    held = null;
  }, true);
  window.addEventListener("contextmenu", (e) => {
    if (!e.target.closest?.("runes-terminal, input, textarea:not(#runes-input)")) e.preventDefault();
    const tree = e.target.closest?.(".tree.files");
    if (!tree || e.target.closest("input")) return;
    const node = e.target.closest(".node");
    on_pie("node\n" + (node?.dataset.path ?? "") + "\n" + (!node || node.classList.contains("folder") ? "folder" : "file"), e.clientX, e.clientY);
  });

  // Resting the pointer on the text asks the language server what is there.
  let rest = null;
  window.addEventListener("mousemove", (e) => {
    clearTimeout(rest);
    const content = e.buttons === 0 && e.target.closest?.(".content");
    if (!content) return;
    const group = Number(content.dataset.group);
    const { clientX: x, clientY: y } = e;
    rest = setTimeout(() => on_hover(group, x, y), 420);
  });
  window.addEventListener("mouseout", () => clearTimeout(rest));
}

export function copy(text) {
  clip = text;
  navigator.clipboard?.writeText(text).catch(() => {});
}

export function paste(done) {
  navigator.clipboard?.readText().then((text) => done(text.replace(/\r\n?/g, "\n")), () => {});
}

/** Focus a field holding a file name, with the name selected but not its ending: typing replaces the name. */
export function focus_stem(id) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  });
}
export function focus(id) {
  const go = () => {
    // Where a drawing is shown in place of text, the keyboard goes to the drawing.
    const board = id === "runes-input" && document.querySelector(".group.focused runes-canvas");
    if (board) { if (!board.contains(document.activeElement)) board.focus({ preventScroll: true }); return true; }
    const el = document.getElementById(id);
    if (!el) return false;
    el.focus({ preventScroll: true });
    if (el.select && id !== "runes-input") el.select();
    return true;
  };
  if (!go()) requestAnimationFrame(go);
}

let LINE = 22;
let charWidth = 0;
function measure() {
  const content = document.querySelector(".content");
  if (!content) return 8;
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  content.appendChild(probe);
  charWidth = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return charWidth;
}

/** Fonts and sizes come from settings; everything measured from them is forgotten. */
export function set_appearance(family, size, line, animations) {
  const root = document.documentElement;
  root.style.setProperty("--mono", `"${family.replace(/["\;{}<>]/g, "")}", "EnvyCodeR Nerd Font", ui-monospace, monospace`);
  root.style.setProperty("--size", size + "px");
  root.style.setProperty("--row", line + "px");
  root.classList.toggle("still", !animations);
  LINE = line;
  charWidth = 0;
}


/**
 * The line and on-screen column under a point of the window, in one editor group. The column
 * is that of the character under the point (or one past the line's end, beyond its text).
 */
export function locate(group, x, y) {
  const content = document.getElementById("content-" + group);
  if (!content) return [0, 0];
  const box = content.getBoundingClientRect();
  const w = charWidth || measure();
  const gutter = (parseFloat(content.dataset.gutter) || 6) * w;
  const row = Math.max(0, Math.floor((y - box.top) / LINE)), cellsIn = Math.max(0, (x - box.left - gutter) / w);
  const l = Layout.layout_of(group);
  if (!l) return [row, Math.round(cellsIn)];
  const [line, col, beyond] = Layout.place(l, row, cellsIn);
  return [line, Layout.vcol(l.all[line] ?? "", col) + (beyond ? 1 : 0)];
}

const unmeasured = new Set();
/** How many cells of text fit across an editor, for wrapping; 80 until it has been drawn once. */
export function wrap_width(group, gutter) {
  const el = document.getElementById("scroller-" + group);
  if (!el || !el.clientWidth) {
    // Not drawn yet: say so once it is, so the lines are wrapped to the real width. Once
    // only: an editor that is never given any room must not have the window drawn for ever.
    if (!unmeasured.has(group)) {
      unmeasured.add(group);
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
    return 80;
  }
  unmeasured.delete(group);
  const w = charWidth || measure();
  return Math.max(20, Math.floor(el.clientWidth / w) - gutter - 2);
}

const scroller = (group) => document.getElementById("scroller-" + group);
export const scroll_top = (group) => Math.round(scroller(group)?.scrollTop ?? 0);
export const view_height = (group) => scroller(group)?.clientHeight ?? 900;

export function scroll_to(group, top) {
  requestAnimationFrame(() => scroller(group)?.scrollTo({ top, behavior: "instant" }));
}

let relaying = false;
/**
 * The arrangement of groups is about to change. Notes where each group is now; once the
 * window has drawn the new arrangement, puts every group back at its scroll position and
 * slides each from where it was to where it is. A group that is new slides in from the
 * side it was split off to.
 */
export function relayout(source, tops, done) {
  if (!inPage || relaying) return;
  relaying = true;
  const before = new Map();
  for (const g of document.querySelectorAll(".group[data-group]")) before.set(g.dataset.group, g.getBoundingClientRect());
  const from = before.get(String(source));
  const area = document.querySelector(".area");
  let watcher = null, fallback = null;
  const after = () => {
    if (!relaying) return;
    relaying = false;
    watcher?.disconnect();
    clearTimeout(fallback);
    for (const [group, top] of tops.toArray()) scroller(group)?.scrollTo({ top, behavior: "instant" });
    done();
    if (document.documentElement.classList.contains("still")) return;
    const timing = { duration: 230, easing: "cubic-bezier(.2, .85, .25, 1)" };
    for (const g of document.querySelectorAll(".group[data-group]")) {
      const now = g.getBoundingClientRect(), was = before.get(g.dataset.group);
      if (was) {
        const dx = was.left - now.left, dy = was.top - now.top;
        const right = Math.max(0, now.width - was.width), bottom = Math.max(0, now.height - was.height);
        if (Math.abs(dx) + Math.abs(dy) + right + bottom < 2) continue;
        // It starts where it was and no bigger than it was, then slides and opens out.
        g.animate([{ transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0 ${right}px ${bottom}px 0)` },
          { transform: "none", clipPath: "inset(0 0 0 0)" }], timing);
      } else {
        const ox = from ? now.left + now.width / 2 - (from.left + from.width / 2) : 1, oy = from ? now.top + now.height / 2 - (from.top + from.height / 2) : 0;
        const slide = Math.abs(ox) >= Math.abs(oy) ? `translateX(${Math.sign(ox || 1) * now.width}px)` : `translateY(${Math.sign(oy || 1) * now.height}px)`;
        g.animate([{ transform: slide }, { transform: "none" }], timing);
      }
    }
  };
  // Straight after the window has redrawn, and before it is shown.
  if (area) { watcher = new MutationObserver(after); watcher.observe(area, { childList: true, subtree: true }); }
  fallback = setTimeout(after, 120);
}

/** Scroll, smoothly, until a line and column are on screen. */
export function reveal(group, line, column, center) {
  requestAnimationFrame(() => {
    const el = scroller(group);
    if (!el) return;
    const w = charWidth || measure();
    // Where the place is drawn: folds and wrapped lines move it from where its line number says.
    const l = Layout.layout_of(group);
    if (l) { const text = l.all[line] ?? ""; [line, column] = Layout.spot(l, line, Layout.col_at(text, column)); }
    const top = line * LINE, margin = LINE * 3;
    let to = el.scrollTop;
    if (center) to = Math.max(0, top - el.clientHeight / 2);
    else if (top < el.scrollTop + margin) to = Math.max(0, top - margin);
    else if (top + LINE > el.scrollTop + el.clientHeight - margin) to = top + LINE - el.clientHeight + margin;
    const x = column * w;
    let left = el.scrollLeft;
    if (x < el.scrollLeft) left = Math.max(0, x - w * 10);
    else if (x > el.scrollLeft + el.clientWidth - w * 24) left = x - el.clientWidth + w * 30;
    if (to !== el.scrollTop || left !== el.scrollLeft) {
      const far = Math.abs(to - el.scrollTop) > el.clientHeight * 3;
      el.scrollTo({ top: to, left, behavior: far ? "instant" : "smooth" });
    }
  });
}

/** While the button is down, report where the pointer is inside an element, as 0..1. */
export function drag_ratio(id, row, moved) {
  const el = document.getElementById(id);
  if (!el) return;
  document.body.classList.add("dragging");
  const move = (e) => {
    const box = el.getBoundingClientRect();
    moved(row ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height);
  };
  const up = () => {
    document.body.classList.remove("dragging");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/** While the button is down, report the pointer in pixels from the window's edges. */
export function drag_px(moved) {
  document.body.classList.add("dragging");
  const move = (e) => moved(Math.round(e.clientX), Math.round(e.clientY), window.innerWidth, window.innerHeight);
  const up = () => {
    document.body.classList.remove("dragging");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

export function save(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}
export function load(key) {
  try { return localStorage.getItem(key) ?? ""; } catch (_) { return ""; }
}

// --- Find and replace ---------------------------------------------------------------------

function pattern(query, regex, matchCase, word) {
  if (!query) return null;
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (word) source = `\\b(?:${source})\\b`;
  try { return new RegExp(source, matchCase ? "gu" : "giu"); } catch (_) { return null; }
}

/** Every match in the text: a list of [line, column, length]. */
export function find_all(lines, query, regex, matchCase, word) {
  const re = pattern(query, regex, matchCase, word);
  const out = [];
  if (!re) return toList(out);
  const all = lines.toArray();
  for (let i = 0; i < all.length && out.length < 5000; i++) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(all[i])) && out.length < 5000; ) {
      if (m[0] === "") { re.lastIndex++; continue; }
      out.push([i, m.index, m[0].length]);
    }
  }
  return toList(out);
}

/** What one match becomes: regex replacements may use $1 and friends. */
export function replacement(text, query, regex, matchCase, word, replace) {
  const re = pattern(query, regex, matchCase, word);
  if (!re) return text;
  return regex ? text.replace(re, replace) : replace;
}

export function replace_all(lines, query, regex, matchCase, word, replace) {
  const re = pattern(query, regex, matchCase, word);
  if (!re) return lines;
  return toList(lines.toArray().map((line) => (regex ? line.replace(re, replace) : line.replace(re, () => replace))));
}

// --- Extensions: VSIX archives ----------------------------------------------------------------

/** id -> { files: Map(path -> bytes), builtin } */
const extensions = new Map();

/** JSON as extensions write it: comments and trailing commas allowed. */
function relaxed(text) {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      i++;
    } else if (c === '"') { inString = true; out += c; i++; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); i = i === -1 ? text.length : i + 2; }
    else { out += c; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const tidy = (path) => path.replace(/^\.\//, "").replace(/^\//, "");
function join(from, path) {
  const parts = from.split("/").slice(0, -1);
  for (const p of path.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

function unpack(bytes, builtin) {
  const zip = unzipSync(bytes);
  const prefix = zip["extension/package.json"] ? "extension/" : zip["package.json"] ? "" : null;
  if (prefix === null) throw new Error("This is not a VSIX: there is no extension/package.json in it");
  const files = new Map();
  for (const [path, data] of Object.entries(zip)) {
    if (path.startsWith(prefix) && !path.endsWith("/")) files.set(path.slice(prefix.length), data);
  }
  let manifest = relaxed(strFromU8(files.get("package.json")));
  // Built-in VS Code extensions keep their names in package.nls.json.
  if (files.has("package.nls.json")) {
    const names = JSON.parse(relaxed(strFromU8(files.get("package.nls.json"))));
    manifest = manifest.replace(/"%([^"%]+)%"/g, (all, key) =>
      typeof names[key] === "string" ? JSON.stringify(names[key]) : all);
  }
  const json = JSON.parse(manifest);
  const id = `${json.publisher ?? "unknown"}.${json.name}`;
  extensions.set(id, { files, builtin });
  languageIcons = null;
  return [id, manifest, builtin];
}

/** A file of an installed extension, as text ("" when it is not there). */
export function extension_file(id, path) {
  const data = extensions.get(id)?.files.get(tidy(path));
  if (!data) return "";
  const text = strFromU8(data);
  return path.endsWith(".json") || path.endsWith(".code-snippets") ? relaxed(text) : text;
}

/** Load everything that is installed: what ships with Ink, then what the user added. */
export function boot(done) {
  (async () => {
    const found = [];
    const failed = [];
    try {
      await libraries();
      const wasm = await (await fetch(new URL("onig.wasm", base()))).arrayBuffer();
      await oniguruma.loadWASM(wasm);
      const names = await (await fetch(new URL("extensions/index.json", base()))).json();
      for (const name of names) {
        try {
          const bytes = new Uint8Array(await (await fetch(new URL("extensions/" + name, base()))).arrayBuffer());
          found.push(unpack(bytes, true));
        } catch (e) { failed.push(`${name}: ${e.message}`); }
      }
      for (const [name, bytes] of await host.extensions()) {
        try { found.push(unpack(bytes, false)); } catch (e) { failed.push(`${name}: ${e.message}`); }
      }
    } catch (e) { failed.push(String(e.message ?? e)); }
    const info = await host.info();
    done(toList(found), failed.join("\n"), host.native, await host.root(), info.version, info.platform);
  })();
}

async function install(name, bytes, done) {
  try {
    const [id, manifest] = unpack(bytes, false);
    // The shell asks before installing an extension that brings code, and may refuse.
    const refused = await host.installExtension(id + ".vsix", bytes);
    if (refused) {
      extensions.delete(id);
      languageIcons = null;
      return done("", "", refused);
    }
    done(id, manifest, "");
  } catch (e) { done("", "", `${name}: ${e.message ?? e}`); }
}

export function install_dropped(name, bytes, done) {
  install(name, bytes, done);
}

/** Ask for a .vsix file and install it. */
export function pick_vsix(done) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".vsix";
  picker.onchange = async () => {
    const file = picker.files[0];
    if (file) install(file.name, new Uint8Array(await file.arrayBuffer()), done);
  };
  picker.click();
}

// --- SSH sessions, and questions from the shell ---------------------------------------------------

const sessionRow = (s) => [s.id, s.name, s.host, s.user, s.port, s.key, s.folder, !!s.known, !!s.on, s.auth ?? "auto"];
export function ssh_sessions(done) {
  if (!host.sshSessions) return done(toList([]));
  host.sshSessions().then((all) => done(toList(all.map(sessionRow))), () => done(toList([])));
}
export function ssh_save(id, name, address, user, port, key, folder, auth, done) {
  if (!host.sshSave) return done("SSH needs the desktop app.");
  host.sshSave({ id, name, host: address, user, port: Number(port) || 22, key, folder, auth }).then(() => done(""), (e) => done(message(e)));
}
export const ssh_remove = (id, done) => { host.sshRemove?.(id).then(() => done(), () => done()); };
export const ssh_forget = (id, done) => { host.sshForget?.(id).then(() => done(), () => done()); };
export function ssh_import(done) {
  if (!host.sshImport) return done(0, "SSH needs the desktop app.");
  host.sshImport().then((count) => done(count, ""), (e) => done(0, message(e)));
}
export function ssh_connect(id, done) {
  if (!host.sshConnect) return done("", "", "SSH needs the desktop app.");
  host.sshConnect(id).then((on) => done(on.name, on.folder, ""), (e) => done("", "", message(e)));
}
export function ssh_open(folder, done) {
  host.sshOpen(folder).then((root) => done(root, ""), (e) => done("", message(e)));
}
export function ssh_disconnect(done) {
  host.sshDisconnect().then((folder) => done(folder), () => done(""));
}
/** `on_prompt(id, kind, title, detail, initial)` for each question; `on_left(folder, note)` when a session ends by itself. */
export function ssh_listen(on_prompt, on_left) {
  host.onPrompt?.((p) => on_prompt(p.id, p.kind, p.title, p.detail, p.initial ?? ""));
  host.onSsh?.((change) => on_left(change.folder ?? "", change.note ?? ""));
}
/** Answers a question: the text typed (or yes), or a refusal. */
export function prompt_answer(id, kind, text, ok) {
  host.promptAnswer?.(id, !ok ? (kind === "confirm" ? false : null) : kind === "confirm" ? true : text);
}

// --- Fonts added to Runes ---------------------------------------------------------------------------

const added = new Map();
async function register(family, weight, style, bytes) {
  const face = new FontFace(family, bytes, { weight: String(weight), style });
  await face.load();
  document.fonts.add(face);
  if (!added.has(family)) added.set(family, []);
  added.get(family).push(face);
}
const families = () => toList([...added.keys()].sort((a, b) => a.localeCompare(b)));

/** Makes the fonts kept in the profile usable, then says which families there are. */
export function load_fonts(done) {
  if (!host.fonts) return done(toList([]));
  host.fonts().then(async (found) => {
    for (const [, family, weight, style, bytes] of found) { try { await register(family, weight, style, bytes); } catch (_) {} }
    done(families());
  }, () => done(toList([])));
}

/** Asks for font files and adds them. `done` gets the families there are now, and any trouble. */
export function pick_fonts(done) {
  if (!host.fontAdd) return done(families(), "Adding fonts needs the desktop app.");
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".ttf,.otf,.woff,.woff2";
  picker.multiple = true;
  picker.onchange = async () => {
    const problems = [];
    for (const file of picker.files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const [, family, weight, style] = await host.fontAdd(file.name, bytes);
        await register(family, weight, style, bytes);
      } catch (e) { problems.push(message(e)); }
    }
    done(families(), problems.join("\n"));
  };
  picker.click();
}

export function remove_font(family) {
  for (const face of added.get(family) ?? []) document.fonts.delete(face);
  added.delete(family);
  host.fontRemove?.(family);
  return families();
}

export function uninstall(id) {
  extensions.delete(id);
  languageIcons = null;
  host.removeExtension(id + ".vsix");
}

// --- Grammars and themes ----------------------------------------------------------------------

/** scope -> { id, path, injectTo } */
const grammars = new Map();
let registry = null;
let colors = ["", "#cccccc", "#1e1e1e"];
let themeVersion = 0;
let themeRules = [];
let onLoaded = () => {};
/** scope -> grammar, null while loading, false when it cannot be loaded */
const loaded = new Map();
/** document -> { scope, theme, texts, states, tokens } */
const caches = new Map();

export function on_grammar(callback) {
  onLoaded = callback;
}

function makeRegistry() {
  registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope) => {
      const g = grammars.get(scope);
      if (!g) return null;
      const data = extensions.get(g.id)?.files.get(tidy(g.path));
      if (!data) return null;
      const text = strFromU8(data);
      return textmate.parseRawGrammar(g.path.endsWith(".json") ? relaxed(text) : text, g.path);
    },
    getInjections: (scope) => [...grammars].filter(([, g]) => g.injectTo.includes(scope)).map(([s]) => s),
  });
  registry.setTheme({ settings: themeRules });
  colors = registry.getColorMap();
  loaded.clear();
  caches.clear();
}

export function register_grammar(id, scope, path, inject_to) {
  grammars.set(scope, { id, path, injectTo: inject_to.toArray() });
}

/** Call after grammars were added or removed. */
export function grammars_changed(installed) {
  const ids = new Set(installed.toArray());
  for (const [scope, g] of grammars) if (!ids.has(g.id)) grammars.delete(scope);
  makeRegistry();
}

function grammar(scope) {
  if (!scope || !registry) return null;
  if (!loaded.has(scope)) {
    loaded.set(scope, null);
    registry.loadGrammar(scope).then(
      (g) => { loaded.set(scope, g ?? false); if (g) onLoaded(); },
      (e) => { console.warn("Runes: grammar " + scope + " failed to load", e); loaded.set(scope, false); },
    );
  }
  return loaded.get(scope) || null;
}

/** The lines of every document that has been drawn, for the minimap. */
const documents = new Map();

/** Tokenize further down a document, keeping each line's end state. */
function extend(cache, all, last) {
  const g = loaded.get(cache.scope);
  if (!g) return;
  for (let i = cache.texts.length; i < last; i++) {
    const text = all[i];
    const before = i === 0 ? textmate.INITIAL : cache.states[i - 1];
    if (text.length > 3000) {
      cache.states.push(before);
      cache.tokens.push([[text, ""]]);
    } else {
      const result = g.tokenizeLine2(text, before, 400);
      const pieces = [];
      const t = result.tokens;
      for (let j = 0; j < t.length; j += 2) {
        const start = t[j], end = j + 2 < t.length ? t[j + 2] : text.length;
        if (end <= start) continue;
        const meta = t[j + 1], font = (meta >>> 11) & 15;
        let style = "color:" + colors[(meta >>> 15) & 511];
        if (font & 1) style += ";font-style:italic";
        if (font & 2) style += ";font-weight:600";
        if (font & 4) style += ";text-decoration:underline";
        const prev = pieces[pieces.length - 1];
        if (prev && prev[1] === style) prev[0] += text.slice(start, end);
        else pieces.push([text.slice(start, end), style]);
      }
      cache.states.push(result.ruleStack);
      cache.tokens.push(pieces.length ? pieces : [[text, ""]]);
    }
    cache.texts.push(text);
  }
}

/** The coloured pieces of `count` lines from `first`: a list of lines of [text, style]. */
export function tokens(key, scope, version, lines, first, count) {
  const all = lines.toArray();
  documents.set(key, all);
  const last = Math.min(all.length, first + count);
  const g = grammar(scope);
  const out = [];
  if (!g) {
    for (let i = first; i < last; i++) out.push(toList([[all[i], ""]]));
    return toList(out);
  }
  let cache = caches.get(key);
  if (!cache || cache.scope !== scope || cache.theme !== themeVersion) {
    cache = { scope, theme: themeVersion, version: -1, texts: [], states: [], tokens: [] };
    caches.set(key, cache);
  }
  if (cache.version !== version) {
    // Keep what is above the first changed line; everything below is tokenized again.
    let same = 0;
    const max = Math.min(cache.texts.length, all.length);
    while (same < max && cache.texts[same] === all[same]) same++;
    cache.texts.length = cache.states.length = cache.tokens.length = same;
    cache.version = version;
  }
  extend(cache, all, last);
  for (let i = first; i < last; i++) out.push(toList(cache.tokens[i]));
  return toList(out);
}

/**
 * The rows of an editor to draw, from row `first`: for each, [row, line, the row's first
 * column, its coloured pieces, which of its line's rows it is, of how many].
 */
export function editor_rows(l, key, scope, version, first, count) {
  const found = Layout.rows_from(l, first, count);
  if (!found.length) return toList([]);
  const lastLine = found[found.length - 1][1];
  const g = grammar(scope);
  let cache = null;
  documents.set(key, l.all);
  if (g) {
    cache = caches.get(key);
    if (!cache || cache.scope !== scope || cache.theme !== themeVersion) {
      cache = { scope, theme: themeVersion, version: -1, texts: [], states: [], tokens: [] };
      caches.set(key, cache);
    }
    if (cache.version !== version) {
      let same = 0;
      const max = Math.min(cache.texts.length, l.all.length);
      while (same < max && cache.texts[same] === l.all[same]) same++;
      cache.texts.length = cache.states.length = cache.tokens.length = same;
      cache.version = version;
    }
    extend(cache, l.all, Math.min(l.all.length, lastLine + 1));
  }
  return toList(found.map(([row, line, from, to, k, of]) => {
    const text = l.all[line] ?? "";
    const pieces = cache?.tokens[line] ?? [[text, ""]];
    return [row, line, from, toList(Layout.fitted(pieces, text, from, to)), k, of];
  }));
}

function readTheme(id, path, seen = new Set()) {
  const file = tidy(path);
  if (seen.has(file)) return { colors: {}, rules: [] };
  seen.add(file);
  const text = extension_file(id, file);
  if (!text) return { colors: {}, rules: [] };
  const json = JSON.parse(text);
  const parent = json.include ? readTheme(id, join(file, json.include), seen) : { colors: {}, rules: [] };
  const own = Array.isArray(json.tokenColors) ? json.tokenColors : Array.isArray(json.settings) ? json.settings : [];
  return { colors: { ...parent.colors, ...(json.colors ?? {}) }, rules: [...parent.rules, ...own] };
}

const VARS = {
  "--bg": ["editor.background"],
  "--fg": ["editor.foreground", "foreground"],
  "--side-bg": ["sideBar.background", "editor.background"],
  "--side-fg": ["sideBar.foreground", "foreground", "editor.foreground"],
  "--activity-bg": ["activityBar.background", "sideBar.background", "editor.background"],
  "--activity-fg": ["activityBar.foreground", "foreground", "editor.foreground"],
  "--tabs-bg": ["editorGroupHeader.tabsBackground", "sideBar.background", "editor.background"],
  "--tab-fg": ["tab.inactiveForeground", "foreground"],
  "--tab-active-bg": ["tab.activeBackground", "editor.background"],
  "--tab-active-fg": ["tab.activeForeground", "editor.foreground"],
  "--status-bg": ["statusBar.background", "sideBar.background"],
  "--status-fg": ["statusBar.foreground", "foreground"],
  "--selection": ["editor.selectionBackground"],
  "--line": ["editor.lineHighlightBackground"],
  "--caret": ["editorCursor.foreground", "editor.foreground"],
  "--number": ["editorLineNumber.foreground"],
  "--number-active": ["editorLineNumber.activeForeground", "editor.foreground"],
  "--border": ["editorGroup.border", "panel.border", "sideBar.border", "contrastBorder"],
  "--accent": ["focusBorder", "button.background", "activityBarBadge.background"],
  "--button-bg": ["button.background", "focusBorder"],
  "--button-fg": ["button.foreground"],
  "--widget-bg": ["quickInput.background", "editorWidget.background", "sideBar.background"],
  "--widget-fg": ["quickInput.foreground", "editorWidget.foreground", "foreground", "editor.foreground"],
  "--list-active": ["list.activeSelectionBackground", "list.focusBackground", "editor.selectionBackground"],
  "--list-hover": ["list.hoverBackground"],
  "--input-bg": ["input.background"],
  "--find": ["editor.findMatchHighlightBackground"],
  "--panel-bg": ["panel.background", "editor.background"],
  "--error": ["editorError.foreground"],
  "--warning": ["editorWarning.foreground"],
  "--info": ["editorInfo.foreground"],
};
const FALLBACK = {
  dark: { "--bg": "#1e1e1e", "--fg": "#d4d4d4", "--selection": "#264f78", "--line": "#ffffff0d", "--number": "#858585",
    "--border": "#ffffff1f", "--accent": "#0078d4", "--button-fg": "#ffffff", "--list-hover": "#ffffff14",
    "--input-bg": "#00000040", "--find": "#ea5c0055", "--error": "#f14c4c", "--warning": "#cca700", "--info": "#3794ff" },
  light: { "--bg": "#ffffff", "--fg": "#333333", "--selection": "#add6ff", "--line": "#0000000a", "--number": "#8a8a8a",
    "--border": "#0000001f", "--accent": "#005fb8", "--button-fg": "#ffffff", "--list-hover": "#0000000f",
    "--input-bg": "#00000008", "--find": "#ea5c0055", "--error": "#e51400", "--warning": "#bf8803", "--info": "#1a85ff" },
};

/** Switch the colour theme: the window's colours and the tokens' colours. */
export function use_theme(id, path, ui) {
  const theme = readTheme(id, path);
  themeColors = theme.colors;
  const kind = ui === "vs" || ui === "hc-light" ? "light" : "dark";
  const root = document.documentElement;
  root.dataset.kind = kind;
  root.classList.add("theme-changing");
  setTimeout(() => root.classList.remove("theme-changing"), 500);
  const chosen = {};
  for (const [name, keys] of Object.entries(VARS)) {
    for (const key of keys) {
      if (theme.colors[key]) { chosen[name] = theme.colors[key]; break; }
    }
  }
  for (const name of Object.keys(VARS)) {
    const value = chosen[name] ?? FALLBACK[kind][name]
      ?? (name.endsWith("-bg") ? chosen["--bg"] ?? FALLBACK[kind]["--bg"] : chosen["--fg"] ?? FALLBACK[kind]["--fg"]);
    root.style.setProperty(name, value);
  }
  themeRules = [
    { settings: { foreground: chosen["--fg"] ?? FALLBACK[kind]["--fg"], background: chosen["--bg"] ?? FALLBACK[kind]["--bg"] } },
    ...theme.rules,
  ];
  themeVersion++;
  if (registry) {
    registry.setTheme({ settings: themeRules });
    colors = registry.getColorMap();
  }
  for (const term of terminals.values()) term.options.theme = terminalTheme();
}

// --- Icon themes -----------------------------------------------------------------------------

let icons = null;

// A language extension can give its language an icon of its own (`contributes.languages[].icon`).
// It is used for files of that language the icon theme has nothing particular for. Worked out
// when first asked for, and again whenever an extension comes or goes. One that the person
// installed wins over one that ships with Runes.
let languageIcons = null;
function languageIcon(language) {
  if (!languageIcons) {
    languageIcons = new Map();
    for (const [id, extension] of [...extensions].sort((a, b) => Number(b[1].builtin) - Number(a[1].builtin))) {
      let json;
      try { json = JSON.parse(relaxed(strFromU8(extension.files.get("package.json")))); } catch { continue; }
      for (const language of json.contributes?.languages ?? []) {
        const icon = language?.icon;
        if (typeof language?.id !== "string" || !icon) continue;
        const paths = { light: icon.light ?? icon.dark, dark: icon.dark ?? icon.light };
        if (typeof paths.light === "string" && typeof paths.dark === "string") languageIcons.set(language.id, { id, paths, urls: {} });
      }
    }
  }
  const found = languageIcons.get(language);
  if (!found) return "";
  const kind = document.documentElement.dataset.kind === "light" ? "light" : "dark";
  if (found.urls[kind] === undefined) {
    const file = tidy(found.paths[kind]);
    const data = extensions.get(found.id)?.files.get(file);
    const type = file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : "";
    found.urls[kind] = data && type ? URL.createObjectURL(new Blob([data], { type })) : "";
  }
  return found.urls[kind];
}

/** Switch the file icon theme to one an extension contributes. */
export function use_icon_theme(id, path) {
  icons = null;
  const text = extension_file(id, path);
  if (!text) return;
  try {
    const json = JSON.parse(text);
    const dir = tidy(path);
    for (const font of json.fonts ?? []) {
      const data = extensions.get(id)?.files.get(join(dir, font.src?.[0]?.path ?? ""));
      if (!data) continue;
      const face = new FontFace("runes-icons-" + font.id, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      face.load().then((f) => document.fonts.add(f), () => {});
    }
    icons = { id, dir, json, urls: new Map(), font: json.fonts?.[0] };
  } catch (e) { console.warn("Runes: icon theme could not be read", e); }
}

/** The icon of a file or folder: [glyph, colour, font family, image address]. */
export function icon(name, folder, open, language) {
  const none = ["", "", "", ""];
  const own = !folder && language ? languageIcon(language) : "";
  if (!icons) return own ? ["", "", "", own] : none;
  const t = icons.json;
  const lower = name.toLowerCase();
  let key;
  if (folder) {
    key = (open ? t.folderNamesExpanded?.[lower] : t.folderNames?.[lower]) ?? (open ? t.folderExpanded : t.folder);
  } else {
    key = t.fileNames?.[lower];
    for (let dot = lower.indexOf("."); !key && dot !== -1; dot = lower.indexOf(".", dot + 1)) {
      key = t.fileExtensions?.[lower.slice(dot + 1)];
    }
    key ??= t.languageIds?.[language];
    // Nothing in the theme for this file in particular: its language's own icon, if it has one.
    if (!key && own) return ["", "", "", own];
    key ??= t.file;
  }
  const def = key && t.iconDefinitions?.[key];
  if (!def) return none;
  if (def.fontCharacter) {
    const glyph = def.fontCharacter.replace(/\\([0-9a-fA-F]+)/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
    return [glyph, def.fontColor ?? "", "runes-icons-" + (def.fontId ?? icons.font?.id ?? ""), ""];
  }
  if (def.iconPath) {
    const file = join(icons.dir, def.iconPath);
    if (!icons.urls.has(file)) {
      const data = extensions.get(icons.id)?.files.get(file);
      const type = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
      icons.urls.set(file, data ? URL.createObjectURL(new Blob([data], { type })) : "");
    }
    return ["", "", "", icons.urls.get(file)];
  }
  return none;
}

// --- The minimap: blocks, not letters ---------------------------------------------------------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The pure parts of this file are also loaded by the unit tests, in Node, where there is no page.
const inPage = typeof window !== "undefined";
const Element = globalThis.HTMLElement ?? class {};

class Minimap extends Element {
  static observedAttributes = ["doc", "version", "top", "view", "total", "marks", "paint"];
  connectedCallback() {
    this.canvas = document.createElement("canvas");
    this.slider = document.createElement("div");
    this.slider.className = "minimap-slider";
    this.append(this.canvas, this.slider);
    this.resizer = new ResizeObserver(() => this.schedule());
    this.resizer.observe(this);
    const jump = (e) => {
      const box = this.getBoundingClientRect();
      const g = this.geometry();
      const line = (e.clientY - box.top + g.offset) / g.step - g.viewLines / 2;
      const el = scroller(this.getAttribute("group"));
      // The map counts lines of the file; the editor may fold and wrap them.
      const l = Layout.layout_of(this.getAttribute("group"));
      if (el) el.scrollTop = Math.max(0, (l ? Layout.row_of(l, Math.max(0, Math.round(line))) : line) * LINE);
    };
    this.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jump(e);
      const up = () => { window.removeEventListener("mousemove", jump); window.removeEventListener("mouseup", up); this.classList.remove("held"); };
      this.classList.add("held");
      window.addEventListener("mousemove", jump);
      window.addEventListener("mouseup", up);
    });
    this.schedule();
  }
  disconnectedCallback() { this.resizer?.disconnect(); }
  attributeChangedCallback() { this.schedule(); }
  schedule() {
    if (this.queued || !this.canvas) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }
  geometry() {
    const total = Number(this.getAttribute("total")) || 1;
    const height = this.clientHeight || 1;
    const step = 3;
    const top = (Number(this.getAttribute("top")) || 0) / LINE;
    const viewLines = (Number(this.getAttribute("view")) || 0) / LINE;
    const overflow = Math.max(0, total * step - height);
    const offset = total > viewLines ? overflow * Math.min(1, top / Math.max(1, total - viewLines)) : 0;
    return { total, height, step, top, viewLines, offset };
  }
  draw() {
    const g = this.geometry();
    const width = this.clientWidth || 96;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = width * ratio;
    this.canvas.height = g.height * ratio;
    const ctx = this.canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const key = this.getAttribute("doc");
    const lines = documents.get(key) ?? [];
    const cache = caches.get(key);
    const plain = css("--fg") || "#ccc";
    const first = Math.floor(g.offset / g.step);
    const last = Math.min(lines.length, first + Math.ceil(g.height / g.step) + 1);
    ctx.globalAlpha = 0.62;
    for (let i = first; i < last; i++) {
      const y = i * g.step - g.offset;
      const pieces = cache?.tokens[i] ?? [[lines[i], ""]];
      let x = 4;
      for (const [text, style] of pieces) {
        ctx.fillStyle = /color:(#[0-9a-fA-F]+)/.exec(style)?.[1] ?? plain;
        // A run of ink for every word; gaps where the spaces are.
        for (const m of text.matchAll(/\S+/g)) {
          const from = x + vcol(text, m.index), w = Math.min(m[0].length, width - from - 14);
          if (w > 0) ctx.fillRect(from, y, w, g.step - 1);
        }
        x += vcol(text, text.length);
        if (x > width) break;
      }
    }
    ctx.globalAlpha = 1;
    // Errors and warnings: a bar at the edge, whatever the scroll position.
    for (const mark of (this.getAttribute("marks") || "").split(";")) {
      if (!mark) continue;
      const [line, severity] = mark.split(":").map(Number);
      ctx.fillStyle = severity === 1 ? css("--error") || "#f66" : css("--warning") || "#fc6";
      const y = g.total * g.step > g.height ? (line / g.total) * g.height : line * g.step;
      ctx.fillRect(width - 8, y, 6, 3);
      if (line >= first && line < last) ctx.fillRect(2, line * g.step - g.offset, 2, g.step);
    }
    this.slider.style.top = g.top * g.step - g.offset + "px";
    this.slider.style.height = Math.max(12, g.viewLines * g.step) + "px";
    // Colour the rest of the file a little at a time.
    if (cache && cache.tokens.length < lines.length && !this.idle) {
      this.idle = setTimeout(() => {
        this.idle = null;
        extend(cache, lines, Math.min(lines.length, cache.tokens.length + 600));
        this.schedule();
      }, 30);
    }
  }
}
if (inPage) customElements.define("runes-minimap", Minimap);

// --- Terminals --------------------------------------------------------------------------------

const terminals = new Map();
let XTerm = null, FitAddon = null;

let themeColors = {};
function terminalTheme() {
  const theme = {
    background: "#00000000",
    foreground: css("--fg"),
    cursor: css("--caret"),
    selectionBackground: css("--selection"),
  };
  // The sixteen terminal colours, when the theme names them.
  for (const name of ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"]) {
    const plain = themeColors["terminal.ansi" + name], bright = themeColors["terminal.ansiBright" + name];
    if (plain) theme[name.toLowerCase()] = plain;
    if (bright) theme["bright" + name] = bright;
  }
  return theme;
}

/** id -> { term, fit }: a terminal lives here, whatever part of the window is showing it. */
const sessions = new Map();

class TerminalView extends Element {
  async connectedCallback() {
    const id = Number(this.getAttribute("term"));
    if (!host.term) {
      this.textContent = "Terminals need the desktop app.";
      return;
    }
    if (!XTerm) {
      ({ Terminal: XTerm } = await import("@xterm/xterm"));
      ({ FitAddon } = await import("@xterm/addon-fit"));
    }
    if (!this.isConnected) return;
    let session = sessions.get(id);
    const fresh = !session;
    if (fresh) {
      const term = new XTerm({
        fontFamily: css("--mono"),
        fontSize: Math.max(10, parseInt(css("--size")) - 1 || 13),
        cursorBlink: true,
        allowTransparency: true,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(this);
      // The clipboard. A terminal keeps Ctrl+C for stopping what runs, so copying is
      // Ctrl+Shift+C, as in other terminals; Ctrl+C copies too while something is selected.
      // Pasting is Ctrl+Shift+V, Ctrl+V or Shift+Insert.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
        const copies = ctrl && key === "c" && (e.shiftKey || term.hasSelection());
        const pastes = (ctrl && key === "v") || (e.shiftKey && !ctrl && key === "insert");
        if (!copies && !pastes) return true;
        e.preventDefault();
        if (copies) {
          const picked = term.getSelection();
          if (picked) { navigator.clipboard?.writeText(picked).catch(() => {}); if (!e.shiftKey) term.clearSelection(); }
        } else {
          navigator.clipboard?.readText().then((text) => { if (text) term.paste(text); }, () => {});
        }
        return false;
      });
      session = { term, fit };
      sessions.set(id, session);
      terminals.set(id, term);
    } else if (session.term.element && session.term.element.parentNode !== this) {
      // The terminal was shown somewhere else (the panel, another tile): bring it here, still running.
      this.appendChild(session.term.element);
    }
    const { term, fit } = session;
    const size = () => {
      if (!this.clientWidth || !this.clientHeight) return;
      try { fit.fit(); host.term.resize(id, term.cols, term.rows); } catch (_) {}
    };
    size();
    if (fresh) {
      // What the terminal has printed since the line being typed began: a line that was
      // typed and never shown (a password) is told from a command by it.
      host.term.onData(id, (data) => { term.write(data); if ((session.seen ?? "").length < 20000) session.seen = (session.seen ?? "") + data; });
      await host.term.create(id, this.getAttribute("shell") || "", this.getAttribute("cwd") || "", term.cols, term.rows);
      term.onData((data) => {
        // Asked before the keys are sent on, so the answer is about the moment before Enter:
        // whether the shell itself was waiting, or a program it runs (git asking for a password, say).
        const waiting = data.includes("\r") && (session.line ?? "").trim() ? Promise.resolve(host.term.atPrompt?.(id)).catch(() => null) : null;
        host.term.write(id, data);
        typed(session, id, data, waiting);
      });
    }
    this.resizer?.disconnect();
    this.resizer = new ResizeObserver(size);
    this.resizer.observe(this);
    if (this.hasAttribute("autofocus")) term.focus();
  }
  disconnectedCallback() {
    // Leaving the page is not the end of a terminal; only kill_terminal is.
    this.resizer?.disconnect();
  }
}
if (inPage) customElements.define("runes-terminal", TerminalView);

let onCommand = () => {};
/**
 * Follows what is typed into a terminal so it can be named after the last command. This
 * sees keys, not the shell: a command recalled from history or finished by Tab is missed,
 * and the name then stays what it was.
 */
function typed(session, id, data, waiting) {
  if (data.length > 1 && data[0] === "\x1b") { session.recalled = true; return; }
  for (const ch of data) {
    if (ch === "\r") {
      const line = (session.line ?? "").trim(), shown = printed(session.seen ?? "");
      const recalled = session.recalled;
      session.line = ""; session.recalled = false; session.seen = "";
      if (!line || recalled) continue;
      // Never a name: anything that reads as a secret; what was typed and not shown (a
      // password); and what was typed while a program the shell started had the terminal
      // (git asking who you are, say), which the shell knows where the system can tell it.
      const name = nameFor(line);
      if (!name || !wasShown(line, shown)) continue;
      Promise.resolve(waiting).then((atPrompt) => { if (atPrompt !== false) onCommand(id, name); });
    } else if (ch === "\x7f") session.line = (session.line ?? "").slice(0, -1);
    else if (ch === "\x03" || ch === "\x15") { session.line = ""; session.recalled = false; }
    else if (ch === "\t") session.recalled = true;
    else if (ch >= " ") {
      // What counts as the line being shown is what is printed from its first character on:
      // not the question before it, which may well hold the letters of a short password.
      if (!(session.line ?? "")) session.seen = "";
      session.line = (session.line ?? "") + ch;
    }
  }
}
export function watch(on_command, on_focus, on_exit) {
  onCommand = on_command;
  if (!inPage) return;
  // A shell that has ended takes its terminal with it.
  host.term?.onExit?.((id) => { sessions.get(id)?.term.dispose(); sessions.delete(id); on_exit(id); });
  let last = 0;
  window.addEventListener("focus", () => { if (Date.now() - last > 1500) { last = Date.now(); on_focus(); } });
  // Links in rendered Markdown never navigate the window; the shell asks before opening one.
  document.addEventListener("click", (e) => {
    const link = e.target.closest?.("a[data-href]");
    if (!link) return;
    e.preventDefault();
    host.openLink?.(link.dataset.href);
  });
}

export function kill_terminal(id) {
  host.term?.kill(id);
  sessions.get(id)?.term.dispose();
  sessions.delete(id);
  terminals.delete(id);
}

export function focus_terminal(id) {
  // Not while a terminal is being renamed: taking the keyboard would end the renaming early.
  setTimeout(() => { if (!document.getElementById("runes-rename")) terminals.get(id)?.focus(); }, 60);
}

// --- The host: the desktop shell when there is one, else a workspace kept in the browser -----

const SAMPLE = {
  "/workspace/README.md": "# Runes\n\nA code editor written in **Bea**.\n\nThis is the browser preview: files live in this tab only, and there are no\nterminals or language servers. The desktop app has both.\n\n```bea\npub def main() -> Nil {\n  io.println(\"hello from Bea\")\n}\n```\n",
  "/workspace/src/orders.bea": "//// The ordering subdomain.\n\npub type Line {\n  item: String,\n  quantity: Int,\n  price: Int,\n}\n\npub type OrderError {\n  Empty\n  BadQuantity(item: String)\n}\n\npub def total(lines: List(Line)) -> Result(Int, OrderError) {\n  lines != [] else Error(Empty)\n  checked = list.try_map(lines, check)?\n  Ok(checked |> list.map(fn(line) { line.quantity * line.price }) |> int.sum)\n}\n\ndef check(line: Line) -> Result(Line, OrderError) {\n  case line.quantity > 0 {\n    True -> Ok(line)\n    False -> Error(BadQuantity(line.item))\n  }\n}\n",
  "/workspace/src/shapes.gleam": "pub type Shape {\n  Circle(radius: Float)\n  Rectangle(width: Float, height: Float)\n}\n\npub fn area(shape: Shape) -> Float {\n  case shape {\n    Circle(radius) -> 3.14159 *. radius *. radius\n    Rectangle(width, height) -> width *. height\n  }\n}\n",
  "/workspace/web/app.js": "const button = document.querySelector(\"#count\");\nlet clicks = 0;\n\nbutton.addEventListener(\"click\", () => {\n  clicks += 1;\n  button.textContent = `Clicked ${clicks} times`;\n});\n",
  "/workspace/bea.toml": "name = \"shop\"\nversion = \"0.1.0\"\n",
};

function browserHost() {
  let files;
  try { files = JSON.parse(localStorage.getItem("runes-files") ?? "null"); } catch (_) { files = null; }
  files ??= { ...SAMPLE };
  const keep = () => { try { localStorage.setItem("runes-files", JSON.stringify(files)); } catch (_) {} };
  const vsix = new Map();
  return {
    native: false,
    info: async () => ({ version: "0.1.0", platform: "browser" }),
    root: async () => "/workspace",
    pickFolder: async () => "",
    readDir: async (path) => {
      const seen = new Map();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(path + "/")) continue;
        const rest = file.slice(path.length + 1).split("/");
        seen.set(rest[0], rest.length > 1);
      }
      return [...seen];
    },
    walk: async (root) => Object.keys(files).filter((f) => f.startsWith(root + "/")),
    readFile: async (path) => {
      if (!(path in files)) throw new Error("No such file: " + path);
      return files[path];
    },
    writeFile: async (path, text) => { files[path] = text; keep(); },
    saveAs: async (name) => "/workspace/" + name,
    extensions: async () => [...vsix],
    installExtension: async (name, bytes) => { vsix.set(name, bytes); return ""; },
    removeExtension: async (name) => { vsix.delete(name); },
    userFiles: async () => {
      files["/settings/settings.json"] ??= "";
      files["/settings/keybindings.json"] ??= "[\n]\n";
      return { settings: "/settings/settings.json", keybindings: "/settings/keybindings.json" };
    },
    search: async (root, query, options) => {
      const re = pattern(query, options.regex, options.matchCase, options.word);
      const out = [];
      if (!re) return out;
      for (const [path, text] of Object.entries(files)) {
        if (!path.startsWith(root + "/")) continue;
        text.split("\n").forEach((line, i) => {
          re.lastIndex = 0;
          const m = re.exec(line);
          if (m && m[0]) out.push([path, i, m.index, m[0].length, line.slice(0, 300)]);
        });
      }
      return out;
    },
    replaceInFiles: async () => ({ files: 0, count: 0, error: "Replacing across files needs the desktop app" }),
    zoom: () => {},
    devtools: () => {},
  };
}

const host = globalThis.runesHost ? { native: true, ...globalThis.runesHost } : browserHost();

const sorted = (entries) =>
  entries.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] ? -1 : 1));
const message = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function read_dir(path, done) {
  host.readDir(path).then((entries) => done(toList(sorted(entries))), () => done(toList([])));
}
// --- Changing the files of the open folder -------------------------------------------------------

export function file_create(path, folder, done) {
  if (!host.fileCreate) return done("Making files needs the desktop app.");
  host.fileCreate(path, folder).then(() => done(""), (e) => done(message(e)));
}
export function file_rename(from, to, done) {
  if (!host.fileRename) return done("Renaming needs the desktop app.");
  host.fileRename(from, to).then(() => done(""), (e) => done(message(e)));
}
/** `done(removed, problem)`: the shell asks first, and `removed` is false when the answer was no. */
export function file_remove(path, done) {
  if (!host.fileRemove) return done(false, "Deleting needs the desktop app.");
  host.fileRemove(path).then((yes) => done(!!yes, ""), (e) => done(false, message(e)));
}
export const file_reveal = (path) => { host.fileReveal?.(path); };
export const copy_text = (text) => { navigator.clipboard?.writeText(text).catch(() => {}); };
/** Which folders the explorer has open: those are the ones followed for changes made elsewhere. */
let following = "";
export function watch_dirs(dirs) {
  const list = dirs.toArray(), key = list.join("\n");
  if (key === following) return;
  following = key;
  host.watchDirs?.(list);
}
/** `on_change(folders whose contents changed, files whose text changed, whether git should be asked again)`. */
export function files_listen(on_change) {
  host.onFiles?.((change) => on_change(toList(change.dirs ?? []), toList(change.files ?? []), !!change.git));
}
export function read_file(path, done) {
  host.readFile(path).then((text) => done(text.replace(/\r\n?/g, "\n"), ""), (e) => done("", message(e)));
}
export function write_file(path, text, done) {
  host.writeFile(path, text).then(() => done(""), (e) => done(message(e)));
}
export function pick_folder(done) {
  host.pickFolder().then((path) => path && done(path), () => {});
}
export function save_as(name, done) {
  host.saveAs(name).then((path) => path && done(path), () => {});
}
export function walk(root, done) {
  host.walk(root).then((files) => done(toList(files.sort())), () => done(toList([])));
}
export function after(ms, callback) {
  setTimeout(callback, ms);
}
export function user_files(done) {
  host.userFiles().then((f) => done(f.settings, f.keybindings), () => done("", ""));
}
export const strip_comments = (text) => relaxed(text);
export function global_search(root, query, regex, matchCase, word, done) {
  host.search(root, query, { regex, matchCase, word }).then((found) => done(toList(found), ""), (e) => done(toList([]), message(e)));
}
export function replace_in_files(root, query, regex, matchCase, word, replace, skip, done) {
  host.replaceInFiles(root, query, { regex, matchCase, word }, replace, skip.toArray())
    .then((r) => done(r.files, r.count, r.error ?? ""), (e) => done(0, 0, message(e)));
}
export const zoom = (by) => host.zoom(by);
export const toggle_devtools = () => host.devtools();

// --- Language features, from the extension host ------------------------------------------------

let requests = 0;
const waiting = new Map();
const unsent = new Map();

/**
 * Starts Runes afresh. The files that are open are noted first and opened again afterwards;
 * nothing else is carried over.
 */
export function reload_window(open) {
  try { sessionStorage.setItem("runes-reopen", JSON.stringify(open.toArray().slice(0, 40))); } catch {}
  if (host.reload) host.reload(); else location.reload();
}
/** Scrolls a list to its end once it has been drawn, unless it has been scrolled back up to read. */
const pinned = new Map();
export function keep_at_end(id) {
  const before = document.getElementById(id);
  const follow = !before || pinned.get(id) !== false || before.scrollHeight - before.scrollTop - before.clientHeight < 40;
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    if (follow) el.scrollTop = el.scrollHeight;
    if (!el.dataset.watched) {
      el.dataset.watched = "1";
      el.addEventListener("scroll", () => pinned.set(id, el.scrollHeight - el.scrollTop - el.clientHeight < 40));
    }
  });
}

/** The files that were open when Runes was last reloaded, once. */
export function reopened() {
  try {
    const found = JSON.parse(sessionStorage.getItem("runes-reopen") ?? "[]");
    sessionStorage.removeItem("runes-reopen");
    return toList(Array.isArray(found) ? found.filter((f) => typeof f === "string") : []);
  } catch { return toList([]); }
}

// --- Extensions: which are switched off, and how the ones with code are getting on ---------------

let onRunning = () => {};
/** `done(ids)`: the extensions that are switched off, as "publisher.name" in lower case. */
export function ext_disabled(done) {
  if (!host.extensionsDisabled) return done(toList([]));
  host.extensionsDisabled().then((ids) => done(toList(ids)), () => done(toList([])));
}
export function ext_enable(id, on, done) {
  if (!host.extensionEnable) return done(toList([]), "Switching extensions on and off needs the desktop app.");
  host.extensionEnable(id, on).then((ids) => done(toList(ids), ""), (e) => done(toList([]), message(e)));
}
export const ext_restart = () => { host.extensionsRestart?.(); };
/**
 * `done(list)`: every extension with code, as [id, name, version, state, milliseconds to
 * start, error, lines dropped, lines], a line being [time, channel, text].
 */
export function ext_running(done) {
  if (!host.extensionsRunning) return done(toList([]));
  host.extensionsRunning().then((all) => done(toList(all.map((e) => [e.id, e.name, e.version, e.state, e.ms | 0, e.error ?? "", e.dropped | 0,
    toList(e.lines.map((l) => [new Date(l[0]).toTimeString().slice(0, 8), l[1], l[2]]))]))), () => done(toList([])));
}
/** `changed()` whenever an extension starts, stops or says something. */
export function ext_running_listen(changed) { onRunning = changed; }

// --- The explorer: several files at once, copying, moving, and files from outside -----------------

/** `done(new paths, problem)`. */
export function file_place(sources, into, move, done) {
  if (!host.filePlace) return done(toList([]), "Copying and moving need the desktop app.");
  host.filePlace(sources.toArray(), into, move).then((made) => done(toList(made), ""), (e) => done(toList([]), message(e)));
}
export function file_import(paths, into, done) {
  if (!host.fileImport) return done(toList([]), "Bringing files in needs the desktop app.");
  host.fileImport(paths.toArray(), into).then((made) => done(toList(made), ""), (e) => done(toList([]), message(e)));
}
/** Files copied in the system's file manager: `done(their paths)`. */
export function clipboard_files(done) {
  if (!host.clipboardFiles) return done(toList([]));
  Promise.resolve(host.clipboardFiles()).then((found) => done(toList(found ?? [])), () => done(toList([])));
}
/** `done(paths that are gone, problem)`: the shell asks once for all of them. */
export function files_remove(paths, done) {
  if (!host.filesRemove) return done(toList([]), "Deleting needs the desktop app.");
  host.filesRemove(paths.toArray()).then((gone) => done(toList(gone), ""), (e) => done(toList([]), message(e)));
}

const TREE_KEYS = new Set(["ctrl+c", "ctrl+x", "ctrl+v", "delete", "f2", "ctrl+a", "escape", "ctrl+z"]);
/** Puts back what the explorer last deleted: `done(paths put back, how many could not be, problem)`. */
export function file_undo(done) {
  if (!host.fileUndo) return done(toList([]), 0, "Undoing a deletion needs the desktop app.");
  host.fileUndo().then((r) => done(toList(r.restored ?? []), (r.kept ?? []).length, ""), (e) => done(toList([]), 0, message(e)));
}
/** Gives the keyboard to the explorer itself: what had it there has just been deleted. */
export function focus_tree() {
  // A moment later: the question that was asked hands the keyboard back to the editor as it closes.
  setTimeout(() => {
    if (document.activeElement?.matches?.("input:not([type=checkbox]), textarea:not(#runes-input), select") || document.activeElement?.closest?.("runes-terminal, runes-canvas")) return;
    document.querySelector(".tree.files")?.focus({ preventScroll: true });
  }, 90);
}
/**
 * The explorer's own keys and its dragging. `on_key(chord)` for a key pressed while a file or
 * folder of the tree has the keyboard; `on_move(sources, folder, copy)` when files of the tree
 * are dropped on a folder; `on_import(paths, folder)` when files from outside Runes are.
 */
export function tree_listen(on_key, on_move, on_import) {
  if (!inPage) return;
  const tree = (e) => e.target.closest?.(".tree.files");
  const folderOf = (e) => {
    const node = e.target.closest?.(".tree.files .node[data-path]");
    const root = document.querySelector(".tree.files")?.dataset.root ?? "";
    if (!node) return [root, null];
    if (node.classList.contains("folder")) return [node.dataset.path, node];
    const parent = node.dataset.path.slice(0, node.dataset.path.lastIndexOf("/"));
    return [parent || root, document.querySelector(`.tree.files .node.folder[data-path="${CSS.escape(parent)}"]`)];
  };
  const unmark = () => { for (const el of document.querySelectorAll(".drop-into")) el.classList.remove("drop-into"); };
  document.addEventListener("keydown", (e) => {
    if (!e.target.closest?.(".tree.files") || e.target.matches("input")) return;
    const chord = chordOf(e);
    if (!TREE_KEYS.has(chord)) return;
    e.preventDefault();
    e.stopPropagation();
    on_key(chord);
  }, true);
  document.addEventListener("dragstart", (e) => {
    const node = e.target.closest?.(".tree.files .node[data-path]");
    if (!node || !e.dataTransfer) return;
    // Dragging one of several chosen files takes them all; dragging another takes only it.
    const chosen = [...document.querySelectorAll(".tree.files .node.picked[data-path]")].map((n) => n.dataset.path);
    const paths = chosen.includes(node.dataset.path) ? chosen : [node.dataset.path];
    e.dataTransfer.setData("application/x-runes-paths", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copyMove";
  });
  document.addEventListener("dragover", (e) => {
    if (!tree(e)) return unmark();
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes("application/x-runes-paths") && !types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes("Files") || e.ctrlKey ? "copy" : "move";
    const [, node] = folderOf(e);
    const mark = node ?? tree(e);
    if (!mark.classList.contains("drop-into")) { unmark(); mark.classList.add("drop-into"); }
  });
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !e.relatedTarget.closest?.(".tree.files")) unmark(); });
  document.addEventListener("dragend", unmark);
  document.addEventListener("drop", (e) => {
    unmark();
    if (!tree(e)) return;
    const [folder] = folderOf(e);
    const own = e.dataTransfer?.getData("application/x-runes-paths");
    if (own) {
      e.preventDefault(); e.stopPropagation();
      let paths = [];
      try { paths = JSON.parse(own).filter((p) => typeof p === "string"); } catch {}
      if (paths.length && folder) on_move(toList(paths), folder, e.ctrlKey);
      return;
    }
    const files = [...(e.dataTransfer?.files ?? [])];
    // An extension dropped on the tree is still an extension to install.
    if (!files.length || files.every((f) => f.name.endsWith(".vsix"))) return;
    e.preventDefault(); e.stopPropagation();
    const paths = files.map((f) => host.pathOf?.(f) ?? "").filter(Boolean);
    if (paths.length && folder) on_import(toList(paths), folder);
  }, true);
}

export function ext_listen(on_diagnostics, on_note, on_edits) {
  if (!host.ext) return;
  host.ext.on((m) => {
    if (m.type === "diagnostics") {
      on_diagnostics(m.path, toList(m.items.map((d) => [d.line, d.col, d.endLine, d.endCol, d.severity, d.message, d.source ?? ""])));
    } else if (m.type === "response") {
      const done = waiting.get(m.id);
      waiting.delete(m.id);
      done?.(m.result);
    } else if (m.type === "language") {
      if (typeof m.language === "string" && typeof m.rules === "string") onLanguage(m.language, m.rules);
    } else if (m.type === "running") {
      onRunning();
    } else if (m.type === "note") {
      on_note(m.level, m.text);
    } else if (m.type === "edits") {
      for (const file of m.files) on_edits(file.path, toList(file.edits.map((e) => [e.line, e.col, e.endLine, e.endCol, e.text])));
    }
  });
}

function flush(path) {
  const pending = unsent.get(path);
  if (!pending) return;
  clearTimeout(pending.timer);
  unsent.delete(path);
  host.ext.send({ type: "changed", path, version: pending.version, text: pending.lines.toArray().join("\n") });
}

export function doc_opened(path, language, lines) {
  host.ext?.send({ type: "opened", path, language, text: lines.toArray().join("\n") });
}
export function doc_changed(path, version, lines) {
  if (!host.ext) return;
  clearTimeout(unsent.get(path)?.timer);
  unsent.set(path, { version, lines, timer: setTimeout(() => flush(path), 140) });
}
export function doc_closed(path) {
  unsent.delete(path);
  host.ext?.send({ type: "closed", path });
}
export function doc_saved(path) {
  if (!host.ext) return;
  flush(path);
  host.ext.send({ type: "saved", path });
}

function ask(kind, path, line, col, done, more = {}) {
  if (!host.ext) return;
  if (kind !== "command" && kind !== "applyAction") flush(path);
  const id = ++requests;
  waiting.set(id, done);
  // A server's first answers can take a while (it is still reading the project): they are
  // waited for. An answer about a place the cursor has since left is dropped where it lands.
  setTimeout(() => waiting.delete(id), 45000);
  host.ext.send({ type: "request", id, kind, path, line, col, ...more });
}

const actionKind = (a) => (a.preferred ? "preferred fix" : a.kind.startsWith("refactor") ? "refactor" : a.kind.startsWith("source") ? "source action" : a.kind === "command" ? "command" : "quick fix");
/** What extensions offer to do for a stretch of a file (fixes, refactorings, source actions): a list of [id, title, kind in words]. */
export function lsp_actions(path, line, col, endLine, endCol, done) {
  ask("codeActions", path, line, col, (found) => done(toList((found ?? []).map((a) => [a.id, a.title, actionKind(a)]))), { endLine, endCol });
}
// The light bulb: whether anything is on offer where the cursor has come to rest. Asked only
// once it has rested, and an answer for a place the cursor has left is dropped.
let bulbTimer = 0, bulbTurn = 0;
export function lsp_actions_soon(path, line, col, endLine, endCol, done) {
  clearTimeout(bulbTimer);
  const turn = ++bulbTurn;
  if (!host.ext) return;
  bulbTimer = setTimeout(() => {
    ask("codeActions", path, line, col, (found) => { if (turn === bulbTurn) done((found ?? []).length, (found ?? []).some((a) => a.kind.startsWith("quickfix") || a.preferred)); }, { endLine, endCol, quiet: true });
  }, 350);
}
export function lsp_apply_action(id, done) {
  ask("applyAction", "", id, 0, (problem) => done(problem ?? ""));
}
/** Run a command an extension contributes. */
export function ext_command(command, done) {
  ask("command", command, 0, 0, (problem) => done(problem ?? ""));
}

const editRows = (edits) => toList((edits ?? []).map((e) => [e.line, e.col, e.endLine, e.endCol, e.text]));
/**
 * Asks the language's extensions what could be written here. `ch` is the character just typed
 * when it is not part of a word ("" otherwise). `done(known, incomplete, items)`: `known` is
 * false when that character means nothing to them, and the list on show should stay as it is.
 * An item is [label, detail, insert, snippet, kind, start, after, filter, sort, doc, id, edits].
 */
export function lsp_complete(path, line, col, ch, done) {
  if (!host.ext) return;
  ask("completion", path, line, col, (answer) => {
    if (!answer) return done(false, false, toList([]));
    done(true, !!answer.incomplete, toList(answer.items.map((i) =>
      [i.label, i.detail, i.insert, i.snippet, i.kind, i.start, i.after, i.filter, (i.first ? "\u0000" : "") + i.sort, i.doc, i.id, editRows(i.edits)])));
  }, { ch });
}
/** What a server left for later about one item: `done(detail, doc, edits)`. Asked once it has been rested on. */
let resolveTimer = 0;
export function lsp_resolve(id, wait, done) {
  clearTimeout(resolveTimer);
  const go = () => ask("resolveCompletion", "", id, 0, (found) => found && done(found.detail ?? "", found.doc ?? "", editRows(found.edits)));
  if (wait) resolveTimer = setTimeout(go, 120); else go();
}

/**
 * Which of the items fit what has been typed, best first. Each item says where its text starts
 * on the line (`start`); what stands between there and the cursor is matched against the
 * item's `filter` text the way VS Code does it: the letters must appear in order, the first of
 * them at the start of a word in the item, and an item that simply begins with what was typed
 * beats one that only contains it. Ties go by the server's own order (`sort`).
 */
export function rank_items(items, line, col) {
  const out = [];
  const boundary = (text, i) => i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]) || (/\p{Lu}/u.test(text[i]) && /\p{Ll}/u.test(text[i - 1]));
  let order = 0;
  // The same thing offered twice (a snippet two extensions both bring, a word the server
  // names too) is shown once: the first of them, which is the server's.
  const seen = new Set();
  for (const item of items) {
    order++;
    if (item.start > col) continue;
    const same = item.label + "\u0000" + (item.kind === "word" ? "" : item.insert);
    if (seen.has(same) || (item.kind === "word" && seen.has(item.label + "\u0000"))) continue;
    seen.add(same); seen.add(item.label + "\u0000");
    const typed = line.slice(item.start, col), wanted = typed.toLowerCase();
    const text = item.filter, lower = text.toLowerCase();
    let score = 0;
    if (wanted) {
      if (lower.startsWith(wanted)) score = 100000 - text.length + (text.startsWith(typed) ? 50 : 0);
      else {
        // In order, starting at the start of a word; letters that follow one another or begin a word count for more.
        let best = -1;
        for (let first = lower.indexOf(wanted[0]); first !== -1 && first < lower.length; first = lower.indexOf(wanted[0], first + 1)) {
          if (!boundary(text, first)) continue;
          let at = first, points = 1000 - first, ok = true;
          for (let i = 1; i < wanted.length; i++) {
            const next = lower.indexOf(wanted[i], at + 1);
            if (next === -1) { ok = false; break; }
            points += next === at + 1 ? 30 : boundary(text, next) ? 20 : -(next - at);
            at = next;
          }
          if (ok && points > best) best = points;
        }
        if (best < 0) continue;
        score = best;
      }
      // What is typed already, and nothing more, is no suggestion at all.
      if (text === typed && item.insert === typed) continue;
    }
    out.push([item, score, order]);
  }
  // Words of the file are a stand-in for a language server: once one has answered, they go.
  const kept = out.some((entry) => entry[0].id >= 0) ? out.filter((entry) => entry[0].kind !== "word") : out;
  kept.sort((a, b) => b[1] - a[1] || (a[0].sort < b[0].sort ? -1 : a[0].sort > b[0].sort ? 1 : 0) || a[2] - b[2]);
  return toList(kept.slice(0, 300).map((entry) => entry[0]));
}
/** Keeps the chosen suggestion in sight as the choice moves down a long list. */
export function suggest_reveal() {
  // Only the list itself is moved. Asking the browser to bring the option into view would
  // scroll the editor too, sideways as well: the line numbers went out of sight with it.
  requestAnimationFrame(() => {
    const on = document.querySelector(".suggest .option.on"), list = on?.closest(".suggest");
    if (!list) return;
    const a = on.getBoundingClientRect(), b = list.getBoundingClientRect();
    if (a.top < b.top + 4) list.scrollTop -= b.top + 4 - a.top;
    else if (a.bottom > b.bottom - 4) list.scrollTop += a.bottom - (b.bottom - 4);
  });
}

/**
 * Something that floats over the text at a place in it: the suggestions, a hover, the help
 * for a call. It is placed against the window, not inside the text, so that however wide or
 * tall it is, it adds nothing to what the editor can be scrolled to: before this, a wide
 * list of suggestions gave the editor a sideways scroll bar and broke the wrapping of lines.
 * `x` is in characters and `y` in pixels, both from the top left of the text; `h` is the
 * height of a line; `side="above"` puts it over its line and not under.
 */
class Float extends (globalThis.HTMLElement ?? class {}) {
  static observedAttributes = ["x", "y", "h", "side"];
  connectedCallback() {
    this.scroller = this.closest(".scroller");
    this.again = () => this.place();
    this.scroller?.addEventListener("scroll", this.again, { passive: true });
    window.addEventListener("resize", this.again);
    this.sizes = new ResizeObserver(this.again);
    this.sizes.observe(this);
    if (this.scroller) this.sizes.observe(this.scroller);
    this.place();
  }
  disconnectedCallback() {
    this.scroller?.removeEventListener("scroll", this.again);
    window.removeEventListener("resize", this.again);
    this.sizes?.disconnect();
  }
  attributeChangedCallback() { if (this.isConnected) this.place(); }
  place() {
    const scroller = this.scroller;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const num = (name) => Number(this.getAttribute(name)) || 0;
    const width = this.offsetWidth, height = this.offsetHeight, row = num("h");
    const line = box.top + num("y") - scroller.scrollTop;
    // Kept within the window: against its right edge when it would run past it.
    const left = Math.max(box.left + 4, Math.min(box.left + num("x") * (charWidth || measure()) - scroller.scrollLeft, window.innerWidth - 8 - width));
    const below = line + row + 4, above = line - 4 - height;
    const over = this.getAttribute("side") === "above" ? above >= 4 || below + height > window.innerHeight - 4 : below + height > window.innerHeight - 8 && above >= 4;
    this.style.left = Math.round(left) + "px";
    this.style.top = Math.round(over ? Math.max(4, above) : below) + "px";
    this.classList.toggle("over", over);
    // Its line has been scrolled out of the editor: it goes with it.
    this.style.visibility = line + row < box.top || line > box.bottom ? "hidden" : "";
  }
}
if (inPage) customElements.define("runes-float", Float);
/** A hover, as Markdown. */
export function lsp_hover(path, line, col, done) {
  ask("hover", path, line, col, (text) => text && done(String(text).slice(0, 12000)));
}
/** What the call at a place expects: `done(found, label, from, to, about, doc, index, count)`. */
export function lsp_signature(path, line, col, ch, open, done) {
  if (!host.ext) return;
  ask("signature", path, line, col, (s) => (s ? done(true, s.label, s.from, s.to, s.about, s.doc, s.index, s.count) : done(false, "", 0, 0, "", "", 0, 0)), { ch, open });
}
/**
 * The named things of a file, from a language server: `done(known, [[name, kind, line, last line, depth]])`.
 * Asked once the text has rested; an answer overtaken by a newer question is dropped.
 */
let symbolTimer = 0, symbolTurn = 0;
export function lsp_symbols_soon(path, done) {
  clearTimeout(symbolTimer);
  const turn = ++symbolTurn;
  if (!host.ext) return;
  symbolTimer = setTimeout(() => {
    ask("symbols", path, 0, 0, (found) => { if (turn === symbolTurn) done(!!found, toList((found ?? []).map((s) => [s.name, s.kind, s.line, s.endLine, s.depth]))); });
  }, 400);
}
/** What a line is inside, going by indentation alone: a list of [name, line]. See scopes_at in the layout. */
export const scopes_at = (key, version, lines, line) => toList(Layout.scopes_at(key, version, lines, line));
export function lsp_definition(path, line, col, done) {
  ask("definition", path, line, col, (at) => at && done(at.path, at.line, at.col));
}
export function lsp_format(path, done) {
  ask("format", path, 0, 0, (edits) =>
    done(toList((edits ?? []).map((e) => [e.line, e.col, e.endLine, e.endCol, e.text]))));
}

/** Which slice of a pie the pointer is over: -1 near the centre. Slice 0 points up. */
export function pie_index(cx, cy, x, y, count) {
  const dx = x - cx, dy = y - cy;
  if (Math.hypot(dx, dy) < 34 || count < 1) return -1;
  const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
  return Math.round(turn * count) % count;
}
/** Whether the pointer has gone well past the ring of slices. */
export const pie_far = (cx, cy, x, y) => Math.hypot(x - cx, y - cy) > 170;
export const window_size = () => [window.innerWidth, window.innerHeight];

// Chromium starts a drag without help; other engines want some data on it.
if (inPage) window.addEventListener("dragstart", (e) => {
  try { e.dataTransfer.setData("text/plain", e.target?.dataset?.path ?? "runes"); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
});
export const identity = (x) => x;

// --- Version control, the marketplace, settings and dates ------------------------------------------

export function git_status(done) {
  if (!host.gitStatus) return done(false, "", 0, 0, toList([]));
  host.gitStatus().then((s) => done(s.repo, s.branch, s.ahead, s.behind, toList(s.files)), () => done(false, "", 0, 0, toList([])));
}
export function git_tree(at, done) {
  if (!host.gitTree) return done(toList([]));
  host.gitTree(at).then((files) => done(toList(files)), () => done(toList([])));
}
export function git_history(path, from, done) {
  if (!host.gitHistory) return done(toList([]), "");
  host.gitHistory(path, from).then((r) => done(toList(r.commits), r.at), () => done(toList([]), ""));
}
export function git_days(done) {
  if (!host.gitDays) return done(toList([]));
  host.gitDays().then((days) => done(toList(days)), () => done(toList([])));
}
export function git_log(limit, until, done) {
  if (!host.gitLog) return done(toList([]));
  host.gitLog(limit, until).then((commits) => done(toList(commits.map(([h, p, a, t, r, s]) => [h, toList(p), a, t, toList(r), s]))), () => done(toList([])));
}
export function git_show(hash, done) {
  host.gitShow?.(hash).then((text) => done(text), (e) => done(message(e)));
}
export function git_stage(paths, staged, done) {
  (staged ? host.gitStage : host.gitUnstage)(paths.toArray()).then(() => done(""), (e) => done(message(e)));
}
/** `done(discarded, problem)`: the shell asks first, and `discarded` is false when the answer was no. */
export function git_discard(paths, done) {
  if (!host.gitDiscard) return done(false, "Discarding needs the desktop app.");
  host.gitDiscard(paths.toArray()).then((yes) => done(!!yes, ""), (e) => done(false, message(e)));
}
// Blame follows the cursor, so it is asked for only once the cursor has rested a moment, and
// an answer that arrives after the cursor has moved on is dropped. `text` is called only if
// the question is really put: it makes the whole file's text, for unsaved work.
let blameTimer = 0, blameTurn = 0;
export function git_blame(path, line, dirty, text, done) {
  clearTimeout(blameTimer);
  const turn = ++blameTurn;
  if (!host.gitBlame) return;
  blameTimer = setTimeout(() => {
    host.gitBlame(path, line, dirty ? text() : null).then((found) => {
      if (turn !== blameTurn) return;
      if (!found) done(false, "", "", 0, "");
      else done(true, found.hash, found.author, found.time, found.summary);
    }, () => { if (turn === blameTurn) done(false, "", "", 0, ""); });
  }, 180);
}
/** How long ago a moment (seconds since 1970) was, in a few words. */
export function ago(time) {
  const seconds = Math.max(0, Date.now() / 1000 - time);
  const units = [[31557600, "year"], [2629800, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return n + " " + name + (n === 1 ? "" : "s") + " ago";
  }
  return "just now";
}

export function market_search(query, done) {
  if (!host.marketSearch) return done(toList([]), "The marketplace needs the desktop app.");
  host.marketSearch(query).then((found) => done(toList(found), ""), (e) => done(toList([]), message(e)));
}
export function market_install(namespace, name, done) {
  host.marketDownload(namespace, name).then((bytes) => install(`${namespace}.${name}.vsix`, bytes, done), (e) => done("", "", message(e)));
}

/** settings.json with one key set. `value` is JSON text; comments in the file are not kept. */
export function set_setting(text, key, value) {
  let all = {};
  try { all = JSON.parse(relaxed(text)) ?? {}; } catch (_) {}
  if (typeof all !== "object" || Array.isArray(all)) all = {};
  try { all[key] = JSON.parse(value); } catch (_) { return text; }
  return JSON.stringify(all, null, 2) + "\n";
}

const pad = (n) => String(n).padStart(2, "0");
/** The local day a moment falls on, as "2026-11-14". */
export function day_of(seconds) {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function when(seconds) {
  return new Date(seconds * 1000).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
/** The year and month (1 to 12) a moment falls in; now, when given 0. */
export function month_of(seconds) {
  const d = seconds ? new Date(seconds * 1000) : new Date();
  return [d.getFullYear(), d.getMonth() + 1];
}
/** Six weeks of days for a month, Monday first: "" outside the month, else "2026-11-14". */
export function month_grid(year, month) {
  const first = new Date(year, month - 1, 1);
  const days = new Date(year, month, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = i - lead + 1;
    cells.push(day >= 1 && day <= days ? `${year}-${pad(month)}-${pad(day)}` : "");
  }
  return toList(cells);
}
export function month_name(year, month) {
  return new Date(year, month - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}
/** Brings a group's active tab into sight when there are more tabs than fit. */
export function reveal_tab(group) {
  if (!inPage) return;
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.querySelector(`.group[data-group="${group}"] .tab.on`)?.scrollIntoView({ block: "nearest", inline: "nearest" })));
}
export function show_element(id) {
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" }));
}

export function git_file(at, path, done) {
  if (!host.gitFile) return done(toList([]), false);
  // null: the file is not in that commit, or there is no repository. That is not the same as empty.
  host.gitFile(at, path).then((text) => done(toList(!text ? [] : text.replace(/\r\n?/g, "\n").split("\n")), text !== null && text !== undefined), () => done(toList([]), false));
}
export function git_changed(from, to, done) {
  if (!host.gitChanged) return done("", toList([]), "Comparing needs the desktop app.");
  host.gitChanged(from, to).then((r) => done(r.base, toList(r.files), ""), (e) => done("", toList([]), message(e)));
}
export function git_refs(done) {
  if (!host.gitRefs) return done(toList([]));
  host.gitRefs().then((names) => done(toList(names)), () => done(toList([])));
}
export function market_readme(namespace, name, done) {
  if (!host.marketReadme) return done("");
  host.marketReadme(namespace, name).then((text) => done(String(text ?? "")), () => done(""));
}
/** The readme an installed extension came with. */
export function extension_readme(id) {
  const files = extensions.get(id)?.files;
  if (!files) return "";
  for (const [name, data] of files) if (/^readme(\.md|\.markdown|\.txt)?$/i.test(name)) return strFromU8(data).slice(0, 400 * 1024);
  return "";
}

// --- Markdown, drawn ----------------------------------------------------------------------------
// A small, strict renderer. Everything is escaped first, and only the tags written here are
// ever produced, so a document cannot bring markup or script of its own. Raw HTML in the
// source is dropped. Pictures are shown only when they are data: addresses; others become
// their description, because the window does not fetch from the network.

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function inline(text) {
  const held = [];
  const hold = (html) => { held.push(html); return "\x00" + (held.length - 1) + "\x00"; };
  let t = text.replace(/`([^`]+)`/g, (_, code) => hold("<code>" + esc(code) + "</code>"));
  t = t.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-zA-Z][^>]*>/g, "");
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, alt, src) =>
    /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? hold(`<img alt="${alt}" src="${src}">`) : alt ? hold(`<span class="md-image">${alt}</span>`) : "");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, label, href) => {
    const url = href.replace(/&amp;/g, "&");
    return /^https?:\/\//i.test(url) ? hold(`<a data-href="${esc(url)}" title="${esc(url)}" role="link" tabindex="0">`) + label + hold("</a>") : label;
  });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, lead, url) => lead + hold(`<a data-href="${url}" title="${url}" role="link" tabindex="0">${url}</a>`));
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return t.replace(/\x00(\d+)\x00/g, (_, n) => held[Number(n)]);
}
export function markdown(source, paint) {
  // What sits inside a script or style element is not prose: it goes, tags and all.
  const lines = source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  let last = -1;
  while (i < lines.length) {
    // Whatever a line holds, it is passed: a line no rule below moved on from is shown as it is.
    if (i === last) { out.push("<p>" + inline(lines[i]) + "</p>"); i++; continue; }
    last = i;
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line))) {
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre class="md-code"${m[2] ? ` data-language="${esc(m[2])}"` : ""}><code>${paint?.(body, m[2]) ?? esc(body.join("\n"))}</code></pre>`);
    } else if ((m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; }
    else if (/^\s*>/.test(line)) {
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push("<blockquote>" + markdown(body.join("\n")) + "</blockquote>");
    } else if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(line), body = [];
      for (i += 2; i < lines.length && /\|/.test(lines[i]) && lines[i].trim(); i++) body.push(cells(lines[i]));
      out.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"
        + body.map((r) => "<tr>" + head.map((_, n) => `<td>${inline(r[n] ?? "")}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
      const ordered = /\d/.test(m[2]), indent = m[1].length, items = [];
      const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
      while (i < lines.length) {
        const found = bullet.exec(lines[i]);
        if (found && found[1].length === indent && /\d/.test(found[2]) !== ordered) break;
        else if (found && found[1].length === indent) { items.push([found[3]]); i++; }
        else if (lines[i].trim() && /^\s/.test(lines[i]) && lines[i].search(/\S/) > indent && items.length) { items[items.length - 1].push(lines[i]); i++; }
        else if (!lines[i].trim() && i + 1 < lines.length && (bullet.exec(lines[i + 1])?.[1].length === indent || (/^\s/.test(lines[i + 1]) && lines[i + 1].search(/\S/) > indent))) i++;
        else break;
      }
      const item = ([first, ...rest]) => {
        const box = /^\[([ xX])\]\s+(.*)$/.exec(first);
        const head = box ? `<span class="md-box${box[1] === " " ? "" : " done"}"></span>` + inline(box[2]) : inline(first);
        const cut = rest.length ? Math.min(...rest.map((l) => l.search(/\S/))) : 0;
        return "<li>" + head + (rest.length ? markdown(rest.map((l) => l.slice(cut)).join("\n")) : "") + "</li>";
      };
      out.push((ordered ? "<ol>" : "<ul>") + items.map(item).join("") + (ordered ? "</ol>" : "</ul>"));
    } else if (/^\s*<!--/.test(line)) { while (i < lines.length && !lines[i].includes("-->")) i++; i++; }
    else {
      const body = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) body.push(lines[i].trim());
      if (i + 1 <= lines.length && body.length === 1 && /^=+\s*$/.test(lines[i] ?? "")) { out.push(`<h1>${inline(body[0])}</h1>`); i++; continue; }
      const text = inline(body.join("\n")).trim();
      if (text) out.push("<p>" + text.replace(/\n/g, " ") + "</p>");
    }
  }
  return out.join("\n");
}
const drawn = new Map();
/** The HTML for a document's Markdown, worked out again only when the text has changed. */
export function markdown_html(key, version, lines) {
  const had = drawn.get(key);
  if (had && had.version === version && had.lines === lines) return had.html;
  const html = markdown(lines.toArray().join("\n"));
  drawn.set(key, { version, lines, html });
  if (drawn.size > 40) drawn.delete(drawn.keys().next().value);
  return html;
}
/**
 * Markdown from a language server (a hover, an item's documentation), drawn by the same strict
 * renderer. Code in it is coloured with the grammar of the file it is about, when that is loaded.
 */
const richCache = new Map();
export function rich_text(text, scope) {
  const ready = !!(scope && grammar(scope));
  const key = scope + "\n" + ready + "\n" + themeVersion + "\n" + text;
  let html = richCache.get(key);
  if (html === undefined) {
    html = markdown(text, (lines) => {
      const found = ready && lines.length <= 400 ? coloured(lines, scope) : null;
      if (!found) return null;
      return found.map((pieces) => pieces.map(([piece, style]) => (style ? `<span style="${esc(style)}">${esc(piece)}</span>` : esc(piece))).join("")).join("\n");
    });
    richCache.set(key, html);
    if (richCache.size > 60) richCache.delete(richCache.keys().next().value);
  }
  return html;
}
export const markdown_text = (key, text) => {
  const had = drawn.get(key);
  if (had && had.text === text) return had.html;
  const html = markdown(text);
  drawn.set(key, { text, html });
  return html;
};

export function market_icon(url, done) {
  host.marketIcon?.(url).then((data) => data && done(data), () => {});
}

const iconUrls = new Map();
/** The icon an installed extension ships, as an address the page can show; "" when it has none. */
export function extension_icon(id, path) {
  const key = id + "\n" + path;
  if (!iconUrls.has(key)) {
    const data = path && extensions.get(id)?.files.get(tidy(path));
    const type = /\.svg$/i.test(path) ? "image/svg+xml" : /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
    iconUrls.set(key, data ? URL.createObjectURL(new Blob([data], { type })) : "");
  }
  return iconUrls.get(key);
}

// --- Comparing two texts ---------------------------------------------------------------------------

/** Myers' shortest edit script over lines: a string of "=", "-" and "+" per step. */
function script(a, b) {
  const n = a.length, m = b.length;
  // Trim what is the same at both ends first; real edits are usually small.
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail++;
  const A = a.slice(head, n - tail), B = b.slice(head, m - tail);
  const N = A.length, M = B.length;
  let middle;
  if (N === 0) middle = "+".repeat(M);
  else if (M === 0) middle = "-".repeat(N);
  else if (N + M > 40000) middle = "-".repeat(N) + "+".repeat(M);
  else {
    const max = N + M, offset = max;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= N && y >= M) { found = d; break; }
      }
      if (d > 6000) break;
    }
    if (found < 0) middle = "-".repeat(N) + "+".repeat(M);
    else {
      const steps = [];
      let x = N, y = M;
      for (let d = found; d > 0; d--) {
        const row = trace[d], at = (k) => row[k + d + 1];
        const k = x - y;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const prevK = down ? k + 1 : k - 1;
        const prevX = at(prevK), prevY = prevX - prevK;
        while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) { steps.push("="); x--; y--; }
        steps.push(down ? "+" : "-");
        x = prevX; y = prevY;
      }
      while (x > 0 && y > 0) { steps.push("="); x--; y--; }
      middle = steps.reverse().join("");
    }
  }
  return "=".repeat(head) + middle + "=".repeat(tail);
}

/**
 * Two texts side by side: rows of [kind, left number, left text, right number, right text].
 * Kinds: "=" same, "-" only on the left, "+" only on the right, "~" changed, and "…" for a run
 * of unchanged lines folded away (its left text is how many). `context` < 0 folds nothing.
 */
const rowsCache = new WeakMap();
/** Every line of a text as coloured pieces, when the grammar is ready and the text is not huge. */
function coloured(lines, scope) {
  if (!scope || lines.length > 8000 || !grammar(scope)) return null;
  const cache = { scope, theme: themeVersion, version: 0, texts: [], states: [], tokens: [] };
  extend(cache, lines, lines.length);
  return cache.tokens;
}
/**
 * Rows of a side-by-side comparison: [kind, left number, left text, right number, right text,
 * left pieces, right pieces]. The pieces carry the syntax colours.
 */
export function diff_rows(left, right, context, scope) {
  // The view asks again on every frame; the answer only changes when a side does.
  const ready = !!(scope && grammar(scope));
  const had = rowsCache.get(left);
  if (had && had.right === right && had.context === context && had.scope === scope && had.ready === ready && had.theme === themeVersion) return had.rows;
  const a = left.toArray(), b = right.toArray();
  const ca = ready ? coloured(a, scope) : null, cb = ready ? coloured(b, scope) : null;
  const plain = (text) => toList(text ? [[text, ""]] : []);
  const rows = toList(diff_rows_now(left, right, context).toArray().map((row) => [...row,
    row[1] >= 0 && ca?.[row[1]] ? toList(ca[row[1]]) : plain(row[0] === "…" ? "" : row[2]),
    row[3] >= 0 && cb?.[row[3]] ? toList(cb[row[3]]) : plain(row[4])]));
  rowsCache.set(left, { right, context, scope, ready, theme: themeVersion, rows });
  return rows;
}
function diff_rows_now(left, right, context) {
  const a = left.toArray(), b = right.toArray();
  const ops = script(a, b);
  const rows = [];
  let i = 0, j = 0, at = 0;
  while (at < ops.length) {
    if (ops[at] === "=") { rows.push(["=", i, a[i], j, b[j]]); i++; j++; at++; continue; }
    let gone = 0, came = 0;
    while (at < ops.length && ops[at] !== "=") { if (ops[at] === "-") gone++; else came++; at++; }
    const both = Math.min(gone, came);
    for (let n = 0; n < both; n++) rows.push(["~", i + n, a[i + n], j + n, b[j + n]]);
    for (let n = both; n < gone; n++) rows.push(["-", i + n, a[i + n], -1, ""]);
    for (let n = both; n < came; n++) rows.push(["+", -1, "", j + n, b[j + n]]);
    i += gone; j += came;
  }
  if (context < 0) return toList(rows);
  const keep = new Uint8Array(rows.length);
  rows.forEach((row, n) => {
    if (row[0] === "=") return;
    for (let k = Math.max(0, n - context); k <= Math.min(rows.length - 1, n + context); k++) keep[k] = 1;
  });
  const out = [];
  for (let n = 0; n < rows.length; ) {
    if (keep[n]) { out.push(rows[n++]); continue; }
    let run = n;
    while (run < rows.length && !keep[run]) run++;
    out.push(["…", -1, String(run - n), -1, ""]);
    n = run;
  }
  return toList(out);
}

const marksCache = new Map();
/**
 * What has changed in a file since a base version, for the gutter: a list of [line, kind],
 * kind "add", "mod" or "del" (lines were removed just above this one).
 */
export function change_marks(key, version, base_id, base, lines) {
  const cached = marksCache.get(key);
  if (cached && cached.version === version && cached.base === base_id) return cached.marks;
  const a = base.toArray(), b = lines.toArray();
  const ops = script(a, b);
  const out = [], hunks = [];
  let i = 0, j = 0, at = 0;
  while (at < ops.length) {
    if (ops[at] === "=") { i++; j++; at++; continue; }
    let gone = 0, came = 0;
    while (at < ops.length && ops[at] !== "=") { if (ops[at] === "-") gone++; else came++; at++; }
    // Where the change is drawn: its own lines, or for a pure removal the line it sits against.
    hunks.push({ start: j, came, old: a.slice(i, i + gone), now: b.slice(j, j + came), mark: came ? j : Math.min(j, Math.max(b.length - 1, 0)), total: b.length, last: b[b.length - 1] ?? "", before: b[j - 1] ?? "" });
    i += gone;
    const both = Math.min(gone, came);
    for (let n = 0; n < both; n++) out.push([j + n, "mod"]);
    for (let n = both; n < came; n++) out.push([j + n, "add"]);
    if (gone > came) out.push([Math.min(j + came, Math.max(b.length - 1, 0)), came === 0 ? "del" : "mod"]);
    j += came;
  }
  const marks = toList(out);
  marksCache.set(key, { version, base: base_id, marks, hunks });
  return marks;
}

const hunkAt = (key, line) => (marksCache.get(key)?.hunks ?? []).find((h) => line >= h.mark && line < h.mark + Math.max(h.came, 1));
/**
 * The change a gutter mark stands for: [which one (from 1), how many there are, the first
 * line it covers, the last, the lines as committed, the lines as they are now]. Zero for
 * "which one" when there is no change on that line.
 */
export function change_at(key, line) {
  const hunks = marksCache.get(key)?.hunks ?? [], h = hunkAt(key, line);
  if (!h) return [0, hunks.length, 0, 0, toList([]), toList([])];
  return [hunks.indexOf(h) + 1, hunks.length, h.mark, h.mark + Math.max(h.came, 1) - 1, toList(h.old), toList(h.now)];
}
/** The line of the next change after this one (by 1) or the one before (by -1), going round. -1 for none. */
export function change_beside(key, line, by) {
  const hunks = marksCache.get(key)?.hunks ?? [];
  if (!hunks.length) return -1;
  const here = hunks.indexOf(hunkAt(key, line));
  const next = here < 0 ? (by > 0 ? hunks.findIndex((h) => h.mark > line) : hunks.findLastIndex((h) => h.mark < line)) : here + by;
  return hunks[((next < 0 && here < 0 ? (by > 0 ? 0 : hunks.length - 1) : next) + hunks.length) % hunks.length].mark;
}
/** The edit that puts a change back to what was committed: [[line, col, endLine, endCol, text]], or nothing. */
export function change_undone(key, line) {
  const h = hunkAt(key, line);
  if (!h) return toList([]);
  const text = h.old.join("\n");
  if (h.came && h.old.length) return toList([[h.start, 0, h.start + h.came - 1, h.now[h.came - 1].length, text]]);
  if (h.came) {
    // Lines that were added go, with the line break that came with them.
    if (h.start + h.came < h.total) return toList([[h.start, 0, h.start + h.came, 0, ""]]);
    if (h.start === 0) return toList([[0, 0, h.total - 1, h.last.length, ""]]);
    return toList([[h.start - 1, h.before.length, h.total - 1, h.last.length, ""]]);
  }
  // Lines that were removed come back where they were.
  if (h.start < h.total) return toList([[h.start, 0, h.start, 0, text + "\n"]]);
  return toList([[h.total - 1, h.last.length, h.total - 1, h.last.length, "\n" + text]]);
}
