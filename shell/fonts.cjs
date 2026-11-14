// Fonts the user has added to Runes. They are kept in the profile, so the same font file
// gives the same text on every machine: nothing is looked up in the system's own fonts.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const KINDS = /\.(ttf|otf|woff2?)$/i;
const MAX_BYTES = 30 * 1024 * 1024, MAX_FILES = 80;

/** A family name that is safe to put in a style sheet, or "". */
const clean = (name) => String(name ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);

/** What a file's own name says: "FiraCode-BoldItalic.ttf" is Fira Code, bold, italic. */
function fromName(file) {
  const base = path.basename(file).replace(KINDS, "");
  const style = /italic|oblique/i.test(base) ? "italic" : "normal";
  const weight = /(extra|ultra)bold|black|heavy/i.test(base) ? 800 : /semibold|demibold/i.test(base) ? 600 : /bold/i.test(base) ? 700
    : /medium/i.test(base) ? 500 : /(extra|ultra)light|thin/i.test(base) ? 200 : /light/i.test(base) ? 300 : 400;
  const family = clean(base.replace(/[-_ ]?(regular|italic|oblique|(extra|ultra|semi|demi)?bold|black|heavy|medium|(extra|ultra)?light|thin|variable(font)?|\[.*\])+$/gi, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " "));
  return { family: family || clean(base), weight, style };
}

/**
 * The family and style a TrueType or OpenType file names for itself (its `name` table).
 * Null when the bytes are not such a font, or name nothing usable.
 */
function describe(bytes) {
  const b = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  if (b.length < 12) return null;
  const tag = b.toString("latin1", 0, 4);
  if (!(b.readUInt32BE(0) === 0x00010000 || tag === "OTTO" || tag === "true")) return null;
  const tables = b.readUInt16BE(4);
  let at = -1, size = 0;
  for (let i = 0; i < tables && 12 + i * 16 + 16 <= b.length; i++) {
    if (b.toString("latin1", 12 + i * 16, 16 + i * 16) === "name") { at = b.readUInt32BE(20 + i * 16); size = b.readUInt32BE(24 + i * 16); }
  }
  if (at < 0 || at + 6 > b.length || at + size > b.length) return null;
  const count = b.readUInt16BE(at + 2), strings = at + b.readUInt16BE(at + 4);
  const found = {};
  for (let i = 0; i < count && at + 6 + i * 12 + 12 <= b.length; i++) {
    const r = at + 6 + i * 12;
    const platform = b.readUInt16BE(r), id = b.readUInt16BE(r + 6), length = b.readUInt16BE(r + 8), offset = strings + b.readUInt16BE(r + 10);
    if (![1, 2, 16, 17].includes(id) || offset + length > b.length || length > 400) continue;
    const raw = b.subarray(offset, offset + length);
    const text = platform === 1 ? raw.toString("latin1") : Buffer.from(raw).swap16().toString("utf16le");
    // Windows and Unicode names are preferred over the old Macintosh ones.
    if (text && (platform !== 1 || !found[id])) found[id] = text;
  }
  const family = clean(found[16] ?? found[1]);
  if (!family) return null;
  const sub = String(found[17] ?? found[2] ?? "");
  return { family, weight: fromName("x-" + sub.replace(/\s+/g, "") + ".ttf").weight, style: /italic|oblique/i.test(sub) ? "italic" : "normal" };
}

/** Checks a font file and says what it is. Throws, in plain words, when it is not one Runes takes. */
function inspect(name, bytes) {
  if (typeof name !== "string" || !KINDS.test(name)) throw new Error("Runes takes .ttf, .otf, .woff and .woff2 font files");
  if (!(bytes instanceof Uint8Array) || bytes.length < 100) throw new Error("That file is empty");
  if (bytes.length > MAX_BYTES) throw new Error("That font file is larger than Runes accepts");
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString("latin1");
  const sfnt = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0) === 0x00010000 || head === "OTTO" || head === "true";
  if (head === "ttcf") throw new Error("Font collections (.ttc) are not supported; add the single fonts instead");
  if (!sfnt && head !== "wOFF" && head !== "wOF2") throw new Error(path.basename(name) + " is not a font file");
  return (sfnt && describe(bytes)) || fromName(name);
}

/** Stores a font in the profile. Returns [file, family, weight, style]. */
function add(dir, name, bytes) {
  const about = inspect(name, bytes);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.basename(name).replace(/[^\w.\- ]/g, "_");
  if (fs.readdirSync(dir).filter((f) => KINDS.test(f)).length >= MAX_FILES && !fs.existsSync(path.join(dir, file))) throw new Error("That is more fonts than Runes keeps; remove one first");
  fs.writeFileSync(path.join(dir, file), bytes);
  return [file, about.family, about.weight, about.style];
}

/** Every stored font: [file, family, weight, style, bytes]. */
function list(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => KINDS.test(f)).sort().slice(0, MAX_FILES); } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, file)));
      const about = inspect(file, bytes);
      out.push([file, about.family, about.weight, about.style, bytes]);
    } catch { /* a file that is no longer a font is left alone and not offered */ }
  }
  return out;
}

/** Removes every file of one family. */
function remove(dir, family) {
  for (const [file, name] of list(dir)) if (name === family) fs.rmSync(path.join(dir, file), { force: true });
}

module.exports = { add, list, remove, describe, fromName, inspect };
