// Runes' edge with the window: keyboard and clipboard, text measuring, TextMate
// tokenizing, VSIX archives, the minimap and terminal elements, and the host
// (the desktop shell, or an in-browser stand-in).
import { toList } from "../prelude.mjs";

// The npm packages are loaded when the editor boots, not when this file is read,
// so that `bea run` in plain Node can still say how Ink is meant to be started.
let textmate, oniguruma, unzipSync, strFromU8;
async function libraries() {
  textmate = await import("vscode-textmate");
  oniguruma = await import("vscode-oniguruma");
  ({ unzipSync, strFromU8 } = await import("fflate"));
}

const base = () => new URL("./", document.baseURI);
const TAB = 4;

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

/** The column on screen of a column in the text: tabs reach the next tab stop. */
export function vcol(line, col) {
  if (line.indexOf("\t") === -1) return col;
  let v = 0;
  for (let i = 0; i < col && i < line.length; i++) v += line[i] === "\t" ? TAB - (v % TAB) : 1;
  return v;
}

export function col_at(line, target) {
  if (line.indexOf("\t") === -1) return Math.min(target, line.length);
  let v = 0;
  for (let i = 0; i < line.length; i++) {
    const w = line[i] === "\t" ? TAB - (v % TAB) : 1;
    if (v + w / 2 > target) return i;
    v += w;
  }
  return line.length;
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

const FIELD_KEYS = /^(ctrl\+(a|z|y|c|x|v|d|\/|space|shift\+z|backspace|delete|home|end|arrow\w+|shift\+arrow\w+)|alt\+arrow\w+|shift\+alt\+f|f2|f8|shift\+f8|f12)$/;

export function set_chords(chords) {
  bound = new Set(chords.toArray());
}

function chordOf(e) {
  const key = e.key === " " ? "space" : e.key.toLowerCase();
  return [(e.ctrlKey || e.metaKey) && "ctrl", e.shiftKey && "shift", e.altKey && "alt", key].filter(Boolean).join("+");
}

export function listen(on_key, on_text, on_paste, on_resize, on_drop, on_zoom, on_pie, on_hover) {
  window.addEventListener("keydown", (e) => {
    if (e.isComposing || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const chord = chordOf(e);
    const inTerminal = !!e.target.closest?.("runes-terminal");
    if (inTerminal && !THROUGH_TERMINAL.test(chord)) return;
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

export function focus(id) {
  const go = () => {
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


/** The line and on-screen column under a point of the window, in one editor group. */
export function locate(group, x, y) {
  const content = document.getElementById("content-" + group);
  if (!content) return [0, 0];
  const box = content.getBoundingClientRect();
  const w = charWidth || measure();
  const gutter = (parseFloat(content.dataset.gutter) || 6) * w;
  return [Math.max(0, Math.floor((y - box.top) / LINE)), Math.max(0, Math.round((x - box.left - gutter) / w))];
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

const sessionRow = (s) => [s.id, s.name, s.host, s.user, s.port, s.key, s.folder, !!s.known, !!s.on];
export function ssh_sessions(done) {
  if (!host.sshSessions) return done(toList([]));
  host.sshSessions().then((all) => done(toList(all.map(sessionRow))), () => done(toList([])));
}
export function ssh_save(id, name, address, user, port, key, folder, done) {
  if (!host.sshSave) return done("SSH needs the desktop app.");
  host.sshSave({ id, name, host: address, user, port: Number(port) || 22, key, folder }).then(() => done(""), (e) => done(message(e)));
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
  if (!icons) return none;
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
    key ??= t.languageIds?.[language] ?? t.file;
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
      if (el) el.scrollTop = Math.max(0, line * LINE);
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
      host.term.onData(id, (data) => term.write(data));
      await host.term.create(id, this.getAttribute("shell") || "", this.getAttribute("cwd") || "", term.cols, term.rows);
      term.onData((data) => { host.term.write(id, data); typed(session, id, data); });
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
function typed(session, id, data) {
  if (data.length > 1 && data[0] === "\x1b") { session.recalled = true; return; }
  for (const ch of data) {
    if (ch === "\r") {
      const line = (session.line ?? "").trim();
      if (line && !session.recalled) onCommand(id, line);
      session.line = ""; session.recalled = false;
    } else if (ch === "\x7f") session.line = (session.line ?? "").slice(0, -1);
    else if (ch === "\x03" || ch === "\x15") { session.line = ""; session.recalled = false; }
    else if (ch === "\t") session.recalled = true;
    else if (ch >= " ") session.line = (session.line ?? "") + ch;
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
    checkUpdate: async () => null,
    zoom: () => {},
    devtools: () => {},
    openExternal: () => {},
  };
}

const host = globalThis.runesHost ? { native: true, ...globalThis.runesHost } : browserHost();

const sorted = (entries) =>
  entries.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] ? -1 : 1));
const message = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function read_dir(path, done) {
  host.readDir(path).then((entries) => done(toList(sorted(entries))), () => done(toList([])));
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
export function check_update(done) {
  host.checkUpdate().then((u) => u && done(u.version, u.url), () => {});
}
export const zoom = (by) => host.zoom(by);
export const toggle_devtools = () => host.devtools();
export const open_external = (url) => host.openExternal(url);

// --- Language features, from the extension host ------------------------------------------------

let requests = 0;
const waiting = new Map();
const unsent = new Map();

export function ext_listen(on_diagnostics, on_note, on_edits) {
  if (!host.ext) return;
  host.ext.on((m) => {
    if (m.type === "diagnostics") {
      on_diagnostics(m.path, toList(m.items.map((d) => [d.line, d.col, d.endLine, d.endCol, d.severity, d.message, d.source ?? ""])));
    } else if (m.type === "response") {
      const done = waiting.get(m.id);
      waiting.delete(m.id);
      done?.(m.result);
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
  setTimeout(() => waiting.delete(id), 8000);
  host.ext.send({ type: "request", id, kind, path, line, col, ...more });
}

/** The quick fixes extensions offer for a stretch of a file: a list of [id, title]. */
export function lsp_actions(path, line, col, endLine, endCol, done) {
  ask("codeActions", path, line, col, (found) => done(toList((found ?? []).map((a) => [a.id, a.title]))), { endLine, endCol });
}
export function lsp_apply_action(id, done) {
  ask("applyAction", "", id, 0, (problem) => done(problem ?? ""));
}
/** Run a command an extension contributes. */
export function ext_command(command, done) {
  ask("command", command, 0, 0, (problem) => done(problem ?? ""));
}

export function lsp_complete(path, line, col, done) {
  ask("completion", path, line, col, (items) =>
    done(toList((items ?? []).slice(0, 60).map((i) => [i.label, i.detail ?? "", i.insert ?? i.label, !!i.snippet]))));
}
export function lsp_hover(path, line, col, done) {
  ask("hover", path, line, col, (text) => text && done(String(text).slice(0, 4000)));
}
export function lsp_definition(path, line, col, done) {
  ask("definition", path, line, col, (at) => at && done(at.path, at.line, at.col));
}
export function lsp_format(path, done) {
  ask("format", path, 0, 0, (edits) =>
    done(toList((edits ?? []).map((e) => [e.line, e.col, e.endLine, e.endCol, e.text]))));
}

// --- AI chat -----------------------------------------------------------------------------------

let chats = 0;
export function ai_send(provider, model, baseUrl, messages, on_delta, on_done) {
  if (!host.ai) return on_done("AI chat needs the desktop app");
  const id = ++chats;
  host.ai.send(id, { provider, model, baseUrl, messages: messages.toArray().map(([role, content]) => ({ role, content })) }, (kind, text) => {
    if (kind === "delta") on_delta(text);
    else on_done(kind === "error" ? text : "");
  });
}
export function ai_set_key(provider, key, done) {
  if (!host.ai) return done("Keys can only be stored by the desktop app");
  host.ai.setKey(provider, key).then(() => done(""), (e) => done(message(e)));
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
export function git_commit(text, done) {
  host.gitCommit(text).then(() => done(""), (e) => done(message(e)));
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
export function git_switch(kind, name, done) {
  if (!host.gitSwitch) return done("Switching branches needs the desktop app.");
  host.gitSwitch(kind, name).then(() => done(""), (e) => done(message(e)));
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
export function markdown(source) {
  // What sits inside a script or style element is not prose: it goes, tags and all.
  const lines = source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line))) {
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre class="md-code"${m[2] ? ` data-language="${esc(m[2])}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
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
