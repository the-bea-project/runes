// The <runes-canvas> element: a Rune Canvas drawing on screen. See runes_canvas.mjs for the
// drawing as data and for the file it is kept in.
//
// The element is given the file's text (the `doc` property) and says when the drawing has
// changed (a "canvas-change" event carrying the new text). It keeps nothing itself between
// visits except where each board was scrolled to. Everything a file says is made safe as it is
// read, and text from it only ever reaches the page as text.
import {
  COLOURS, WIDTHS, DASHES, SIZES, HEADS, SHAPES, PALETTE,
  parse, serialize, cleanElement, cleanLink, freshId, box, around, hits, elementAt, retie, simplify, fit,
  rng, outline, cleanOutline, strokePath, arrowHead, wrap,
  nodes, middles, middle, bendAdded, bendMoved, bendRemoved, bendIsStraight, shifted, strokeCurve, approach,
  cleanSize, SMALLEST, LARGEST, withGroups, isGroup, grouped, ungrouped, regrouped,
} from "./runes_canvas.mjs";

const NS = "http://www.w3.org/2000/svg";
const inPage = typeof window !== "undefined" && typeof HTMLElement !== "undefined";
const host = inPage ? window.runesHost ?? {} : {};

const svg = (name, attrs = {}, children = []) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
};
const title = (text) => { const t = document.createElementNS(NS, "title"); t.textContent = text; return t; };
const el = (name, attrs = {}, children = []) => {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
};

// The signs on the buttons. These are fixed drawings of ours, never anything from a file.
const SIGNS = {
  select: "<path d='M5 3l14 8-6 2-2 6z'/>",
  hand: "<path d='M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.500a1.500 1.500 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2.500 7-6 7-3 0-4.500-1.500-6.500-5L3 13.500c-.6-1.200.9-2.300 2-1.300L8 15'/>",
  rect: "<rect x='4' y='6' width='16' height='12' rx='2'/>",
  diamond: "<path d='M12 3l9 9-9 9-9-9z'/>",
  ellipse: "<ellipse cx='12' cy='12' rx='9' ry='7'/>",
  arrow: "<path d='M4 20L20 4M11 4h9v9'/>",
  line: "<path d='M4 20L20 4'/>",
  draw: "<path d='M4 20l3-1L19 7l-2-2L5 17z'/><path d='M14 8l2 2'/>",
  text: "<path d='M5 6V4h14v2M12 4v16M9 20h6'/>",
  eraser: "<path d='M8 20h12M5 16l9-11 6 5-8 10H8z'/>",
  undo: "<path d='M8 5L4 9l4 4'/><path d='M4 9h9.500a5.500 5.500 0 0 1 0 11H10'/>",
  redo: "<path d='M16 5l4 4-4 4'/><path d='M20 9h-9.500a5.500 5.500 0 0 0 0 11H14'/>",
  minus: "<path d='M5 12h14'/>", plus: "<path d='M12 5v14M5 12h14'/>",
  fit: "<path d='M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'/>",
  grid: "<path d='M4 4h16v16H4zM4 9.300h16M4 14.700h16M9.300 4v16M14.700 4v16'/>",
  magnet: "<path d='M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4'/>",
  group: "<rect x='7' y='7' width='10' height='10' rx='1.500'/><path d='M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3'/>",
  ungroup: "<rect x='4' y='4' width='9' height='9' rx='1.500'/><rect x='11' y='11' width='9' height='9' rx='1.500'/>",
  front: "<path d='M12 19V5M6 11l6-6 6 6'/>", back: "<path d='M12 5v14M6 13l6 6 6-6'/>",
  copy: "<rect x='8' y='8' width='12' height='12' rx='2'/><path d='M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'/>",
  trash: "<path d='M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'/>",
  link: "<path d='M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1'/><path d='M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1'/>",
  export: "<path d='M12 15V4M7 9l5-5 5 5M5 15v5h14v-5'/>",
  code: "<path d='M8 7l-5 5 5 5M16 7l5 5-5 5'/>",
  help: "<circle cx='12' cy='12' r='9'/><path d='M9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.7.400-1 .900-1 1.700M12 17h.01'/>",
};
const sign = (name) => `<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>${SIGNS[name]}</svg>`;

const TOOLS = [
  ["select", "Select", "v", "1"], ["hand", "Move the board", "h", ""], ["rect", "Rectangle", "r", "2"], ["diamond", "Diamond", "d", "3"],
  ["ellipse", "Ellipse", "o", "4"], ["arrow", "Arrow", "a", "5"], ["line", "Line", "l", "6"], ["draw", "Draw", "p", "7"],
  ["text", "Text", "t", "8"], ["eraser", "Eraser", "e", "0"],
];
const KEYS = [
  ["1 – 8, or the letter on a tool", "pick a tool"], ["Double click", "write: on the board, in a shape, on an arrow"], ["Pull the middle of a line or arrow", "bends it there; pull again between two points for another bend. Double click a bend to take it out"], ["Drag an arrow onto a shape", "ties it there; it follows when the shape moves"],
  ["Space + drag, or the wheel", "move the board"], ["Ctrl + wheel", "zoom"], ["Shift while drawing", "squares, circles, straight angles"],
  ["Ctrl + click on a linked element", "open the file it points to"], ["Ctrl+D", "duplicate"], ["Ctrl+Z, Ctrl+Shift+Z", "undo, redo"],
  ["Ctrl+G, Ctrl+Shift+G", "group what is chosen into one thing; take a group apart again"], ["Alt + click", "choose one thing inside a group"],
  ["M", "lines and arrows stick to shapes, or do not. Alt while dragging: not this once"], ["Pull the corner of writing", "makes it larger or smaller"],
  ["Ctrl+] and Ctrl+[", "bring forward, send back"], ["Arrow keys", "nudge (Shift: further)"], ["Shift+1", "fit the drawing to the window"], ["Delete", "delete"],
];
const GRID = 20;
// What a person has chosen for every board, kept between sessions: whether lines and arrows
// stick to the shapes they touch. (Nothing about a drawing: that is all in its file.)
const prefs = { sticks: true };
try { Object.assign(prefs, JSON.parse(globalThis.localStorage?.getItem("runes-canvas") ?? "{}")); } catch {}
const keep = () => { try { globalThis.localStorage?.setItem("runes-canvas", JSON.stringify(prefs)); } catch {} };
const views = new Map();

// Outside a page (the unit tests load this file under Node) there is nothing to extend, and nothing is defined.
const Base = globalThis.HTMLElement ?? class {};

