// Reading VSIX archives in the shell. No Electron in here, so it can be tested with plain Node.
"use strict";
const fsSync = require("node:fs");
const path = require("node:path");
const { unzipSync } = require("fflate");

/** JSON as people write settings: comments and trailing commas allowed. */
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

const MAX_UNPACKED = 600 * 1024 * 1024;

/** A filter for unzipSync that stops an archive from expanding without limit. */
function within(limit) {
  let total = 0;
  return (file) => {
    total += file.originalSize;
    if (total > limit) throw new Error("This VSIX unpacks to more than Runes accepts (600 MB)");
    return true;
  };
}

/** Unpack a VSIX to a folder, refusing any entry that would land outside it. */
function unpack(bytes, to) {
  const zip = unzipSync(bytes, { filter: within(MAX_UNPACKED) });
  const manifest = JSON.parse(relaxed(Buffer.from(zip["extension/package.json"] ?? zip["package.json"]).toString("utf8")));
  const prefix = zip["extension/package.json"] ? "extension/" : "";
  for (const [name, data] of Object.entries(zip)) {
    if (!name.startsWith(prefix) || name.endsWith("/")) continue;
    const target = path.resolve(to, name.slice(prefix.length));
    if (!target.startsWith(to + path.sep)) throw new Error("This VSIX contains a path that leaves its own folder: " + name);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.writeFileSync(target, data);
  }
  return manifest;
}

function manifestOf(bytes) {
  const zip = unzipSync(bytes, { filter: (f) => (f.name === "extension/package.json" || f.name === "package.json") && f.originalSize < 4 * 1024 * 1024 });
  const raw = zip["extension/package.json"] ?? zip["package.json"];
  if (!raw) throw new Error("This is not a VSIX: there is no extension/package.json in it");
  return JSON.parse(relaxed(Buffer.from(raw).toString("utf8")));
}

const identity = (manifest) => `${manifest.publisher ?? "unknown"}.${manifest.name}`.replace(/[^\w.-]/g, "_");

module.exports = { relaxed, unpack, manifestOf, identity };
