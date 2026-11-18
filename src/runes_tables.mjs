// Tables as data: reading CSV text and XLSX workbooks into rows of cells. Nothing here
// touches the page, so it can be tested with plain Node. See runes_viewers.mjs for how a
// table is shown.
import { unzipSync, strFromU8 } from "fflate";

export const MOST_ROWS = 200000;
export const MOST_COLUMNS = 1000;

// --- CSV --------------------------------------------------------------------------------------

/** What separates the values of a line: the candidate that splits the first lines most evenly. */
export function delimiterOf(text) {
  const sample = text.slice(0, 20000).split(/\r\n|\n|\r/).filter((line) => line.trim() !== "").slice(0, 20);
  let best = ",", score = 0;
  for (const mark of [",", ";", "\t", "|"]) {
    // Counted outside quotes only: a comma inside "Smith, John" separates nothing.
    const counts = sample.map((line) => {
      let n = 0, quoted = false;
      for (const c of line) { if (c === '"') quoted = !quoted; else if (c === mark && !quoted) n++; }
      return n;
    });
    const least = Math.min(...counts);
    if (!counts.length || least === 0) continue;
    const even = counts.every((n) => n === counts[0]) ? 2 : 1;
    if (least * even > score) { score = least * even; best = mark; }
  }
  return best;
}

/**
 * CSV as rows of strings (RFC 4180: values may be quoted, a quote inside is doubled, and a
 * quoted value may hold the separator and line breaks). `mark` is the separator; left out,
 * it is worked out. Returns `{ rows, mark, cut }`: `cut` says there was more than is kept.
 */
export function parseCsv(text, mark = delimiterOf(text)) {
  const rows = [];
  let row = [], value = "", quoted = false, started = false, cut = false;
  // A byte order mark is not part of the first value.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endValue = () => { if (row.length < MOST_COLUMNS) row.push(value); value = ""; started = false; };
  const endRow = () => { endValue(); rows.push(row); row = []; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else quoted = false; }
      else value += c;
    } else if (c === '"' && !started) { quoted = true; started = true; }
    else if (c === mark) endValue();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (rows.length >= MOST_ROWS) { cut = true; row = []; value = ""; break; }
      endRow();
    } else { value += c; started = true; }
  }
  // A last line with no line break after it is still a line; a file that ends with one has no empty last row.
  if (!cut && (value !== "" || row.length || started)) endRow();
  return { rows, mark, cut };
}

// --- XLSX -------------------------------------------------------------------------------------
// A workbook is a zip of XML. Only what is needed to show the values is read: the sheets'
// names, the shared strings, which number formats are dates, and each sheet's cells.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const plain = (text) => text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, name) => {
  if (name[0] !== "#") return ENTITIES[name] ?? whole;
  const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
});
/** The attributes of one opening tag, as an object. */
const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = plain(m[2] ?? m[3] ?? "");
  return out;
};
/** All the text a piece of rich text holds: its runs put together, the phonetic guides left out. */
const textOf = (xml) => {
  let out = "";
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += plain(m[1] ?? "");
  return out;
};
/** "BC" -> 54: which column a cell's name puts it in, counted from 0. */
export function columnOf(name) {
  let n = 0;
  for (const c of name) { const code = c.charCodeAt(0); if (code < 65 || code > 90) break; n = n * 26 + (code - 64); }
  return n - 1;
}