class RuneCanvas extends Base {
  connectedCallback() {
    if (this.ready) return this.fitSoon();
    this.ready = true;
    this.elements = [];
    this.selected = new Set();
    this.tool = "select";
    this.view = { x: 0, y: 0, k: 1 };
    this.style_ = { stroke: "ink", fill: "none", width: 2, dash: "solid", round: true, sketch: true, size: 20, head: "end" };
    this.undos = []; this.redos = [];
    this.nodes = new Map();
    this.lastText = null;
    this.grid = false;
    this.drag = null;
    this.tabIndex = 0;
    this.setAttribute("role", "application");
    this.setAttribute("aria-label", "Rune Canvas");

    this.world = svg("g", { class: "rc-world" });
    this.over = svg("g", { class: "rc-over" });
    this.gridRect = svg("rect", { class: "rc-grid", x: 0, y: 0, width: "100%", height: "100%", fill: "none" });
    this.pattern = svg("pattern", { id: "rc-dots-" + (RuneCanvas.count = (RuneCanvas.count ?? 0) + 1), patternUnits: "userSpaceOnUse", width: GRID, height: GRID }, [svg("circle", { cx: 1, cy: 1, r: 1 })]);
    this.board = svg("svg", { class: "rc-board", role: "img" }, [svg("defs", {}, [this.pattern]), this.gridRect, this.world, this.over]);
    this.tools = el("div", { class: "rc-tools", role: "toolbar", "aria-label": "Drawing tools" });
    this.props = el("div", { class: "rc-props", role: "group", "aria-label": "How the selection looks" });
    this.foot = el("div", { class: "rc-foot" });
    this.top = el("div", { class: "rc-top" });
    this.note = el("div", { class: "rc-note", role: "status", "aria-live": "polite" });
    this.write = el("textarea", { class: "rc-write", spellcheck: "false", "aria-label": "Text", hidden: true });
    this.append(this.board, this.tools, this.props, this.foot, this.top, this.note, this.write);
    this.measurer = document.createElement("canvas").getContext("2d");

    this.board.addEventListener("pointerdown", (e) => this.down(e));
    this.board.addEventListener("pointermove", (e) => this.move(e));
    this.board.addEventListener("pointerup", (e) => this.up(e));
    this.board.addEventListener("pointercancel", (e) => this.up(e));
    this.board.addEventListener("dblclick", (e) => this.twice(e));
    this.board.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.board.addEventListener("contextmenu", (e) => e.preventDefault());
    this.addEventListener("keydown", (e) => this.key(e));
    this.addEventListener("keyup", (e) => { if (e.key === " ") { this.space = false; this.cursor(); } });
    this.write.addEventListener("blur", () => this.written(true));
    this.write.addEventListener("input", () => this.sizeWrite());
    this.write.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.written(true); this.focus(); }
    });
    // The board follows the theme: its colours are names, and what a name looks like changes.
    this.themes = new MutationObserver(() => { this.forget(); this.paint(); });
    this.themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-kind", "style"] });
    this.resizer = new ResizeObserver(() => { if (this.wantFit && this.clientWidth) this.zoomFit(); this.paint(); });
    this.resizer.observe(this);
    this.chrome();
    if (this.pending) { const doc = this.pending; this.pending = null; this.doc = doc; }
    if (this.hasAttribute("autofocus")) requestAnimationFrame(() => { if (!this.contains(document.activeElement)) this.focus({ preventScroll: true }); });
  }
  disconnectedCallback() {
    if (this.path) views.set(this.path, { ...this.view });
  }
  get path() { return this.getAttribute("path") ?? ""; }
  get locked() { return this.hasAttribute("readonly"); }
  get kind() { return document.documentElement.dataset.kind === "light" ? "light" : "dark"; }
  colour(name) { return PALETTE[this.kind][name] ?? PALETTE[this.kind].ink; }

  /** The file's text, as the editor holds it: { version, text }. What the board itself last said is not loaded again. */
  set doc(value) {
    if (!this.ready) { this.pending = value; return; }
    const text = typeof value?.text === "string" ? value.text : "";
    if (text === this.lastText) return;
    const first = this.lastText === null;
    const read = parse(text);
    this.lastText = text;
    this.problem = read.problem;
    this.elements = retie(read.elements, this.measure);
    this.selected.clear();
    this.undos = []; this.redos = [];
    this.forget();
    const kept = views.get(this.path);
    if (first && kept) this.view = { ...kept };
    else if (first) this.wantFit = true;
    if (this.wantFit && this.clientWidth) this.zoomFit();
    this.chrome();
    this.paint();
  }
  get doc() { return { text: this.lastText ?? "" }; }

  fitSoon() { this.paint(); }

  // --- Sizes of writing ---
  font(size) { return `${size}px ${getComputedStyle(this).fontFamily}`; }
  wide(text, size) { this.measurer.font = this.font(size); return this.measurer.measureText(text).width; }
  measure = (item) => {
    const lines = item.text.split("\n");
    return { w: Math.max(8, ...lines.map((line) => this.wide(line, item.size))), h: lines.length * item.size * 1.25 };
  };

  // --- Changing the drawing ---
  /** Remembers the drawing as it is, to come back to with undo. Called before a change. */
  remember() {
    this.undos.push({ elements: this.elements, selected: [...this.selected] });
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
  }
  /** After a change: arrows meet their shapes again, the file's text is made, and the editor is told. */
  changed() {
    this.elements = retie(this.elements, this.measure);
    const text = serialize(this.elements);
    if (text !== this.lastText) {
      this.lastText = text;
      this.dispatchEvent(new CustomEvent("canvas-change", { detail: { text }, bubbles: true }));
    }
    this.chrome();
    this.paint();
  }
  /** One change, start to finish. `change(elements)` returns the new elements. */
  act(change) {
    if (this.locked) return;
    const next = change(this.elements);
    if (next === this.elements) return;
    this.remember();
    this.elements = next;
    this.changed();
  }
  undo() { this.step(this.undos, this.redos); }
  redo() { this.step(this.redos, this.undos); }
  step(from, to) {
    if (this.locked || !from.length) return;
    to.push({ elements: this.elements, selected: [...this.selected] });
    const state = from.pop();
    this.elements = state.elements;
    this.selected = new Set(state.selected.filter((id) => this.elements.some((e) => e.id === id)));
    this.changed();
  }
  chosen() { return this.elements.filter((e) => this.selected.has(e.id)); }
  /** Chooses elements. What is grouped is chosen whole, unless `inside` asks for the very things named. */
  select(ids, inside = false) { this.selected = inside ? new Set(ids) : withGroups(this.elements, ids); this.chrome(); this.paint(); }
  /** Makes what is chosen one group, to be chosen, moved and resized as one thing. */
  group() {
    if (this.locked || this.selected.size < 2 || isGroup(this.elements, this.selected)) return;
    const taken = new Set(this.elements.flatMap((e) => [e.id, ...(e.groups ?? [])]));
    const ids = this.selected;
    this.act((all) => grouped(all, ids, freshId(taken)));
  }
  /** Takes the chosen group apart: its parts are separate things again, all still chosen. */
  ungroup() {
    if (this.locked || !this.chosen().some((e) => e.groups?.length)) return;
    const ids = this.selected;
    this.act((all) => ungrouped(all, ids));
  }
  /** Makes the chosen writing larger or smaller; with nothing chosen, the writing that comes next. */
  scaleText(factor) {
    const step = (size) => { const next = cleanSize(size * factor); return next === size ? cleanSize(size + Math.sign(factor - 1)) : next; };
    if (!this.selected.size) { this.style_.size = step(this.style_.size); return this.chrome(); }
    this.act((all) => all.map((e) => (this.selected.has(e.id) && (e.type === "text" || e.text) ? { ...e, size: step(e.size) } : e)));
  }
  /** A shape a line's end would stick to at a point: none when sticking is off, or Alt is held. */
  tie(x, y, except, e) { return prefs.sticks && !e?.altKey ? this.shapeAt(x, y, except) : null; }
  /** Sets something about how the chosen elements look; with nothing chosen, about what is drawn next. */
  setStyle(key, value) {
    this.style_[key] = value;
    if (this.selected.size) this.act((all) => all.map((e) => (this.selected.has(e.id) && key in e ? { ...e, [key]: value } : e)));
    else this.chrome();
  }
  remove() {
    if (!this.selected.size) return;
    const gone = this.selected;
    this.act((all) => all.filter((e) => !gone.has(e.id)).map((e) => (e.from && gone.has(e.from)) || (e.to && gone.has(e.to)) ? { ...e, from: gone.has(e.from) ? "" : e.from, to: gone.has(e.to) ? "" : e.to } : e));
    this.select([]);
  }
  /** Copies of elements, with names of their own; arrows among them stay tied to the copies. */
  copies(items, dx, dy) {
    const taken = new Set(this.elements.map((e) => e.id)), names = new Map();
    for (const item of items) { const id = freshId(taken); taken.add(id); names.set(item.id, id); }
    for (const item of this.elements) for (const g of item.groups ?? []) taken.add(g);
    return regrouped(items.map((item) => ({ ...shifted(item, dx, dy), id: names.get(item.id), seed: Math.floor(Math.random() * 2 ** 31),
      ...(item.from !== undefined ? { from: names.get(item.from) ?? "", to: names.get(item.to) ?? "" } : {}) })), taken);
  }
  duplicate() {
    const made = this.copies(this.chosen(), GRID, GRID);
    if (!made.length) return;
    this.act((all) => [...all, ...made]);
    this.select(made.map((e) => e.id));
  }
  async copy(cut) {
    const items = this.chosen();
    if (!items.length) return;
    this.clip = JSON.stringify({ rune: "canvas-clip", elements: items });
    try { await navigator.clipboard.writeText(this.clip); } catch {}
    if (cut) this.remove();
  }
  async paste() {
    if (this.locked) return;
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { text = this.clip ?? ""; }
    let items = [];
    try { const raw = JSON.parse(text); if (raw?.rune === "canvas-clip" && Array.isArray(raw.elements)) items = raw.elements.slice(0, 2000).map((e) => cleanElement(e)).filter(Boolean); } catch {}
    const at = this.pointer ?? this.toWorld(this.clientWidth / 2, this.clientHeight / 2);
    if (!items.length && text.trim()) {
      // Plain text from elsewhere is put on the board as writing.
      const made = cleanElement({ type: "text", x: at[0], y: at[1], text: text.slice(0, 4000), size: this.style_.size, stroke: this.style_.stroke });
      if (made) items = [made];
    } else if (items.length) {
      const b = around(items, this.measure);
      items = this.copies(items, at[0] - (b.x + b.w / 2), at[1] - (b.y + b.h / 2));
    }
    if (!items.length) return;
    const taken = new Set(this.elements.map((e) => e.id));
    items = items.map((e) => (taken.has(e.id) ? { ...e, id: freshId(taken) } : e));
    this.act((all) => [...all, ...items]);
    this.select(items.map((e) => e.id));
  }
  order(front) {
    const picked = this.chosen();
    if (!picked.length) return;
    this.act((all) => { const rest = all.filter((e) => !this.selected.has(e.id)); return front ? [...rest, ...picked] : [...picked, ...rest]; });
  }
  nudge(dx, dy) {
    if (!this.selected.size) return;
    this.act((all) => all.map((e) => (this.selected.has(e.id) ? shifted(e, dx, dy) : e)));
  }

  // --- Where things are ---
  toWorld(sx, sy) { return [(sx - this.view.x) / this.view.k, (sy - this.view.y) / this.view.k]; }
  at(e) { const r = this.board.getBoundingClientRect(); return this.toWorld(e.clientX - r.left, e.clientY - r.top); }
  snap(v, e) { return this.grid && !e?.altKey ? Math.round(v / GRID) * GRID : Math.round(v); }
  zoomTo(k, sx = this.clientWidth / 2, sy = this.clientHeight / 2) {
    const next = Math.min(8, Math.max(0.1, k));
    const [wx, wy] = this.toWorld(sx, sy);
    this.view = { k: next, x: sx - wx * next, y: sy - wy * next };
    this.wantFit = false;
    this.chrome(); this.paint();
  }
  zoomFit() {
    const b = around(this.elements, this.measure), w = this.clientWidth, h = this.clientHeight;
    if (!w || !h) { this.wantFit = true; return; }
    this.wantFit = false;
    if (!b) this.view = { x: w / 2, y: h / 2, k: 1 };
    else {
      const k = Math.min(1, Math.max(0.1, Math.min((w - 160) / Math.max(b.w, 1), (h - 160) / Math.max(b.h, 1))));
      this.view = { k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k };
    }
    this.chrome(); this.paint();
  }

  // --- The pointer ---
  cursor() {
    const hand = this.tool === "hand" || this.space;
    this.board.style.cursor = this.drag?.kind === "pan" ? "grabbing" : hand ? "grab" : this.tool === "select" ? "default" : this.tool === "text" ? "text" : "crosshair";
  }
  down(e) {
    this.focus({ preventScroll: true });
    if (!this.write.hidden) this.written(true);
    const [x, y] = this.at(e);
    this.pointer = [x, y];
    this.board.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || this.tool === "hand" || this.space) {
      this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, view: { ...this.view } };
      return this.cursor();
    }
    if (e.button !== 0) return;
    const near = 6 / this.view.k;
    if (this.locked) { this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, view: { ...this.view } }; return this.cursor(); }
    if (this.tool === "select") {
      const handle = e.target.closest?.("[data-handle]")?.dataset.handle;
      if (handle) {
        const items = this.chosen();
        const [what, at] = handle.split(":");
        if (what === "bend") this.drag = { kind: "bend", index: Number(at), before: this.elements, item: items[0] };
        else if (what === "mid") {
          // Pulling the middle of a stretch makes a bend there, which is then the thing being dragged.
          const bent = bendAdded(items[0], Number(at), x, y);
          if (bent === items[0]) return this.tell("A line can bend " + (items[0].bends?.length ?? 0) + " times and no more.");
          this.drag = { kind: "bend", index: Number(at), before: this.elements, item: bent, fresh: true };
        }
        else this.drag = handle === "start" || handle === "end" ? { kind: "end", which: handle, before: this.elements, item: items[0] }
          : { kind: "resize", handle, before: this.elements, from: around(items, this.measure) };
        return;
      }
      const hit = elementAt(this.elements, x, y, near, this.measure);
      if (hit && (e.ctrlKey || e.metaKey) && hit.link) return this.follow(hit.link);
      if (hit) {
        // A click on something grouped chooses the whole group; with Alt, that one thing inside it.
        const whole = e.altKey ? new Set([hit.id]) : withGroups(this.elements, [hit.id]);
        if (e.shiftKey) { const next = new Set(this.selected); const had = next.has(hit.id); for (const id of whole) { if (had) next.delete(id); else next.add(id); } this.select(next, true); }
        else if (e.altKey) this.select(whole, true);
        else if (!this.selected.has(hit.id)) this.select(whole);
        this.drag = { kind: "move", x, y, before: this.elements, moved: false };
      } else {
        if (!e.shiftKey) this.select([]);
        this.drag = { kind: "marquee", x, y, x2: x, y2: y, had: new Set(this.selected) };
      }
      return;
    }
    if (this.tool === "eraser") { this.drag = { kind: "erase", before: this.elements, gone: new Set() }; return this.erase(x, y); }
    if (this.tool === "text") { this.drag = null; return this.writeAt(x, y); }
    const sx = this.snap(x, e), sy = this.snap(y, e);
    const base = { id: freshId(new Set(this.elements.map((k) => k.id))), type: this.tool, x: sx, y: sy, w: 0, h: 0, ...this.style_, text: "", link: "", seed: Math.floor(Math.random() * 2 ** 31) };
    if (this.tool === "draw") { base.x = x; base.y = y; base.points = [[0, 0]]; }
    if (this.tool === "arrow" || this.tool === "line") {
      base.head = this.tool === "arrow" ? this.style_.head : "none";
      base.to = "";
      const under = this.tie(x, y, undefined, e);
      base.from = under?.id ?? "";
    }
    const made = cleanElement({ ...base, ...(this.tool === "draw" ? { points: [[0, 0], [0.1, 0.1]] } : {}) });
    this.drag = { kind: "create", before: this.elements, item: made, raw: [[0, 0]] };
    this.elements = [...this.elements, made];
    this.paint();
  }
  /** A shape an arrow could tie to at a point: not another line, and not the thing being drawn. */
  shapeAt(x, y, except) {
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const item = this.elements[i];
      if (item.id === except || item.type === "line" || item.type === "arrow" || item.type === "draw") continue;
      const b = box(item, this.measure);
      if (x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8) return item;
    }
    return null;
  }
  replace(item) { this.elements = this.elements.map((k) => (k.id === item.id ? item : k)); }
  move(e) {
    const [x, y] = this.at(e);
    this.pointer = [x, y];
    const d = this.drag;
    if (!d) {
      if (this.tool === "select" && !this.locked) {
        const hit = elementAt(this.elements, x, y, 6 / this.view.k, this.measure);
        this.board.style.cursor = e.target.closest?.("[data-handle]") ? "nwse-resize" : hit ? (hit.link && (e.ctrlKey || e.metaKey) ? "pointer" : "move") : this.space ? "grab" : "default";
      }
      return;
    }
    if (d.kind === "pan") { this.view = { ...d.view, x: d.view.x + e.clientX - d.sx, y: d.view.y + e.clientY - d.sy }; this.wantFit = false; return this.paint(); }
    if (d.kind === "move") {
      let dx = x - d.x, dy = y - d.y;
      if (!d.moved && Math.hypot(dx, dy) * this.view.k < 3) return;
      d.moved = true;
      if (this.grid && !e.altKey) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
      const moving = this.selected;
      // A tied arrow is carried by its shapes; one that is moved by itself comes untied.
      this.elements = retie(d.before.map((k) => {
        if (!moving.has(k.id)) return k;
        if ((k.type === "arrow" || k.type === "line") && (k.from || k.to)) {
          const both = (!k.from || moving.has(k.from)) && (!k.to || moving.has(k.to));
          return both ? shifted(k, dx, dy) : (moving.size === 1 ? { ...shifted(k, dx, dy), from: "", to: "" } : k);
        }
        return shifted(k, dx, dy);
      }), this.measure);
      return this.paint();
    }
    if (d.kind === "marquee") {
      d.x2 = x; d.y2 = y;
      const x0 = Math.min(d.x, x), y0 = Math.min(d.y, y), x1 = Math.max(d.x, x), y1 = Math.max(d.y, y);
      const inside = this.elements.filter((k) => { const b = box(k, this.measure); return b.x >= x0 && b.y >= y0 && b.x + b.w <= x1 && b.y + b.h <= y1; }).map((k) => k.id);
      this.selected = new Set([...d.had, ...inside]);
      return this.paint();
    }
    if (d.kind === "erase") return this.erase(x, y);
    if (d.kind === "resize") {
      const from = d.from, h = d.handle;
      let x0 = from.x, y0 = from.y, x1 = from.x + from.w, y1 = from.y + from.h;
      const px = this.snap(x, e), py = this.snap(y, e);
      if (h.includes("w")) x0 = Math.min(px, x1 - 4); if (h.includes("e")) x1 = Math.max(px, x0 + 4);
      if (h.includes("n")) y0 = Math.min(py, y1 - 4); if (h.includes("s")) y1 = Math.max(py, y0 + 4);
      // Writing keeps its shape: it only ever grows or shrinks, whichever way its corner is pulled.
      const lettering = d.before.filter((k) => this.selected.has(k.id)).every((k) => k.type === "text");
      if ((e.shiftKey || lettering) && from.w && from.h && h.length === 2) {
        const k = Math.max((x1 - x0) / from.w, (y1 - y0) / from.h);
        if (h.includes("w")) x0 = x1 - from.w * k; else x1 = x0 + from.w * k;
        if (h.includes("n")) y0 = y1 - from.h * k; else y1 = y0 + from.h * k;
      }
      const to = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      this.elements = retie(d.before.map((k) => (this.selected.has(k.id) ? fit(k, from, to) : k)), this.measure);
      return this.paint();
    }
    if (d.kind === "bend") {
      if (!d.moved && !d.fresh && Math.hypot(x - d.item.bends[d.index][0], y - d.item.bends[d.index][1]) * this.view.k < 2) return;
      d.moved = true;
      const next = bendMoved(d.item, d.index, this.snap(x, e), this.snap(y, e));
      d.now = next;
      this.elements = retie(d.before.map((k) => (k.id === next.id ? next : k)), this.measure);
      return this.paint();
    }
    if (d.kind === "end") {
      const item = d.item;
      const under = this.tie(x, y, item.id, e);
      const px = under ? x : this.snap(x, e), py = under ? y : this.snap(y, e);
      const next = d.which === "start" ? { ...item, x: px, y: py, w: item.x + item.w - px, h: item.y + item.h - py, from: under?.id ?? "" }
        : { ...item, w: px - item.x, h: py - item.y, to: under?.id ?? "" };
      d.under = under?.id ?? "";
      this.elements = retie(d.before.map((k) => (k.id === item.id ? next : k)), this.measure);
      return this.paint();
    }
    if (d.kind === "create") {
      let item = d.item;
      if (item.type === "draw") {
        d.raw.push([x - item.x, y - item.y]);
        item = { ...item, points: d.raw.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) };
      } else {
        let w = this.snap(x, e) - item.x, h = this.snap(y, e) - item.y;
        if (e.shiftKey) {
          if (item.type === "arrow" || item.type === "line") {
            // The nearest of eight directions.
            const angle = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4), length = Math.hypot(w, h);
            w = Math.cos(angle) * length; h = Math.sin(angle) * length;
          } else { const side = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * side; h = Math.sign(h || 1) * side; }
        }
        item = { ...item, w, h };
        if (item.type === "arrow" || item.type === "line") { const under = this.tie(x, y, item.id, e); d.under = under && under.id !== item.from ? under.id : ""; }
      }
      d.item = item;
      this.replace(item);
      return this.paint();
    }
  }
  erase(x, y) {
    const d = this.drag;
    const hit = elementAt(this.elements, x, y, 8 / this.view.k, this.measure);
    if (hit) { d.gone.add(hit.id); this.elements = this.elements.filter((k) => k.id !== hit.id); this.paint(); }
  }
  up(e) {
    const d = this.drag;
    this.drag = null;
    this.cursor();
    if (!d) return;
    const commit = (next) => { this.elements = d.before; this.act(() => next); };
    if (d.kind === "pan") { if (this.path) views.set(this.path, { ...this.view }); return; }
    if (d.kind === "marquee") { this.selected = withGroups(this.elements, this.selected); this.chrome(); return this.paint(); }
    if (d.kind === "move") { if (d.moved) commit(this.elements); return; }
    if (d.kind === "resize") return commit(this.elements);
    if (d.kind === "erase") {
      const gone = d.gone;
      if (gone.size) commit(this.elements.map((k) => (k.from && gone.has(k.from)) || (k.to && gone.has(k.to)) ? { ...k, from: gone.has(k.from) ? "" : k.from, to: gone.has(k.to) ? "" : k.to } : k));
      return;
    }
    if (d.kind === "end") return commit(this.elements);
    if (d.kind === "bend") {
      if (!d.moved) { this.elements = d.before; return this.paint(); }
      // A bend left on the straight way between its neighbours is no bend: it is taken out.
      const straight = d.now && bendIsStraight(d.now, d.index, 4 / this.view.k);
      return commit(straight ? retie(this.elements.map((k) => (k.id === d.now.id ? bendRemoved(k, d.index) : k)), this.measure) : this.elements);
    }
    if (d.kind === "create") {
      let item = d.item;
      if (item.type === "draw") {
        if (d.raw.length < 2) { this.elements = d.before; return this.paint(); }
        item = { ...item, points: simplify(d.raw, 0.8 / this.view.k).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) };
      } else if (Math.hypot(item.w, item.h) * this.view.k < 6) {
        // A click, not a drag: nothing was drawn.
        this.elements = d.before;
        return this.paint();
      } else if (item.type === "arrow" || item.type === "line") {
        item = { ...item, to: d.under ?? "" };
      } else if (item.w < 0 || item.h < 0) {
        item = { ...item, x: Math.min(item.x, item.x + item.w), y: Math.min(item.y, item.y + item.h), w: Math.abs(item.w), h: Math.abs(item.h) };
      }
      const safe = cleanElement(item);
      if (!safe) { this.elements = d.before; return this.paint(); }
      commit([...d.before, safe]);
      this.selected = new Set([safe.id]);
      // Shapes are drawn one at a time; a pen keeps drawing.
      if (item.type !== "draw") this.pick("select"); else { this.chrome(); this.paint(); }
    }
  }
  twice(e) {
    if (this.locked || this.tool !== "select") return;
    // Twice on a bend takes the bend out.
    // (Found by where the pointer is: the handles are drawn afresh between the two clicks.)
    const [x, y] = this.at(e);
    const lone = this.chosen().length === 1 ? this.chosen()[0] : null;
    if (lone && (lone.type === "line" || lone.type === "arrow")) {
      const reach = 9 / this.view.k;
      const index = (lone.bends ?? []).findIndex(([bx, by]) => Math.hypot(bx - x, by - y) <= reach);
      if (index >= 0) return this.act((all) => retie(all.map((k) => (k.id === lone.id ? bendRemoved(k, index) : k)), this.measure));
      if (middles(lone).some(([mx, my]) => Math.hypot(mx - x, my - y) <= reach)) return;
    }
    // Anywhere inside a shape writes in that shape, whether it is filled or not.
    const inside = [...this.elements].reverse().find((k) => SHAPES.includes(k.type) && x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
    const hit = elementAt(this.elements, x, y, 6 / this.view.k, this.measure) ?? inside;
    if (hit && hit.type !== "draw") return this.writeIn(hit);
    if (!hit) this.writeAt(x, y);
  }
  wheel(e) {
    e.preventDefault();
    const r = this.board.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) return this.zoomTo(this.view.k * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    this.view = { ...this.view, x: this.view.x - (e.shiftKey ? e.deltaY : e.deltaX), y: this.view.y - (e.shiftKey ? 0 : e.deltaY) };
    this.wantFit = false;
    if (this.path) views.set(this.path, { ...this.view });
    this.paint();
  }
  follow(link) { this.dispatchEvent(new CustomEvent("canvas-link", { detail: { link }, bubbles: true })); }

  // --- Writing ---
  writeAt(x, y) {
    if (this.locked) return;
    const item = { id: freshId(new Set(this.elements.map((k) => k.id))), type: "text", x, y: y - this.style_.size * 0.6, w: 0, h: 0, ...this.style_, fill: "none", text: "", align: "left", link: "", seed: 1, fresh: true };
    this.writing = item;
    this.showWrite(item, "");
  }
  writeIn(item) {
    this.writing = item;
    this.showWrite(item, item.text);
    this.paint();
  }
  showWrite(item, text) {
    const w = this.write;
    w.hidden = false;
    w.value = text;
    w.style.font = this.font(item.size * this.view.k);
    w.style.color = this.colour(item.stroke);
    w.style.textAlign = item.type === "text" ? "left" : "center";
    this.sizeWrite();
    w.focus();
    w.select();
  }
  sizeWrite() {
    const item = this.writing, w = this.write;
    if (!item) return;
    const k = this.view.k, lines = w.value.split("\n");
    const wide = Math.max(40, ...lines.map((line) => this.wide(line || " ", item.size))) * k + 16, tall = lines.length * item.size * 1.25 * k + 4;
    let left, top;
    if (item.type === "text") { left = item.x * k + this.view.x; top = item.y * k + this.view.y; }
    else {
      const b = item.type === "arrow" || item.type === "line" ? { x: middle(item)[0], y: middle(item)[1], w: 0, h: 0 } : box(item, this.measure);
      left = (b.x + b.w / 2) * k + this.view.x - wide / 2; top = (b.y + b.h / 2) * k + this.view.y - tall / 2;
    }
    Object.assign(w.style, { left: left + "px", top: top + "px", width: wide + "px", height: tall + "px", lineHeight: item.size * 1.25 * k + "px" });
  }
  written(keep) {
    const item = this.writing, w = this.write;
    if (!item || w.hidden) return;
    this.writing = null;
    w.hidden = true;
    const text = w.value.replace(/\s+$/, "");
    if (!keep) return this.paint();
    if (item.fresh) {
      const made = cleanElement({ ...item, text });
      if (made) { this.act((all) => [...all, made]); this.selected = new Set([made.id]); this.pick("select"); }
      else this.pick("select");
      return;
    }
    if (item.type === "text" && !text.trim()) this.act((all) => all.filter((k) => k.id !== item.id));
    else if (text !== item.text) this.act((all) => all.map((k) => (k.id === item.id ? { ...k, text } : k)));
    else this.paint();
  }

  // --- The keyboard ---
  pick(tool) { this.tool = tool; if (tool !== "select") this.selected = new Set(); this.cursor(); this.chrome(); this.paint(); }
  key(e) {
    if (e.target !== this) return;
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (key === " " && !ctrl) { this.space = true; this.cursor(); return done(); }
    if (ctrl && !e.altKey) {
      if (key === "z") { e.shiftKey ? this.redo() : this.undo(); return done(); }
      if (key === "y") { this.redo(); return done(); }
      if (key === "a") { this.pick("select"); this.select(this.elements.map((k) => k.id)); return done(); }
      if (key === "d") { this.duplicate(); return done(); }
      if (key === "g") { e.shiftKey ? this.ungroup() : this.group(); return done(); }
      if (key === "c" && this.selected.size) { this.copy(false); return done(); }
      if (key === "x" && this.selected.size) { this.copy(true); return done(); }
      if (key === "v") { this.paste(); return done(); }
      if (key === "]") { this.order(true); return done(); }
      if (key === "[") { this.order(false); return done(); }
      if (key === "0") { this.zoomTo(1); return done(); }
      if (key === "=" || key === "+") { this.zoomTo(this.view.k * 1.2); return done(); }
      if (key === "-") { this.zoomTo(this.view.k / 1.2); return done(); }
      return;
    }
    if (e.altKey) return;
    if (e.shiftKey && (key === "1" || key === "!")) { this.zoomFit(); return done(); }
    const tool = TOOLS.find((t) => t[2] === key || (t[3] && t[3] === key));
    if (tool && !e.shiftKey) { if (!this.locked || tool[0] === "hand" || tool[0] === "select") this.pick(tool[0]); return done(); }
    if (key === "Delete" || key === "Backspace") { this.remove(); return done(); }
    if (key === "Escape") { if (this.drag) { if (this.drag.before) this.elements = this.drag.before; this.drag = null; } this.help = false; this.pick("select"); this.select([]); return done(); }
    if (key === "Enter") { const one = this.chosen(); if (one.length === 1 && one[0].type !== "draw") this.writeIn(one[0]); return done(); }
    if (key === "g") { this.grid = !this.grid; this.chrome(); this.paint(); return done(); }
    if (key === "m") { this.stick(); return done(); }
    if (key === "?") { this.help = !this.help; this.chrome(); return done(); }
    if (key === "Tab") {
      // Tab goes from one element to the next, so the board can be gone through without a pointer.
      if (!this.elements.length) return;
      const at = this.elements.findIndex((k) => this.selected.has(k.id)), n = this.elements.length;
      const next = this.elements[(at + (e.shiftKey ? n - 1 : 1) + (at < 0 && e.shiftKey ? 1 : 0)) % n] ?? this.elements[0];
      this.pick("select"); this.select([next.id]); this.say(next);
      return done();
    }
    if (key.startsWith("Arrow")) {
      const by = e.shiftKey ? GRID : this.grid ? GRID : 1;
      this.nudge(key === "ArrowLeft" ? -by : key === "ArrowRight" ? by : 0, key === "ArrowUp" ? -by : key === "ArrowDown" ? by : 0);
      return done();
    }
  }
  /** Turns on or off whether lines and arrows stick to the shapes they touch. */
  stick() {
    prefs.sticks = !prefs.sticks; keep();
    this.tell(prefs.sticks ? "Lines and arrows stick to the shapes they touch." : "Lines and arrows go where they are put, and stick to nothing.");
    this.chrome(); this.paint();
  }
  say(item) { this.note.textContent = (item.type === "text" ? "Text" : item.type[0].toUpperCase() + item.type.slice(1)) + (item.text ? ": " + item.text.slice(0, 80) : "") + (item.link ? ", linked to " + item.link : ""); }

  // --- Drawing it ---
  dashes(item) { return item.dash === "dashed" ? `${item.width * 4} ${item.width * 3}` : item.dash === "dotted" ? `0.1 ${item.width * 3}` : null; }
  label(item, cx, cy, width, backed) {
    const size = item.size, lines = wrap(item.text, Math.max(width, size * 2), (t) => this.wide(t, size));
    const tall = lines.length * size * 1.25;
    const text = svg("text", { class: "rc-text", "font-size": size, fill: this.colour(item.stroke), "text-anchor": "middle", "font-family": getComputedStyle(this).fontFamily });
    lines.forEach((line, i) => { const t = svg("tspan", { x: cx, y: cy - tall / 2 + size * 1.25 * i + size }); t.textContent = line || " "; text.append(t); });
    if (!backed) return text;
    const wide = Math.max(...lines.map((line) => this.wide(line, size))) + 12;
    return svg("g", {}, [svg("rect", { class: "rc-back", x: cx - wide / 2, y: cy - tall / 2 - 2, width: wide, height: tall + 6, rx: 4, fill: this.ground() }), text]);
  }
  ground() { return getComputedStyle(this).getPropertyValue("--bg").trim() || (this.kind === "light" ? "#e7eef1" : "#000000"); }
  build(item) {
    const g = svg("g", { class: "rc-el", "data-id": item.id, "data-type": item.type });
    const colour = this.colour(item.stroke), random = rng(item.seed);
    const line = { fill: "none", stroke: colour, "stroke-width": item.width, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-dasharray": this.dashes(item) };
    if (SHAPES.includes(item.type)) {
      if (item.fill !== "none") g.append(svg("path", { d: cleanOutline(item), fill: this.colour(item.fill), "fill-opacity": 0.2, stroke: "none" }));
      g.append(svg("path", { d: outline(item, random), ...line }));
      if (item.text && this.writing?.id !== item.id) { const b = box(item); g.append(this.label(item, b.x + b.w / 2, b.y + b.h / 2, b.w - 16, false)); }
    } else if (item.type === "line" || item.type === "arrow") {
      const x2 = item.x + item.w, y2 = item.y + item.h;
      const size = 8 + item.width * 3;
      // Straight from end to end, or in one curve through its bends.
      g.append(svg("path", { d: strokeCurve(item, random, item.sketch), ...line, fill: "none" }));
      // The heads are always whole, however the line itself is dashed, and point the way the line arrives.
      let heads = "";
      const [ex, ey] = approach(item, true), [sx, sy] = approach(item, false);
      if (item.head === "end" || item.head === "both") heads += arrowHead(x2, y2, ex, ey, size, random, item.sketch);
      if (item.head === "both") heads += arrowHead(item.x, item.y, sx, sy, size, random, item.sketch);
      if (heads) g.append(svg("path", { d: heads, ...line, "stroke-dasharray": null }));
      if (item.text && this.writing?.id !== item.id) { const [mx, my] = middle(item); g.append(this.label(item, mx, my, 240, true)); }
    } else if (item.type === "draw") {
      g.append(svg("path", { d: strokePath(item), ...line }));
    } else if (this.writing?.id !== item.id) {
      const text = svg("text", { class: "rc-text", "font-size": item.size, fill: colour, "font-family": getComputedStyle(this).fontFamily });
      item.text.split("\n").forEach((row, i) => { const t = svg("tspan", { x: item.x, y: item.y + item.size * 1.25 * i + item.size }); t.textContent = row || " "; text.append(t); });
      g.append(text);
    }
    if (item.link) {
      const b = box(item, this.measure);
      g.append(svg("g", { class: "rc-link", transform: `translate(${b.x + b.w - 4} ${b.y - 8})` }, [
        svg("circle", { r: 8, fill: this.ground(), stroke: this.colour("blue"), "stroke-width": 1.2 }),
        svg("path", { d: "M-3 3L3-3M-1-3h4v4", fill: "none", stroke: this.colour("blue"), "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round" }),
      ]));
      g.append(title("Linked to " + item.link + " (Ctrl+click to open)"));
    }
    return g;
  }
  /** Everything is drawn afresh at the next paint: after a new file, or a new theme. */
  forget() { for (const entry of this.nodes.values()) entry.node.remove(); this.nodes.clear(); }
  paint() {
    if (this.painting) return;
    this.painting = requestAnimationFrame(() => { this.painting = 0; this.render(); });
  }
  render() {
    if (!this.ready) return;
    const { x, y, k } = this.view;
    this.world.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
    // The dots of the grid move and grow with the board.
    this.gridRect.setAttribute("fill", this.grid ? `url(#${this.pattern.id})` : "none");
    this.pattern.setAttribute("patternTransform", `translate(${x} ${y}) scale(${k})`);
    const seen = new Set();
    let previous = null;
    for (const item of this.elements) {
      seen.add(item.id);
      let entry = this.nodes.get(item.id);
      if (!entry || entry.item !== item || entry.writing !== (this.writing?.id === item.id)) {
        const node = this.build(item);
        if (entry) entry.node.replaceWith(node);
        entry = { item, node, writing: this.writing?.id === item.id };
        this.nodes.set(item.id, entry);
      }
      const after = previous ? previous.nextSibling : this.world.firstChild;
      if (entry.node !== after) this.world.insertBefore(entry.node, after);
      previous = entry.node;
    }
    for (const [id, entry] of this.nodes) if (!seen.has(id)) { entry.node.remove(); this.nodes.delete(id); }
    this.board.setAttribute("aria-label", this.elements.length ? `A drawing of ${this.elements.length} elements` + (this.elements.some((e) => e.text) ? ": " + this.elements.filter((e) => e.text).slice(0, 12).map((e) => e.text.split("\n")[0]).join(", ") : "") : "An empty board");
    this.classList.toggle("empty", !this.elements.length && !this.writing && !this.problem);
    this.overlay();
  }
  /** What lies over the drawing and is not part of it: the frame round what is chosen, its handles, the box being dragged out. */
  overlay() {
    const { x, y, k } = this.view, over = this.over;
    over.replaceChildren();
    const screen = (b) => ({ x: b.x * k + x, y: b.y * k + y, w: b.w * k, h: b.h * k });
    const d = this.drag;
    if (d?.kind === "marquee") {
      const b = screen({ x: Math.min(d.x, d.x2), y: Math.min(d.y, d.y2), w: Math.abs(d.x2 - d.x), h: Math.abs(d.y2 - d.y) });
      over.append(svg("rect", { class: "rc-marquee", x: b.x, y: b.y, width: b.w, height: b.h }));
    }
    // The shape an arrow being drawn would be tied to is shown as it is passed over.
    for (const id of new Set([d?.under, d?.kind === "create" ? d.item.from : ""])) {
      const item = id && this.elements.find((e) => e.id === id);
      if (item) { const b = screen(box(item, this.measure)); over.append(svg("rect", { class: "rc-tie", x: b.x - 6, y: b.y - 6, width: b.w + 12, height: b.h + 12, rx: 8 })); }
    }
    const items = this.chosen();
    if (!items.length || this.tool !== "select") return;
    const one = items.length === 1 ? items[0] : null;
    if (one && (one.type === "line" || one.type === "arrow")) {
      // Between every two of its points, a faint handle: pulled, it becomes a bend.
      if (!this.locked && this.drag?.kind !== "bend") middles(one).forEach(([px, py], i) => over.append(svg("circle", { class: "rc-handle mid", "data-handle": "mid:" + i, cx: px * k + x, cy: py * k + y, r: 4.5 }, [title("Pull to bend the line here")])));
      (one.bends ?? []).forEach(([px, py], i) => over.append(svg("circle", { class: "rc-handle bend", "data-handle": "bend:" + i, cx: px * k + x, cy: py * k + y, r: 5 }, [title("Drag to move this bend. Double click to take it out")])));
      for (const [name, px, py] of [["start", one.x, one.y], ["end", one.x + one.w, one.y + one.h]]) {
        over.append(svg("circle", { class: "rc-handle" + ((name === "start" ? one.from : one.to) ? " tied" : ""), "data-handle": name, cx: px * k + x, cy: py * k + y, r: 5.5 }));
      }
      return;
    }
    for (const item of items.length > 1 ? items : []) { const b = screen(box(item, this.measure)); over.append(svg("rect", { class: "rc-each", x: b.x - 2, y: b.y - 2, width: b.w + 4, height: b.h + 4 })); }
    const b = screen(around(items, this.measure));
    over.append(svg("rect", { class: "rc-frame", x: b.x - 5, y: b.y - 5, width: b.w + 10, height: b.h + 10, rx: 3 }));
    if (this.locked) return;
    // Writing alone has corners only: pulling one makes the writing larger or smaller.
    const lettering = items.every((e) => e.type === "text");
    const spots = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
    for (const [name, [fx, fy]] of Object.entries(spots)) {
      if (name.length === 1 && (lettering || (fx === 0.5 ? b.w : b.h) < 34)) continue;
      const node = svg("rect", { class: "rc-handle", "data-handle": name, x: b.x - 5 + (b.w + 10) * fx - 4.5, y: b.y - 5 + (b.h + 10) * fy - 4.5, width: 9, height: 9, rx: 2 });
      node.style.cursor = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" }[name];
      over.append(node);
    }
  }

  // --- The buttons round the board ---
  button(name, label, onclick, more = {}) {
    const b = el("button", { type: "button", class: "rc-button" + (more.on ? " on" : ""), title: label + (more.key ? " (" + more.key + ")" : ""), "aria-label": label, "aria-pressed": more.on === undefined ? null : String(!!more.on), disabled: !!more.disabled, onclick });
    b.innerHTML = sign(name);
    if (more.hint) b.append(el("small", { text: more.hint, "aria-hidden": "true" }));
    return b;
  }
  chrome() {
    if (!this.ready) return;
    const locked = this.locked;
    this.tools.replaceChildren(...TOOLS.filter((t) => !locked || t[0] === "select" || t[0] === "hand").map(([name, label, key, digit]) =>
      this.button(name, label, () => { this.pick(name); this.focus(); }, { on: this.tool === name, key: key.toUpperCase() + (digit ? " or " + digit : ""), hint: digit })));
    this.tools.hidden = !!this.problem;

    const items = this.chosen();
    const kinds = new Set(items.length ? items.map((e) => e.type) : [this.tool]);
    const show = !locked && !this.problem && (items.length > 0 || !["select", "hand", "eraser"].includes(this.tool));
    const of = (key) => (items.length ? (items.every((e) => e[key] === items[0][key]) ? items[0][key] : null) : this.style_[key]);
    const row = (title, children) => el("div", { class: "rc-row", role: "group", "aria-label": title }, [el("span", { class: "rc-label", text: title }), el("div", { class: "rc-set" }, children)]);
    const swatch = (key, name) => {
      const b = el("button", { type: "button", class: "rc-swatch" + (of(key) === name ? " on" : "") + (name === "none" ? " none" : ""), title: name === "none" ? "No fill" : name[0].toUpperCase() + name.slice(1), "aria-label": (key === "fill" ? "Fill " : "Stroke ") + name, "aria-pressed": String(of(key) === name), onclick: () => { this.setStyle(key, name); this.focus(); } });
      if (name !== "none") b.style.setProperty("--c", this.colour(name));
      return b;
    };
    const choice = (key, value, label, text) => el("button", { type: "button", class: "rc-choice" + (of(key) === value ? " on" : ""), title: label, "aria-label": label, "aria-pressed": String(of(key) === value), text, onclick: () => { this.setStyle(key, value); this.focus(); } });
    const any = (...types) => types.some((t) => kinds.has(t));
    const shape = any(...SHAPES), stroked = shape || any("line", "arrow", "draw"), lettered = any("text") || items.some((e) => e.text) || (!items.length && any("text"));
    const rows = [];
    if (show) {
      rows.push(row("Stroke", COLOURS.map((c) => swatch("stroke", c))));
      if (shape) rows.push(row("Fill", ["none", ...COLOURS].map((c) => swatch("fill", c))));
      if (stroked) rows.push(row("Width", WIDTHS.map((w, i) => choice("width", w, ["Thin", "Bold", "Extra bold"][i], ["─", "━", "▬"][i]))));
      if (stroked) rows.push(row("Line", DASHES.map((d, i) => choice("dash", d, d[0].toUpperCase() + d.slice(1), ["──", "╌╌", "┈┈"][i]))));
      if (shape || any("line", "arrow")) rows.push(row("Hand", [choice("sketch", true, "Drawn by hand", "Sketch"), choice("sketch", false, "Exact", "Clean")]));
      if (any("rect")) rows.push(row("Corners", [choice("round", true, "Round corners", "Round"), choice("round", false, "Sharp corners", "Sharp")]));
      if (any("arrow", "line")) rows.push(row("Ends", HEADS.map((h, i) => choice("head", h, ["No arrowheads", "An arrowhead at the end", "Arrowheads at both ends"][i], ["─", "→", "↔"][i]))));
      if (lettered) {
        const size = of("size");
        rows.push(row("Text", [
          ...SIZES.map((s, i) => choice("size", s, ["Small", "Medium", "Large", "Extra large"][i] + " text", ["S", "M", "L", "XL"][i])),
          this.button("minus", "Smaller text", () => { this.scaleText(1 / 1.15); this.focus(); }, { disabled: size !== null && size <= SMALLEST }),
          el("span", { class: "rc-size", title: "The size of the writing", "aria-label": "Text size " + (size ?? "mixed"), text: size === null ? "–" : String(size) }),
          this.button("plus", "Larger text", () => { this.scaleText(1.15); this.focus(); }, { disabled: size !== null && size >= LARGEST }),
        ]));
      }
      if (items.length === 1) {
        const field = el("input", { class: "rc-field", type: "text", value: items[0].link, placeholder: "src/file.bea:12", spellcheck: "false", "aria-label": "A file of the project this element points to" });
        const set = () => { const link = cleanLink(field.value); field.value = link; if (link !== items[0].link) this.act((all) => all.map((e) => (e.id === items[0].id ? { ...e, link } : e))); };
        field.addEventListener("change", set);
        field.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { set(); this.focus(); } if (e.key === "Escape") { field.value = items[0].link; this.focus(); } });
        rows.push(row("Link", [field, items[0].link ? this.button("link", "Open " + items[0].link, () => this.follow(items[0].link)) : null]));
      }
      // Several things chosen can be made one; one group can be taken apart again. This is
      // about what is chosen, so it lives here with the rest of what is, not among the tools.
      const one = isGroup(this.elements, this.selected), parts = items.some((e) => e.groups?.length);
      if (items.length > 1 || parts) rows.push(row("Group", [
        this.button("group", one ? "These are one group already" : "Group: make these one thing", () => { this.group(); this.focus(); }, { key: "Ctrl+G", disabled: items.length < 2 || one }),
        this.button("ungroup", "Ungroup: take the group apart", () => { this.ungroup(); this.focus(); }, { key: "Ctrl+Shift+G", disabled: !parts }),
        one ? el("span", { class: "rc-size", text: items.length + " in the group" }) : null,
      ]));
      if (items.length) rows.push(row("Layer", [
        this.button("front", "Bring to the front", () => { this.order(true); this.focus(); }, { key: "Ctrl+]" }), this.button("back", "Send to the back", () => { this.order(false); this.focus(); }, { key: "Ctrl+[" }),
        this.button("copy", "Duplicate", () => { this.duplicate(); this.focus(); }, { key: "Ctrl+D" }), this.button("trash", "Delete", () => { this.remove(); this.focus(); }, { key: "Delete" }),
      ]));
    }
    this.props.replaceChildren(...rows);
    this.props.hidden = !rows.length;

    const percent = el("button", { type: "button", class: "rc-zoom", title: "Back to full size (Ctrl+0)", "aria-label": "Zoom: " + Math.round(this.view.k * 100) + " percent. Back to full size", text: Math.round(this.view.k * 100) + "%", onclick: () => { this.zoomTo(1); this.focus(); } });
    this.foot.replaceChildren(...[
      el("div", { class: "rc-group" }, [this.button("minus", "Zoom out", () => { this.zoomTo(this.view.k / 1.2); this.focus(); }, { key: "Ctrl+-" }), percent, this.button("plus", "Zoom in", () => { this.zoomTo(this.view.k * 1.2); this.focus(); }, { key: "Ctrl+=" }),
        this.button("fit", "Fit the drawing to the window", () => { this.zoomFit(); this.focus(); }, { key: "Shift+1" })]),
      locked ? null : el("div", { class: "rc-group" }, [this.button("undo", "Undo", () => { this.undo(); this.focus(); }, { key: "Ctrl+Z", disabled: !this.undos.length }), this.button("redo", "Redo", () => { this.redo(); this.focus(); }, { key: "Ctrl+Shift+Z", disabled: !this.redos.length })]),
      el("div", { class: "rc-group" }, [
        this.button("grid", "Grid: things snap to it", () => { this.grid = !this.grid; this.chrome(); this.paint(); this.focus(); }, { on: this.grid, key: "G" }),
        locked ? null : this.button("magnet", prefs.sticks ? "Lines and arrows stick to shapes. Click to stop that" : "Lines and arrows stick to nothing. Click to have them stick to shapes", () => { this.stick(); this.focus(); }, { on: prefs.sticks, key: "M" }),
      ]),
    ].filter(Boolean));
    this.foot.hidden = !!this.problem;

    const menu = this.exporting ? el("div", { class: "rc-menu", role: "menu" }, [
      el("button", { type: "button", role: "menuitem", text: "Save as PNG…", onclick: () => this.export("png") }),
      el("button", { type: "button", role: "menuitem", text: "Save as SVG…", onclick: () => this.export("svg") }),
      el("button", { type: "button", role: "menuitem", text: "Copy as PNG", onclick: () => this.export("copy") }),
    ]) : null;
    const help = this.help ? el("div", { class: "rc-help", role: "note" }, [el("b", { text: "Rune Canvas" }), el("dl", {}, KEYS.flatMap(([keys, what]) => [el("dt", { text: keys }), el("dd", { text: what })]))]) : null;
    this.top.replaceChildren(...[
      this.problem ? null : this.button("export", "Save the drawing as a picture", () => { this.exporting = !this.exporting; this.help = false; this.chrome(); }, { on: !!this.exporting, disabled: !this.elements.length }),
      this.button("code", "Show the file as text", () => this.dispatchEvent(new CustomEvent("canvas-raw", { bubbles: true }))),
      this.problem ? null : this.button("help", "What the keys do", () => { this.help = !this.help; this.exporting = false; this.chrome(); }, { on: !!this.help, key: "?" }),
      menu, help,
    ].filter(Boolean));
    let said = this.querySelector(".rc-problem");
    if (this.problem) {
      said ??= this.appendChild(el("div", { class: "rc-problem", role: "alert" }));
      said.replaceChildren(el("b", { text: "This file cannot be shown as a drawing" }), el("p", { text: this.problem }),
        el("button", { type: "button", class: "button", text: "Open it as text", onclick: () => this.dispatchEvent(new CustomEvent("canvas-raw", { bubbles: true })) }));
    } else said?.remove();
  }

  // --- Pictures of the drawing ---
  /** The drawing as an SVG document that stands by itself: its own size, ground and colours. */
  picture() {
    const b = around(this.elements, this.measure) ?? { x: 0, y: 0, w: 100, h: 100 }, pad = 24;
    const root = svg("svg", { xmlns: NS, viewBox: `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`, width: Math.ceil(b.w + pad * 2), height: Math.ceil(b.h + pad * 2) });
    root.append(svg("rect", { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: this.ground() }));
    const was = this.writing; this.writing = null;
    for (const item of this.elements) { const node = this.build(item); node.querySelector(".rc-link")?.remove(); node.querySelector("title")?.remove(); root.append(node); }
    this.writing = was;
    return { text: new XMLSerializer().serializeToString(root), width: Math.ceil(b.w + pad * 2), height: Math.ceil(b.h + pad * 2) };
  }
  async raster() {
    const { text, width, height } = this.picture();
    const scale = Math.min(3, 8000 / Math.max(width, height));
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      await new Promise((ok, bad) => { image.onload = ok; image.onerror = () => bad(new Error("The picture could not be made")); image.src = url; });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally { URL.revokeObjectURL(url); }
  }
  async export(how) {
    this.exporting = false;
    this.chrome();
    const name = (this.path.split("/").pop() || "drawing").replace(/\.rux$/i, "");
    try {
      if (how === "svg") {
        const file = await host.saveAs?.(name + ".svg");
        if (file) { await host.writeFile(file, this.picture().text); this.tell("Saved " + file.split("/").pop()); }
      } else if (how === "png") {
        const saved = await host.saveImage?.(name + ".png", (await this.raster()).toDataURL("image/png"));
        if (saved) this.tell("Saved " + String(saved).split(/[\\/]/).pop());
      } else {
        const blob = await new Promise((done) => this.raster().then((c) => c.toBlob(done, "image/png")));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        this.tell("Copied as a picture");
      }
    } catch (e) { this.tell(String(e?.message ?? e)); }
  }
  tell(text) {
    this.note.textContent = text;
    this.note.classList.add("shown");
    clearTimeout(this.telling);
    this.telling = setTimeout(() => this.note.classList.remove("shown"), 2600);
  }
}

if (inPage && !customElements.get("runes-canvas")) customElements.define("runes-canvas", RuneCanvas);
