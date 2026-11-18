// Files that are looked at, not typed in: <runes-viewer> shows a picture, a sound, a film,
// a PDF or a workbook, and <runes-table> shows rows of cells (a CSV file's, or a sheet's).
//
// The window never names a place on disk to the engine: it asks the shell for an address
// for one file (`fileView`), and shows what is at that address. What a file holds only ever
// reaches the page as text, as a picture, or through the engine's own players.
import { parseCsv, parseXlsx, widthOf, columnName, sortedOrder } from "./runes_tables.mjs";

const inPage = typeof window !== "undefined" && typeof HTMLElement !== "undefined";
const host = inPage ? window.runesHost ?? {} : {};

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
export const sizeText = (bytes) => {
  if (!(bytes >= 0)) return "";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
};
const count = (n) => n.toLocaleString("en");
const MARKS = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "bar" };

// --- <runes-table> ----------------------------------------------------------------------------
// Only the rows in sight are in the page, so a table of a hundred thousand rows scrolls as
// one of ten does. The first row is the heading and stays at the top.

const ROW = 26;
// Outside a page (the unit tests load this file under Node) there is nothing to extend, and nothing is defined.
const Base = globalThis.HTMLElement ?? class {};
class RunesTable extends Base {
  connectedCallback() {
    if (this.built) return;
    this.built = true;
    this.sheets = this.sheets ?? [];
    this.sheet = 0; this.sort = null; this.order = null;
    this.head = el("div", { class: "rt-head", role: "row" });
    this.body = el("div", { class: "rt-body" });
    this.space = el("div", { class: "rt-space" }, [this.body]);
    this.scroller = el("div", { class: "rt-scroll", tabindex: "0", role: "grid", onscroll: () => { this.head.style.transform = `translateX(${-this.scroller.scrollLeft}px)`; this.draw(); } }, [this.space]);
    this.tabs = el("div", { class: "rt-tabs", role: "tablist" });
    this.note = el("div", { class: "rt-note" });
    this.append(el("div", { class: "rt-headwrap" }, [this.head]), this.scroller, el("div", { class: "rt-foot" }, [this.tabs, this.note]));
    this.sizes = new ResizeObserver(() => this.draw());
    this.sizes.observe(this.scroller);
    this.show();
  }
  disconnectedCallback() { this.sizes?.disconnect(); this.built = false; this.replaceChildren(); }
  /** `{ sheets: [{ name, rows, cut }], note, raw }`: what to show, a line about it, and whether "Edit as text" is offered. */
  set data(value) {
    this.sheets = value?.sheets ?? [];
    this.about = value?.note ?? "";
    this.raw = !!value?.raw;
    if (this.sheet >= this.sheets.length) this.sheet = 0;
    this.sort = null;
    if (this.built) this.show();
  }
  /** CSV text: set by the editor each time the file's text changes. */
  set doc(value) {
    const text = String(value?.text ?? "");
    if (text === this.text) return;
    this.text = text;
    const { rows, mark, cut } = parseCsv(text);
    this.data = { sheets: [{ name: "", rows, cut }], note: (MARKS[mark] ?? "comma") + " separated", raw: true };
  }
  show() {
    const sheet = this.sheets[this.sheet] ?? { rows: [] };
    this.heading = sheet.rows[0] ?? [];
    this.rows = sheet.rows.slice(1);
    this.columns = Math.max(widthOf(sheet.rows), 1);
    this.order = this.sort ? sortedOrder(this.rows, this.sort.column, this.sort.descending) : null;
    // Each column is as wide as what it holds, going by a sample of the rows, within reason.
    const widths = Array.from({ length: this.columns }, (_, c) => Math.max(String(this.heading[c] ?? "").length + 2, 4));
    const step = Math.max(1, Math.floor(this.rows.length / 400));
    for (let r = 0; r < this.rows.length; r += step) for (let c = 0; c < this.rows[r].length && c < this.columns; c++) widths[c] = Math.max(widths[c], this.rows[r][c].length);
    // In pixels, from the width of a character as it is drawn here: the heading and the rows
    // are in different fonts, and a width counted in characters would differ between them.
    const probe = el("span", { class: "rt-c", style: "position:absolute;visibility:hidden;padding:0;border:0", text: "0".repeat(50) });
    this.body.append(probe);
    const wide = probe.getBoundingClientRect().width / 50 || 7.6;
    probe.remove();
    this.widths = widths.map((w) => Math.round(Math.min(Math.max(w, 4), 48) * wide + 26));
    const digits = String(this.rows.length + 1).length;
    this.style.setProperty("--rt-number", Math.round(digits * wide + 20) + "px");
    this.style.setProperty("--rt-columns", this.widths.map((w) => w + "px").join(" "));
    this.head.replaceChildren(el("div", { class: "rt-n rt-corner" }), ...Array.from({ length: this.columns }, (_, c) => {
      const sorted = this.sort?.column === c;
      return el("button", {
        class: "rt-h" + (sorted ? " sorted" : ""), role: "columnheader", title: (this.heading[c] || "Column " + columnName(c)) + "\nClick to sort; click again to turn the order round, and once more to put it back",
        "aria-sort": sorted ? (this.sort.descending ? "descending" : "ascending") : "none",
        onclick: () => {
          this.sort = !sorted ? { column: c, descending: false } : this.sort.descending ? null : { column: c, descending: true };
          this.show();
        },
      }, [el("span", { text: this.heading[c] || columnName(c) }), el("i", { text: sorted ? (this.sort.descending ? "↓" : "↑") : "" })]);
    }));
    this.space.style.height = this.rows.length * ROW + "px";
    this.tabs.replaceChildren(...(this.sheets.length > 1 ? this.sheets.map((s, i) => el("button", {
      class: "rt-tab" + (i === this.sheet ? " on" : ""), role: "tab", "aria-selected": i === this.sheet ? "true" : "false", text: s.name,
      onclick: () => { this.sheet = i; this.sort = null; this.scroller.scrollTop = 0; this.show(); },
    })) : []));
    const said = [`${count(this.rows.length)} ${this.rows.length === 1 ? "row" : "rows"} × ${count(this.columns)} ${this.columns === 1 ? "column" : "columns"}`];
    if (this.about) said.push(this.about);
    if (sheet.cut) said.push("only the first " + count(sheet.rows.length) + " rows are shown");
    this.note.replaceChildren(el("span", { text: said.join(" · ") }));
    if (this.raw) this.note.append(el("button", { class: "link rt-raw", text: "Edit as text", onclick: () => this.dispatchEvent(new CustomEvent("table-raw", { bubbles: true })) }));
    this.drawn = null;
    this.draw();
  }
  draw() {
    if (!this.built || !this.rows) return;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW) - 8);
    const last = Math.min(this.rows.length, Math.ceil((this.scroller.scrollTop + this.scroller.clientHeight) / ROW) + 8);
    const key = first + ":" + last;
    if (key === this.drawn) return;
    this.drawn = key;
    const out = [];
    for (let i = first; i < last; i++) {
      const at = this.order ? this.order[i] : i, row = this.rows[at];
      const cells = [el("div", { class: "rt-n", text: String(at + 2) })];
      for (let c = 0; c < this.columns; c++) {
        const text = row[c] ?? "";
        // Numbers line up on the right, as a spreadsheet shows them.
        cells.push(el("div", { class: "rt-c" + (text !== "" && Number.isFinite(Number(text.replace(/,/g, ""))) ? " num" : ""), role: "gridcell", text, title: text.length > 30 ? text.slice(0, 2000) : null }));
      }
      out.push(el("div", { class: "rt-row" + (i % 2 ? " odd" : ""), role: "row", style: `top:${i * ROW}px` }, cells));
    }
    this.body.replaceChildren(...out);
  }
}

