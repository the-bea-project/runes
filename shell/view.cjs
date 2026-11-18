// Files that are looked at, not read as text: pictures, sound, film, PDFs and spreadsheets.
// The window is handed an address for one such file at a time, and the bytes are served from
// here. No Electron in here, so it can be tested with plain Node.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

// What each kind of file is served as. The type comes from the name, from this list and
// nowhere else: nothing is guessed from the bytes, and nothing that can run (a page, a
// script, an SVG with script in it) is in the list.
const TYPES = {
  image: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", apng: "image/apng" },
  audio: { mp3: "audio/mpeg", wav: "audio/wav", wave: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", weba: "audio/webm", mka: "audio/x-matroska" },
  video: { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska" },
  pdf: { pdf: "application/pdf" },
  sheet: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12" },
};
const ending = (name) => { const base = path.basename(String(name)); const dot = base.lastIndexOf("."); return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""; };
/** "image", "audio", "video", "pdf", "sheet", or "" for a file that is not looked at this way. */
const kindOf = (name) => Object.keys(TYPES).find((kind) => ending(name) in TYPES[kind]) ?? "";
const typeOf = (name) => TYPES[kindOf(name)]?.[ending(name)] ?? "";

/**
 * The part of a file a request asks for: `{ start, end }` (both counted in), null for all of
 * it, or false when what is asked for cannot be given. Players ask for parts to seek.
 */
function rangeOf(header, size) {
  if (!header) return null;
  const found = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!found || (found[1] === "" && found[2] === "")) return false;
  let start, end;
  if (found[1] === "") { const last = Number(found[2]); if (!last) return false; start = Math.max(0, size - last); end = size - 1; }
  else { start = Number(found[1]); end = found[2] === "" ? size - 1 : Math.min(Number(found[2]), size - 1); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end };
}

/** Addresses handed out, each good for one file: `{ grant(file) -> token, file(token) }`. The oldest are forgotten. */
function grants(limit = 200) {
  const held = new Map();
  return {
    grant: (file) => {
      for (const [token, at] of held) if (at === file) { held.delete(token); held.set(token, at); return token; }
      const token = crypto.randomBytes(18).toString("hex");
      held.set(token, file);
      while (held.size > limit) held.delete(held.keys().next().value);
      return token;
    },
    file: (token) => held.get(String(token)) ?? null,
    clear: () => held.clear(),
  };
}

/** What to answer a request for a file with: `{ status, headers, body }`, the body a web stream or null. */
async function answer(file, rangeHeader, method = "GET") {
  const type = typeOf(file);
  // Nothing served from here may do anything: it is shown, and that is all.
  // (A PDF is drawn by the engine's own viewer, which a sandboxed frame is not allowed to start;
  // what it may load is held to nothing all the same.)
  const headers = { "content-type": type, "x-content-type-options": "nosniff", "accept-ranges": "bytes", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" + (kindOf(file) === "pdf" ? "" : "; sandbox") };
  if (!type) return { status: 404, headers: {}, body: null };
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { status: 404, headers: {}, body: null }; }
  if (!stat.isFile()) return { status: 404, headers: {}, body: null };
  const range = rangeOf(rangeHeader, stat.size);
  if (range === false) return { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` }, body: null };
  const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
  headers["content-length"] = String(stat.size ? end - start + 1 : 0);
  if (range) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
  const body = method === "HEAD" || !stat.size ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return { status: range ? 206 : 200, headers, body };
}

module.exports = { TYPES, kindOf, typeOf, rangeOf, grants, answer };