// Number formats that are dates or times: the built-in ones by number, others by their code.
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateCode = (code) => /[dmyhs]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"|\\./g, "")) && !/^general$/i.test(code);
const two = (n) => String(n).padStart(2, "0");
/** A day number as a spreadsheet counts them, written as a date, a time, or both. */
export function dateOf(serial, from1904 = false) {
  if (!Number.isFinite(serial)) return "";
  const days = Math.floor(serial), part = serial - days;
  // Day 1 is the first of January 1900, and the count has a 29th of February 1900 that never was.
  const epoch = from1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days >= 60 ? 30 : 31);
  const at = new Date(epoch + days * 86400000 + Math.round(part * 86400) * 1000);
  if (Number.isNaN(at.getTime())) return String(serial);
  const date = `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
  const time = `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())}`;
  if (part === 0) return date;
  return days === 0 ? time : date + " " + time;
}

/** A number as it is best read: the noise a binary fraction leaves at the end is taken off. */
const tidyNumber = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || !/[.eE]/.test(raw)) return raw;
  return String(Number(n.toPrecision(15)));
};

/**
 * A workbook's sheets: `[{ name, rows, cut }]`, each row a list of strings. `bytes` is the
 * file. Throws with words for a person when it is not a workbook Runes can read.
 */
export function parseXlsx(bytes) {
  let files;
  // Only the parts that are read are unpacked, and none past a size no real sheet has.
  const wanted = (file) => /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/[^/]+\.xml)$/.test(file.name) && file.originalSize <= 256 * 1024 * 1024;
  try { files = unzipSync(bytes, { filter: wanted }); }
  catch { throw new Error("This is not a workbook Runes can read. Workbooks saved as .xlsx can be; the older .xls cannot."); }
  const read = (name) => (files[name] ? strFromU8(files[name]) : "");
  const book = read("xl/workbook.xml");
  if (!book) throw new Error("This workbook has no sheets Runes can find. It may be protected with a password.");
  const from1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/.test(book);
  const targets = {};
  for (const m of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) { const a = attrs(m[0]); if (a.Id && a.Target) targets[a.Id] = a.Target; }
  const strings = [];
  for (const m of read("xl/sharedStrings.xml").matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) strings.push(textOf(m[1] ?? ""));
  // Which cell styles show their number as a date.
  const styles = read("xl/styles.xml");
  const custom = new Map();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) { const a = attrs(m[0]); custom.set(Number(a.numFmtId), a.formatCode ?? ""); }
  const dated = [];
  for (const m of (/<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(styles)?.[0] ?? "").matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attrs(m[0]).numFmtId ?? 0);
    dated.push(custom.has(id) ? isDateCode(custom.get(id)) : DATE_FORMATS.has(id));
  }
  const sheets = [];
  for (const m of book.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const target = targets[a["r:id"]] ?? "";
    // Where the sheet is, from the workbook's own folder; nothing outside the workbook is followed.
    const file = target.startsWith("/") ? target.slice(1) : "xl/" + target;
    if (!target || file.includes("..") || !files[file]) continue;
    sheets.push({ name: a.name || "Sheet " + (sheets.length + 1), ...sheetRows(read(file), strings, dated, from1904) });
    if (sheets.length >= 100) break;
  }
  if (!sheets.length) throw new Error("This workbook has no sheets Runes can find. It may be protected with a password.");
  return sheets;
}

function sheetRows(xml, strings, dated, from1904) {
  const rows = [];
  let cut = false, next = 0;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    // Rows say which they are; a row left out of the file is an empty one in the sheet.
    const at = Number(attrs("<row " + r[1] + ">").r);
    const index = Number.isInteger(at) && at > 0 ? at - 1 : next;
    if (index >= MOST_ROWS) { cut = true; break; }
    const row = [];
    let column = 0;
    for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs("<c " + c[1] + ">");
      const col = a.r ? columnOf(a.r) : column;
      column = col + 1;
      if (col < 0 || col >= MOST_COLUMNS) continue;
      const inside = c[2] ?? "";
      const raw = plain(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inside)?.[1] ?? "");
      let value = raw;
      if (a.t === "s") value = strings[Number(raw)] ?? "";
      else if (a.t === "inlineStr") value = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inside)?.[1] ?? "");
      else if (a.t === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (a.t === "str" || a.t === "e" || a.t === "d") value = raw;
      else if (raw !== "") value = dated[Number(a.s ?? -1)] ? dateOf(Number(raw), from1904) : tidyNumber(raw);
      row[col] = value;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = Array.from(row, (value) => value ?? "");
    next = index + 1;
  }
  // Empty rows at the end are not part of the table.
  while (rows.length && rows[rows.length - 1].every((value) => value === "")) rows.pop();
  return { rows, cut };
}

// --- Shared: the shape of a table, and its order ------------------------------------------------

/** How many columns the widest row has. */
export const widthOf = (rows) => rows.reduce((most, row) => Math.max(most, row.length), 0);

/** "A", "B", … "AA": the name of a column, as spreadsheets name them. */
export function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * The order to show rows in when sorted by a column: a list of row numbers. Numbers are
 * ordered as numbers and come before words; empty cells come last whichever way it goes.
 */
export function sortedOrder(rows, column, descending = false) {
  const keyed = rows.map((row, index) => {
    const text = row[column] ?? "";
    const number = text.trim() === "" ? NaN : Number(text.replace(/,/g, ""));
    return { index, text, number, kind: text.trim() === "" ? 2 : Number.isFinite(number) ? 0 : 1 };
  });
  const way = descending ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 2 || b.kind === 2 ? a.kind - b.kind : (a.kind - b.kind) * way;
    if (a.kind === 0) return (a.number - b.number) * way || a.index - b.index;
    if (a.kind === 1) return a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" }) * way || a.index - b.index;
    return a.index - b.index;
  });
  return keyed.map((entry) => entry.index);
}