// --- <runes-viewer> ----------------------------------------------------------------------------

const WORDS = { image: "Picture", audio: "Sound", video: "Film", pdf: "PDF", sheet: "Workbook" };
// A workbook is unpacked and drawn by the page itself: past this it is not tried.
const MOST_SHEET = 64 * 1024 * 1024;

class RunesViewer extends Base {
  static observedAttributes = ["path", "stamp"];
  connectedCallback() { this.load(); }
  disconnectedCallback() { this.turn = (this.turn ?? 0) + 1; this.replaceChildren(); }
  attributeChangedCallback(_name, was, now) { if (this.isConnected && was !== now) this.load(); }
  say(text) { this.replaceChildren(el("div", { class: "rv-note", role: "status", text })); }
  async load() {
    const turn = this.turn = (this.turn ?? 0) + 1;
    const path = this.getAttribute("path") ?? "";
    const name = path.split(/[\\/]/).pop();
    if (!host.fileView) return this.say("Looking at pictures, sound, film, PDFs and workbooks needs the desktop app.");
    this.say("Opening " + name + "…");
    let found;
    try { found = await host.fileView(path); }
    catch (e) { if (turn === this.turn) this.say(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); return; }
    if (turn !== this.turn) return;
    const { url, kind, size } = found;
    const facts = el("span", { class: "rv-facts", text: [WORDS[kind] ?? "", sizeText(size)].filter(Boolean).join(" · ") });
    const foot = el("div", { class: "rv-foot" }, [el("b", { text: name }), facts]);
    const add = (text) => { facts.textContent += " · " + text; };
    const failed = (what) => () => { if (turn === this.turn) this.say(`${name} could not be shown: ${what}`); };
    let stage;
    if (kind === "image") {
      const img = el("img", { class: "rv-image", src: url, alt: name, draggable: "false", onerror: failed("it is not a picture this engine can read, or it is damaged.") });
      img.addEventListener("load", () => add(`${img.naturalWidth} × ${img.naturalHeight}`));
      // A click swaps between fitting the picture in the view and showing it at its own size.
      stage = el("div", { class: "rv-stage image fit", title: "Click to see it at its own size, and again to fit it in", onclick: () => stage.classList.toggle("fit") }, [img]);
    } else if (kind === "audio") {
      const audio = el("audio", { class: "rv-audio", src: url, controls: true, preload: "metadata", onerror: failed("this engine cannot play it.") });
      audio.addEventListener("loadedmetadata", () => { if (Number.isFinite(audio.duration)) add(clock(audio.duration)); });
      stage = el("div", { class: "rv-stage audio" }, [el("div", { class: "rv-disc", "aria-hidden": "true", text: "♪" }), el("div", { class: "rv-title", text: name }), audio]);
    } else if (kind === "video") {
      const video = el("video", { class: "rv-video", src: url, controls: true, preload: "metadata", playsinline: true, onerror: failed("this engine cannot play it.") });
      video.addEventListener("loadedmetadata", () => { add(`${video.videoWidth} × ${video.videoHeight}`); if (Number.isFinite(video.duration)) add(clock(video.duration)); });
      stage = el("div", { class: "rv-stage video" }, [video]);
    } else if (kind === "pdf") {
      // The engine's own PDF viewer, in a frame that can be given nothing but this one file.
      stage = el("div", { class: "rv-stage pdf" }, [el("iframe", { class: "rv-pdf", src: url, title: name })]);
    } else if (kind === "sheet") {
      stage = el("div", { class: "rv-stage sheet" });
      if (size > MOST_SHEET) return this.say(`${name} is ${sizeText(size)}: too large a workbook for Runes to open.`);
      try {
        const answer = await fetch(url);
        if (!answer.ok) throw new Error("it could not be read.");
        const sheets = parseXlsx(new Uint8Array(await answer.arrayBuffer()));
        if (turn !== this.turn) return;
        const table = el("runes-table");
        table.data = { sheets, note: sheets.length > 1 ? sheets.length + " sheets" : "" };
        stage.append(table);
      } catch (e) { if (turn === this.turn) this.say(String(e?.message ?? e)); return; }
    } else return this.say("Runes has no viewer for this kind of file.");
    this.replaceChildren(stage, foot);
  }
}
const clock = (seconds) => {
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s % 60).padStart(2, "0");
};

if (inPage && !customElements.get("runes-table")) customElements.define("runes-table", RunesTable);
if (inPage && !customElements.get("runes-viewer")) customElements.define("runes-viewer", RunesViewer);
