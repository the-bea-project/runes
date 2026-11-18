// Following the disk for extensions. A language server learns that a project's manifest has
// changed (a dependency added to bea.toml, Cargo.toml, go.mod, package.json…) from the
// editor, through the file watchers its extension asks for. Until these were real, a new
// dependency was not known until the editor was started again.
// No Electron or vscode in here, so it can be tested with plain Node.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Folders that hold what is built or fetched, not what is written: each can hold tens of
// thousands of folders, and watching them all costs more than the system allows.
const SKIP = new Set([".git", "node_modules", ".beabuild", "build", "target", "dist", "out", ".venv", "venv", "__pycache__", ".next", ".cache", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea"]);

/** A glob as vscode writes them, as a pattern for a path with forward slashes. Null if it cannot be one. */
function globRegex(glob) {
  if (typeof glob !== "string" || glob.length > 2000) return null;
  let source = "", depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "{") { source += "(?:"; depth++; }
    else if (c === "}" && depth) { source += ")"; depth--; }
    else if (c === "," && depth) source += "|";
    else source += /[\w/-]/.test(c) ? c : "\\" + c;
  }
  try { return new RegExp("^" + source + "$"); } catch { return null; }
}

/**
 * Watches folders, one cheap watch each, and says what happened in them:
 * `onEvent("create" | "change" | "delete", full path)`. Folders made later are followed too.
 * `limit` is the most folders watched at once; past it, deeper folders are left out.
 */
function create({ onEvent, limit = 3000, delay = 150, skip = SKIP }) {
  const watched = new Map();   // folder -> { watcher, names: Map(name -> isFolder) }
  const pending = new Map();   // full path -> timer
  let closed = false;

  const forget = (dir) => {
    for (const [at, entry] of watched) {
      if (at !== dir && !at.startsWith(dir + path.sep)) continue;
      try { entry.watcher.close(); } catch {}
      watched.delete(at);
    }
  };

  /** What happened to one name in a watched folder, worked out from what was there before. */
  const settle = (dir, name) => {
    const entry = watched.get(dir);
    if (closed || !entry) return;
    const full = path.join(dir, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch {}
    const known = entry.names.has(name);
    if (!stat) {
      if (!known) return;
      const wasFolder = entry.names.get(name);
      entry.names.delete(name);
      if (wasFolder) forget(full);
      return onEvent("delete", full);
    }
    entry.names.set(name, stat.isDirectory());
    if (stat.isDirectory()) {
      if (!known) { onEvent("create", full); follow(full, 1, true, skip.has(name)); }
      return;
    }
    onEvent(known ? "change" : "create", full);
  };

  /** Starts watching a folder and those under it. `announce` says of each file found that it is new. */
  function follow(dir, depth = 0, announce = false, shallow = false) {
    if (closed || watched.has(dir) || watched.size >= limit || depth > 16) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    let watcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_kind, name) => {
        if (!name) return;
        const full = path.join(dir, String(name));
        clearTimeout(pending.get(full));
        // Programs write a file in several steps: one event is made of them.
        pending.set(full, setTimeout(() => { pending.delete(full); settle(dir, String(name)); }, delay));
      });
      watcher.on("error", () => forget(dir));
    } catch { return; }
    const names = new Map();
    watched.set(dir, { watcher, names });
    for (const e of entries) {
      const isFolder = e.isDirectory();
      names.set(e.name, isFolder);
      if (!isFolder) { if (announce) onEvent("create", path.join(dir, e.name)); continue; }
      if (e.isSymbolicLink()) continue;
      if (announce) onEvent("create", path.join(dir, e.name));
      // A folder of built or fetched things is watched itself, and nothing under it: the
      // files a tool keeps at its top (a lock file, a generated manifest) are how a server
      // learns that dependencies were fetched.
      if (!shallow) follow(path.join(dir, e.name), depth + 1, announce, skip.has(e.name));
    }
  }

  return {
    /** Follows a folder. `shallow` is for a folder asked for by name that would otherwise be skipped: only it, not what is under it. */
    add: (dir, shallow = false) => follow(path.resolve(dir), 0, false, shallow),
    watching: () => watched.size,
    close: () => {
      closed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const entry of watched.values()) { try { entry.watcher.close(); } catch {} }
      watched.clear();
    },
  };
}

module.exports = { create, globRegex, SKIP };
