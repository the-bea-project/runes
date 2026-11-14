// Reading, searching and replacing in the files of the machine. No Electron in here, so it
// can be tested with plain Node.
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

const SKIP = new Set([".git", "node_modules", ".beabuild", "build", "target", "dist", "out", ".venv", "__pycache__", ".next", ".cache"]);
const MAX_FILE = 8 * 1024 * 1024;

/**
 * Where the files are. The functions below take one of these, so the same searching and
 * replacing works on this machine and on one reached over SSH (see ssh.cjs).
 */
const here = {
  walk: (root, limit) => walkLocal(root, limit),
  readText: (file) => readLocal(file),
  writeText: (file, text) => fs.writeFile(file, text, "utf8"),
  candidates: async () => null,
};

const walk = (root, limit = 20000, io = here) => io.walk(root, limit);
const readText = (file, io = here) => io.readText(file);

async function walkLocal(root, limit = 20000) {
  const found = [];
  const visit = async (dir, depth) => {
    if (found.length >= limit || depth > 14) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) await visit(path.join(dir, e.name), depth + 1); }
      else if (e.isFile()) found.push(path.join(dir, e.name));
    }
  };
  await visit(root, 0);
  return found;
}

async function readLocal(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_FILE) throw new Error("This file is larger than 8 MB; Runes does not open it yet");
  const data = await fs.readFile(file);
  if (data.subarray(0, 8000).includes(0)) throw new Error(path.basename(file) + " is not a text file");
  return data.toString("utf8");
}

function pattern(query, options) {
  if (typeof query !== "string" || !query || query.length > 2000) return null;
  let source = options?.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options?.word) source = `\\b(?:${source})\\b`;
  // "m": ^ and $ mean the ends of a line, since files are matched whole as well as by line.
  try { return new RegExp(source, options?.matchCase ? "gmu" : "gimu"); } catch { return null; }
}

/** Every line that matches, as [path, line, column, length, text]. */
async function search(root, query, options, io = here) {
  const re = pattern(query, options);
  if (!re) return [];
  const out = [];
  // Where the place the files are can say which ones might match, only those are read.
  for (const file of (await io.candidates(root, query, options)) ?? await io.walk(root, 20000)) {
    if (out.length >= 5000) break;
    let text;
    try { text = await io.readText(file); } catch { continue; }
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < 5000; i++) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(lines[i])) && out.length < 5000; ) {
        if (m[0] === "") { re.lastIndex++; continue; }
        out.push([file, i, m.index, m[0].length, lines[i].slice(0, 400)]);
      }
    }
  }
  return out;
}

/** Replace every match in the folder, except in the files named in `skip`. */
async function replaceInFiles(root, query, options, replacement, skip, io = here) {
  const re = pattern(query, options);
  if (!re) return { files: 0, count: 0, error: "Nothing to search for" };
  const leave = new Set(skip ?? []);
  let files = 0, count = 0;
  for (const file of (await io.candidates(root, query, options)) ?? await io.walk(root, 20000)) {
    if (leave.has(file)) continue;
    let text;
    try { text = await io.readText(file); } catch { continue; }
    let here = 0;
    const next = text.replace(re, (...args) => {
      here++;
      return options?.regex ? args[0].replace(new RegExp(re.source, re.flags.replace("g", "")), replacement) : replacement;
    });
    if (here === 0 || next === text) continue;
    await io.writeText(file, next);
    files++;
    count += here;
  }
  return { files, count };
}

module.exports = { walk, readText, search, replaceInFiles, pattern };
