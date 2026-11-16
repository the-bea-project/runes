// Runes as a desktop app: one window around dist/, and everything that window may ask the
// machine for. The window is sandboxed and loads nothing from the network; all it can do
// goes through the handlers below, and every one of them checks who is asking.
"use strict";
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, protocol, Menu, session, shell, utilityProcess } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { relaxed, unpack, manifestOf, identity } = require("./vsix.cjs");
const files = require("./files.cjs");
const git = require("./git.cjs");
const fonts = require("./fonts.cjs");
const market = require("./market.cjs");
const ssh = require("./ssh.cjs");

// Started from a terminal, the installed app lets the terminal go at once, as `code` does:
// it starts itself again in the background, with nowhere for Chromium's own chatter to be
// printed, and this first process ends. `runes --wait` stays attached; so does a run from
// source, where the output is wanted.
if (app.isPackaged && process.platform !== "win32" && process.stdout.isTTY && !process.env.RUNES_ATTACHED) {
  const args = process.argv.slice(1);
  if (args.includes("--version") || args.includes("-v")) { console.log(app.getVersion()); process.exit(0); }
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Runes " + app.getVersion() + "\n\n  runes [folder]     open a folder (default: the last one)\n  runes --wait       stay attached to this terminal until the window closes\n  runes --version    print the version");
    process.exit(0);
  }
  if (!args.includes("--wait")) {
    require("node:child_process").spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, RUNES_ATTACHED: "1" } }).unref();
    process.exit(0);
  }
}

const ORIGIN = "runes://app";
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const dist = path.join(__dirname, "..", "dist");
const user = (...parts) => path.join(app.getPath("userData"), ...parts);

// Every renderer process is sandboxed. The one exception is a run that was itself started
// with --no-sandbox (needed when running as root, as in CI containers).
if (!app.commandLine.hasSwitch("no-sandbox")) app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: "runes", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// --- Settings the shell itself needs ---------------------------------------------------------

function readSettings() {
  try { return JSON.parse(relaxed(fsSync.readFileSync(user("settings.json"), "utf8"))); } catch { return {}; }
}
async function state() {
  try { return JSON.parse(await fs.readFile(user("state.json"), "utf8")); } catch { return {}; }
}
async function remember(change) {
  const next = { ...(await state()), ...change };
  await fs.mkdir(user(), { recursive: true });
  await fs.writeFile(user("state.json"), JSON.stringify(next, null, 2));
}

/** The folder to open: one named on the command line, else the last one, else home. */
async function startFolder() {
  const plain = process.argv.slice(1).filter((a) => !a.startsWith("-"));
  const named = app.isPackaged ? plain[0] : plain[1];
  for (const candidate of [named && path.resolve(named), (await state()).folder]) {
    try { if (candidate && (await fs.stat(candidate)).isDirectory()) return candidate; } catch {}
  }
  return app.getPath("home");
}

// --- Extensions ----------------------------------------------------------------------------------

/** Extensions the person has switched off: installed still, but nothing of theirs is used or run. */
function disabledExtensions() {
  try { const all = JSON.parse(fsSync.readFileSync(user("extensions-disabled.json"), "utf8")); return Array.isArray(all) ? all.filter((id) => typeof id === "string").map((id) => id.toLowerCase()) : []; }
  catch { return []; }
}

/** Every installed extension that brings code, unpacked and ready for the extension host. */
function codeExtensions() {
  const found = new Map();
  const off = new Set(disabledExtensions());
  const sources = [];
  try { for (const n of JSON.parse(fsSync.readFileSync(path.join(dist, "extensions/index.json"), "utf8"))) sources.push(path.join(dist, "extensions", n)); } catch {}
  try { for (const n of fsSync.readdirSync(user("extensions"))) if (n.endsWith(".vsix")) sources.push(user("extensions", n)); } catch {}
  for (const source of sources) {
    try {
      const bytes = fsSync.readFileSync(source);
      const manifest = manifestOf(bytes);
      if (!manifest.main) continue;
      if (off.has(`${manifest.publisher}.${manifest.name}`.toLowerCase())) continue;
      const id = identity(manifest);
      const dir = user("unpacked", `${id}-${String(manifest.version).replace(/[^\w.-]/g, "_")}`);
      if (!fsSync.existsSync(path.join(dir, "package.json"))) unpack(bytes, dir);
      found.set(id, { id: `${manifest.publisher}.${manifest.name}`, dir, manifest });
    } catch (e) {
      console.error("Runes: could not prepare", source, e.message);
    }
  }
  return [...found.values()];
}

let host = null;
let window = null;
let folder = "";

// How each extension with code stands, and what it has said: kept here so the window can show
// it whenever it is asked for, however long ago it was said. "" is the host itself.
const running = new Map();
const KEPT_LINES = 2000;
let runningTick = null;
function runningChanged() {
  if (runningTick) return;
  runningTick = setTimeout(() => { runningTick = null; if (window && !window.isDestroyed()) window.webContents.send("runes:ext", { type: "running" }); }, 250);
}
function runningEntry(id, name) {
  if (!running.has(id)) running.set(id, { id, name: name ?? id, version: "", state: id ? "waiting" : "active", ms: 0, error: "", lines: [], dropped: 0 });
  return running.get(id);
}
function said(id, channel, textSaid) {
  const entry = runningEntry(running.has(id) ? id : "", "Extension host");
  for (const line of String(textSaid).replace(/\r/g, "").split("\n").slice(0, 400)) {
    entry.lines.push([Date.now(), String(channel).slice(0, 80), line.slice(0, 4000)]);
  }
  if (entry.lines.length > KEPT_LINES) { entry.dropped += entry.lines.length - KEPT_LINES; entry.lines.splice(0, entry.lines.length - KEPT_LINES); }
  runningChanged();
}

/**
 * Ends an extension host: it is asked to stop, so that extensions can end what they started
 * (their language servers, above all), and is made to if it has not gone soon after.
 */
function endHost(old) {
  if (!old) return;
  try { old.postMessage({ type: "stop" }); } catch {}
  setTimeout(() => { try { old.kill(); } catch {} }, 2500);
}

function startHost() {
  endHost(host);
  host = utilityProcess.fork(path.join(__dirname, "exthost", "host.cjs"), [], { serviceName: "Runes Extension Host", stdio: "pipe" });
  const mine = host;
  const extensions = codeExtensions();
  running.clear();
  runningEntry("", "Extension host");
  for (const e of extensions) Object.assign(runningEntry(e.id, e.manifest.displayName ?? e.manifest.name), { version: String(e.manifest.version ?? "") });
  runningChanged();
  // What the host's process prints (an extension's child process writing to its parent, say).
  mine.stdout?.on("data", (d) => { if (host === mine) said("", "stdout", d.toString("utf8")); });
  mine.stderr?.on("data", (d) => { if (host === mine) said("", "stderr", d.toString("utf8")); });
  mine.on("message", (m) => {
    if (host !== mine || !m || typeof m !== "object") return;
    if (m.type === "status") {
      const entry = runningEntry(String(m.extension));
      Object.assign(entry, { state: String(m.state), ms: Number(m.ms) || entry.ms, error: String(m.error ?? "") });
      if (m.error) said(entry.id, "Errors", m.error);
      return runningChanged();
    }
    if (m.type === "output") return said(String(m.extension ?? ""), m.channel ?? "", m.text ?? "");
    if (m.type === "note" && m.level === "log") return said("", "Host", m.text ?? "");
    if (window && !window.isDestroyed()) window.webContents.send("runes:ext", m);
  });
  mine.on("exit", (code) => {
    if (host !== mine) return;
    host = null;
    for (const entry of running.values()) if (entry.id && entry.state !== "failed") entry.state = "stopped";
    said("", "Host", "The extension host stopped" + (code ? " with code " + code : "") + ".");
    if (code && window && !window.isDestroyed()) window.webContents.send("runes:ext", { type: "note", level: "error", text: "The extension host stopped unexpectedly. Reload Runes to start it again." });
  });
  mine.postMessage({
    type: "init", root: folder, appRoot: path.join(__dirname, ".."), storage: user("extension-storage"),
    settings: readSettings(), extensions,
  });
}

// --- Another machine, over SSH ---------------------------------------------------------------
// While a session is connected, `remote` is that machine and `folder` is a folder on it: the
// file, search, git and terminal handlers below then act there. Runes' own files (settings,
// extensions, fonts) are always this machine's.

let remote = null, remoteSession = null, localFolder = "";
const own = (file) => { const full = path.resolve(file); return full === user() || full.startsWith(user() + path.sep); };
const far = (file) => remote && !own(file);
const knownHosts = {
  read() { try { return JSON.parse(fsSync.readFileSync(user("ssh-known-hosts.json"), "utf8")); } catch { return {}; } },
  get(host) { return this.read()[host]; },
  set(host, print) { const all = this.read(); if (print) all[host] = print; else delete all[host]; fsSync.mkdirSync(user(), { recursive: true }); fsSync.writeFileSync(user("ssh-known-hosts.json"), JSON.stringify(all, null, 2)); },
};
const sshSessions = () => ssh.load(user("ssh-sessions.json"));

// Questions for the person (a password, whether to trust a machine) are put in the window,
// which answers through `promptAnswer`. Unanswered, they count as "no" after five minutes.
const questions = new Map();
let questionIds = 0;
function question(kind, title, detail, initial = "") {
  return new Promise((resolve) => {
    if (!window || window.isDestroyed()) return resolve(kind === "confirm" ? false : null);
    const id = ++questionIds;
    const timer = setTimeout(() => { questions.delete(id); resolve(kind === "confirm" ? false : null); }, 5 * 60 * 1000);
    questions.set(id, (value) => { clearTimeout(timer); resolve(value); });
    window.webContents.send("runes:prompt", { id, kind, title: String(title), detail: String(detail), initial });
  });
}

/** Back to this machine: the folder that was open before, its git, its extensions. */
function leaveRemote(note) {
  if (!remote) return;
  const was = remoteSession;
  const gone = remote;
  unwatch();
  remote = null; remoteSession = null;
  gone.end();
  git.over(null);
  for (const [id, term] of terminals) if (term.far) { try { term.kill(); } catch {} terminals.delete(id); }
  folder = localFolder;
  startHost();
  if (window && !window.isDestroyed()) {
    window.setTitle("Runes");
    if (note) window.webContents.send("runes:ssh", { left: was?.name ?? "", folder, note });
  }
}

// --- Files of the open folder, and noticing when they change ---------------------------------------

/** A path the window names for changing: it must lie inside the open folder, and not be the folder itself. */
const shq = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
/** A name in a folder that nothing has yet: "notes.md", then "notes copy.md", "notes copy 2.md". */
async function freeName(dir, name, copying) {
  const P = remote ? path.posix : path;
  const exists = (file) => (remote ? remote.exists(file) : fs.access(file).then(() => true, () => false));
  if (!(await exists(P.join(dir, name)))) return P.join(dir, name);
  const dot = name.startsWith(".") ? -1 : name.lastIndexOf(".");
  const [stem, ending] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n < 1000; n++) {
    const candidate = P.join(dir, `${stem} ${copying ? "copy" : "moved"}${n > 1 ? " " + n : ""}${ending}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(name + " already exists");
}
/** Sends a file or folder of this machine to the machine reached over SSH. */
async function upload(from, to, info, sent) {
  if (info.isDirectory()) {
    await remote.create(to, true);
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      await upload(path.join(from, entry.name), path.posix.join(to, entry.name), await fs.stat(path.join(from, entry.name)), sent);
    }
    return;
  }
  if (!info.isFile()) return;
  sent.files += 1; sent.bytes += info.size;
  if (sent.files > 5000 || sent.bytes > 2 * 1024 * 1024 * 1024) throw new Error("That is too much to send over SSH in one go (5000 files or 2 GB)");
  await remote.call("fastPut", from, to);
}

function within(file) {
  const P = remote ? path.posix : path;
  text(file);
  if (file.includes("\0") || !folder) throw new Error("Bad request");
  const full = remote ? P.normalize(file) : P.resolve(file);
  if (remote && !full.startsWith("/")) throw new Error("Bad request");
  if (!full.startsWith(folder.endsWith(P.sep) ? folder : folder + P.sep) || full === folder) throw new Error("That is outside the open folder");
  return full.endsWith(P.sep) ? full.slice(0, -1) : full;
}

// The explorer follows the disk. Only the folders it has open are watched, one cheap watch
// each (and the repository's own folder, for commits and switches made elsewhere), so a
// huge tree costs nothing until it is looked at. On another machine there is nothing to
// watch with, so the same folders are asked their age every few seconds, in one round trip.
const watches = new Map();
let watched = [], ages = new Map(), poll = null, pending = null;
function notice(dir, file, vcs) {
  pending ??= { dirs: new Set(), files: new Set(), git: false, timer: setTimeout(() => {
    const out = pending; pending = null;
    if (window && !window.isDestroyed()) window.webContents.send("runes:fs", { dirs: [...out.dirs], files: [...out.files], git: out.git });
  }, 120) };
  if (dir) pending.dirs.add(dir);
  if (file) pending.files.add(file);
  if (vcs) pending.git = true;
}
function unwatch() {
  for (const w of watches.values()) { try { w.close(); } catch {} }
  watches.clear(); ages = new Map(); watched = [];
  clearInterval(poll); poll = null;
}
function watch(dirs) {
  const P = remote ? path.posix : path;
  const wanted = [...new Set(dirs)].filter((d) => typeof d === "string" && d.length < 4096 && (d === folder || d.startsWith(folder + P.sep))).slice(0, 300);
  if (remote) {
    for (const w of watches.values()) { try { w.close(); } catch {} }
    watches.clear();
    watched = wanted;
    for (const dir of [...ages.keys()]) if (!wanted.includes(dir)) ages.delete(dir);
    poll ??= setInterval(async () => {
      const on = remote;
      if (!on || !watched.length || !window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) return;
      let found;
      try { found = await on.times(watched); } catch { return; }
      if (remote !== on) return;
      for (const [dir, age] of found) {
        const before = ages.get(dir);
        // An age is told in whole seconds, so a change in the same second as the last one
        // does not show in it. A folder first seen, or just changed, is therefore looked
        // at once more on the next round, by its listing.
        ages.set(dir, { age, warm: !before || before.age !== age });
        if (before && before.age !== age) { on.forget(dir); notice(dir, "", false); }
        else if (before?.warm) { const kept = on.lists.get(dir); if (kept?.entries && !kept.pending) on.refresh(dir, kept.entries); }
      }
    }, 4000);
    return;
  }
  clearInterval(poll); poll = null; ages = new Map();
  const all = new Set(wanted);
  const vcs = folder && path.join(folder, ".git");
  if (vcs && fsSync.existsSync(vcs)) all.add(vcs);
  for (const [dir, w] of watches) if (!all.has(dir)) { try { w.close(); } catch {} watches.delete(dir); }
  for (const dir of all) {
    if (watches.has(dir)) continue;
    try {
      const w = fsSync.watch(dir, { persistent: false }, (kind, name) => {
        if (dir === vcs) { if (name === "HEAD" || name === "index" || name === "ORIG_HEAD") notice("", "", true); return; }
        if (name === ".git" || (name && /(\.swp|\.swx|~|\.runes-part|\.part)$/.test(name))) return;
        if (kind === "rename" || !name) notice(dir, "", false); else notice("", path.join(dir, name), false);
      });
      // A watched folder that is itself removed: the folder above it has changed.
      w.on("error", () => { try { w.close(); } catch {} watches.delete(dir); notice(path.dirname(dir), "", false); });
      watches.set(dir, w);
    } catch {}
  }
}

// Pictures of marketplace extensions, kept on disk by the hash of their address: a version's
// icon never changes, so it is fetched once. Old ones are cleared out now and then.
const pictures = {
  file: (url) => user("icon-cache", crypto.createHash("sha256").update(url).digest("hex")),
  get: (url) => fs.readFile(pictures.file(url), "utf8"),
  set: async (url, address) => {
    await fs.mkdir(user("icon-cache"), { recursive: true });
    await fs.writeFile(pictures.file(url), address);
    if (Math.random() < 0.02) {
      const old = Date.now() - 60 * 24 * 3600 * 1000;
      for (const name of await fs.readdir(user("icon-cache"))) {
        const file = user("icon-cache", name);
        try { if ((await fs.stat(file)).mtimeMs < old) await fs.unlink(file); } catch {}
      }
    }
  },
};

// --- Terminals -----------------------------------------------------------------------------------

const terminals = new Map();
function defaultShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (fsSync.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
}

// --- What the window may ask for -----------------------------------------------------------------

const text = (value, max = 4096) => { if (typeof value !== "string" || value.length > max) throw new Error("Bad request"); return value; };
const whole = (value, min, max) => { if (!Number.isInteger(value) || value < min || value > max) throw new Error("Bad request"); return value; };

const handlers = {
  info: () => ({ version: app.getVersion(), platform: process.platform }),
  root: async () => { folder = await startFolder(); startHost(); return folder; },
  pickFolder: async () => {
    const picked = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    if (picked.canceled) return "";
    // Opening a folder of this machine ends an SSH session.
    if (remote) { localFolder = picked.filePaths[0]; leaveRemote(""); }
    folder = picked.filePaths[0];
    await remember({ folder });
    startHost();
    return folder;
  },
  readDir: async (dir) => (far(text(dir)) ? remote.readDir(dir)
    : (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.name !== ".git").map((e) => [e.name, e.isDirectory()])),
  walk: (root) => (far(text(root)) ? remote.walk(root) : files.walk(root)),
  readFile: (file) => (far(text(file)) ? remote.readText(file) : files.readText(file)),
  writeFile: async (file, content) => {
    text(content, 64 * 1024 * 1024);
    if (far(text(file))) return remote.writeText(file, content);
    if (path.dirname(path.resolve(text(file))) === user()) {
      // Runes' own settings are replaced in one step, so they are never read half-written.
      await fs.writeFile(file + ".part", content, "utf8");
      await fs.rename(file + ".part", file);
    } else {
      await fs.writeFile(file, content, "utf8");
    }
    if (path.resolve(file) === user("settings.json")) host?.postMessage({ type: "settings", settings: readSettings() });
  },
  saveAs: async (name) => {
    if (remote) {
      // The file is to live on the other machine, where this machine's file dialog cannot look.
      const typed = await question("text", "Save on " + remoteSession.name, "The full path of the new file.", path.posix.join(folder, path.basename(text(name))));
      if (!typed) return "";
      if (!typed.startsWith("/")) throw new Error("Give the full path, starting with /");
      return path.posix.normalize(typed);
    }
    const picked = await dialog.showSaveDialog(window, { defaultPath: path.join(folder || app.getPath("home"), path.basename(text(name))) });
    return picked.canceled ? "" : picked.filePath;
  },
  /**
   * Saves a picture the window has made (a drawing, as a PNG) where the person says. The
   * window never names the place: it comes from the system's own dialog, and what is written
   * must be a PNG, by its first bytes. Resolves to the path, or "" when the dialog was closed.
   */
  saveImage: async (name, address) => {
    text(address, 64 * 1024 * 1024);
    const found = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(address);
    const bytes = found && Buffer.from(found[1], "base64");
    if (!bytes || bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("That is not a picture");
    const picked = await dialog.showSaveDialog(window, { defaultPath: path.join(remote ? app.getPath("home") : folder || app.getPath("home"), path.basename(text(name)).replace(/[^\w .-]/g, "_")), filters: [{ name: "PNG picture", extensions: ["png"] }] });
    if (picked.canceled || !picked.filePath) return "";
    await fs.writeFile(picked.filePath, bytes);
    return picked.filePath;
  },
  // --- Changing the files of the open folder: only ever inside it ---
  /** A new empty file or folder. Folders above it that are missing are made; nothing is overwritten. */
  fileCreate: async (file, isFolder) => {
    const full = within(file);
    if (remote) return void (await remote.create(full, !!isFolder));
    if (fsSync.existsSync(full)) throw new Error(path.basename(full) + " already exists");
    if (isFolder) return void (await fs.mkdir(full, { recursive: true }));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "", { flag: "wx" });
  },
  fileRename: async (from, to) => {
    const [a, b] = [within(from), within(to)];
    if (remote) return void (await remote.rename(a, b));
    // On a disk that ignores case, a change of case alone is the same file and is fine.
    if (fsSync.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) throw new Error(path.basename(b) + " already exists");
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.rename(a, b);
  },
  /** Asks first. Here a file goes to the trash; on another machine there is none, and it says so. Resolves true when it is gone. */
  fileRemove: async (file) => {
    const full = within(file);
    const name = (remote ? path.posix : path).basename(full);
    if (remote) {
      if (!(await question("confirm", "Delete " + name + " for good?", full + " on " + remoteSession.name + "\n\nThere is no trash on the other machine. A folder goes with everything in it. This cannot be undone.", "Delete"))) return false;
      await remote.remove(full);
      return true;
    }
    if (!(await question("confirm", "Move " + name + " to the trash?", full + "\n\nA folder goes with everything in it. You can bring it back from the trash.", "Move to trash"))) return false;
    try { await shell.trashItem(full); }
    catch {
      if (!(await question("confirm", "Delete " + name + " for good?", "It could not be moved to the trash on this system.\n" + full + "\n\nThis cannot be undone.", "Delete"))) return false;
      await fs.rm(full, { recursive: true, force: true });
    }
    return true;
  },
  /** Several at once, asked about once. Resolves to the paths that are gone. */
  filesRemove: async (list) => {
    if (!Array.isArray(list) || !list.length || list.length > 500) throw new Error("Bad request");
    const P = remote ? path.posix : path;
    // A folder takes what is in it: nothing under a folder that is going is asked for again.
    const all = [...new Set(list.map((f) => within(f)))].sort();
    const full = all.filter((f) => !all.some((other) => other !== f && f.startsWith(other + P.sep)));
    const names = full.slice(0, 8).map((f) => P.basename(f)).join(", ") + (full.length > 8 ? " and " + (full.length - 8) + " more" : "");
    if (remote) {
      if (!(await question("confirm", "Delete " + full.length + " items for good?", names + "\n\non " + remoteSession.name + ". There is no trash on the other machine. Folders go with everything in them. This cannot be undone.", "Delete"))) return [];
      for (const f of full) await remote.remove(f);
      return full;
    }
    if (!(await question("confirm", "Move " + full.length + " items to the trash?", names + "\n\nFolders go with everything in them. You can bring them back from the trash.", "Move to trash"))) return [];
    const gone = [];
    for (const f of full) {
      try { await shell.trashItem(f); gone.push(f); }
      catch {
        if (!(await question("confirm", "Delete " + P.basename(f) + " for good?", "It could not be moved to the trash on this system.\n" + f + "\n\nThis cannot be undone.", "Delete"))) continue;
        await fs.rm(f, { recursive: true, force: true });
        gone.push(f);
      }
    }
    return gone;
  },
  fileReveal: (file) => { if (!remote) shell.showItemInFolder(within(file)); },
  /**
   * Copies or moves files and folders of the open folder into one of its folders. Nothing is
   * written over: a name that is taken gets " copy" added. Resolves to the new paths.
   */
  filePlace: async (sources, into, move) => {
    if (!Array.isArray(sources) || !sources.length || sources.length > 500) throw new Error("Bad request");
    const P = remote ? path.posix : path;
    const dir = text(into) === folder ? folder : within(into);
    const made = [];
    for (const source of sources) {
      const from = within(source);
      if (dir === from || dir.startsWith(from + P.sep)) throw new Error("A folder cannot be put inside itself");
      if (move && P.dirname(from) === dir) { made.push(from); continue; }
      const to = await freeName(dir, P.basename(from), !move);
      if (remote) {
        if (move) await remote.rename(from, to);
        else await remote.exec("cp -R -- " + shq(from) + " " + shq(to));
      } else if (move) {
        await fs.rename(from, to).catch(async (e) => { if (e.code !== "EXDEV") throw e; await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false }); await fs.rm(from, { recursive: true, force: true }); });
      } else {
        await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      }
      made.push(to);
    }
    if (remote) remote.forget(dir);
    return made;
  },
  /**
   * Files and folders dragged in from outside Runes (or copied in a file manager) are copied
   * into a folder of the open folder. Where each one lives is asked of the system by the
   * preload, from the dropped thing itself. Nothing is written over, and only inside the folder.
   */
  fileImport: async (paths, into) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 500) throw new Error("Bad request");
    const P = remote ? path.posix : path;
    const dir = text(into) === folder ? folder : within(into);
    const made = [];
    for (const given of paths) {
      const from = path.resolve(text(given));
      if (!path.isAbsolute(given) || given.includes("\0")) throw new Error("Bad request");
      const info = await fs.stat(from);
      if (!remote && (dir === from || dir.startsWith(from + path.sep))) throw new Error("A folder cannot be put inside itself");
      const to = await freeName(dir, path.basename(from), true);
      if (remote) await upload(from, to, info, { files: 0, bytes: 0 });
      else await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      made.push(to);
    }
    if (remote) remote.forget(dir);
    return made;
  },
  /**
   * Files copied in a file manager, as the system's clipboard names them (absolute paths).
   * File managers put them there as a list of file:// addresses, under one name or another.
   */
  clipboardFiles: async () => {
    const found = [];
    try {
      for (const item of await clipboard.read()) {
        for (const type of item.types) {
          if (!/uri-list|gnome-copied-files|file-url|FileNameW/i.test(type)) continue;
          const data = await item.getType(type).catch(() => null);
          const raw = typeof data === "string" ? data : typeof data?.text === "function" ? await data.text() : "";
          for (const line of raw.split(/\r?\n|\0/)) {
            if (line.startsWith("file://")) { try { found.push(require("node:url").fileURLToPath(line.trim())); } catch {} }
          }
        }
        if (found.length) break;
      }
    } catch {}
    return [...new Set(found)].slice(0, 500);
  },
  /** Which folders the explorer has open, so they can be followed. */
  watchDirs: (dirs) => watch(Array.isArray(dirs) ? dirs : []),

  userFiles: async () => {
    await fs.mkdir(user(), { recursive: true });
    for (const [name, initial] of [["settings.json", ""], ["keybindings.json", "// Your key bindings, as in VS Code: [{ \"key\": \"ctrl+shift+d\", \"command\": \"editor.action.copyLinesDownAction\" }]\n[\n]\n"]]) {
      try { await fs.access(user(name)); } catch { await fs.writeFile(user(name), initial); }
    }
    return { settings: user("settings.json"), keybindings: user("keybindings.json") };
  },
  search: (root, query, options) => files.search(text(root), text(query), options, far(root) ? remote : undefined),
  replaceInFiles: async (root, query, options, replacement, skip) => {
    const answer = await dialog.showMessageBox(window, {
      type: "warning", buttons: ["Replace", "Cancel"], defaultId: 1, cancelId: 1,
      message: "Replace in every file of this folder?",
      detail: `"${text(query)}" becomes "${text(replacement)}" in ${root}. This cannot be undone from Runes.`,
    });
    if (answer.response !== 0) return { files: 0, count: 0, error: "Nothing was replaced." };
    return files.replaceInFiles(text(root), query, options, replacement, Array.isArray(skip) ? skip.filter((s) => typeof s === "string") : [], far(root) ? remote : undefined);
  },

  extensions: async () => {
    try {
      const names = (await fs.readdir(user("extensions"))).filter((n) => n.endsWith(".vsix"));
      return Promise.all(names.map(async (n) => [n, new Uint8Array(await fs.readFile(user("extensions", n)))]));
    } catch { return []; }
  },
  /** Returns "" when installed, or why not. An extension that brings code is only installed if the user agrees. */
  /** Fonts added to Runes live in the profile; the window is given their bytes to draw with. */
  fonts: () => fonts.list(user("fonts")),
  fontAdd: (name, bytes) => fonts.add(user("fonts"), text(name, 300), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  fontRemove: (family) => fonts.remove(user("fonts"), text(family, 100)),
  installExtension: async (_name, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 300 * 1024 * 1024) return "That file is not a VSIX Runes can read.";
    let manifest;
    try { manifest = manifestOf(bytes); } catch (e) { return e.message; }
    if (manifest.main) {
      const answer = await dialog.showMessageBox(window, {
        type: "warning", buttons: ["Install", "Cancel"], defaultId: 1, cancelId: 1,
        message: `Install ${manifest.displayName ?? manifest.name}?`,
        detail: `This extension by "${manifest.publisher ?? "an unknown publisher"}" contains code. Once installed it runs with the same access to your files and network as you have. Install it only if you trust where it came from.`,
      });
      if (answer.response !== 0) return "The extension was not installed.";
    }
    await fs.mkdir(user("extensions"), { recursive: true });
    await fs.writeFile(user("extensions", identity(manifest) + ".vsix"), Buffer.from(bytes));
    if (manifest.main) startHost();
    return "";
  },
  removeExtension: async (name) => {
    await fs.rm(user("extensions", path.basename(text(name)).replace(/[^\w.-]/g, "_")), { force: true });
    startHost();
  },
  /** The ids ("publisher.name", lower case) of the extensions that are switched off. */
  extensionsDisabled: () => disabledExtensions(),
  /** Switches an extension on or off. The extension host starts afresh, without it or with it. */
  extensionEnable: async (id, on) => {
    const key = text(id, 200).toLowerCase();
    if (!/^[\w-]+\.[\w.-]+$/.test(key)) throw new Error("Bad request");
    const off = new Set(disabledExtensions());
    if (on) off.delete(key); else off.add(key);
    await fs.mkdir(user(), { recursive: true });
    await fs.writeFile(user("extensions-disabled.json"), JSON.stringify([...off].sort(), null, 2));
    startHost();
    return [...off];
  },
  /** Every extension with code: whether it is running, how long it took to start, and what it has said. */
  extensionsRunning: () => [...running.values()].map((e) => ({ id: e.id, name: e.name, version: e.version, state: e.state, ms: e.ms, error: e.error, dropped: e.dropped, lines: e.lines })),
  /** Starts the extension host again: every extension is loaded afresh. */
  extensionsRestart: () => { startHost(); },
  marketSearch: (query) => market.search(text(query, 200), (url, options) => net.fetch(url, options)),
  marketDownload: (namespace, name) => market.download(text(namespace, 120), text(name, 120), (url, options) => net.fetch(url, options)),

  // Version control always works on the open folder, never on a path the window names.
  gitStatus: () => git.status(folder),
  gitLog: (limit, until) => git.log(folder, whole(limit, 1, 5000), text(until ?? "", 10)),
  gitDays: () => git.days(folder),
  gitTree: (at) => git.tree(folder, text(at, 200)),
  gitHistory: (name, from) => git.history(folder, text(name), text(from, 200)),
  gitShow: (hash) => git.show(folder, text(hash, 40)),
  gitStage: (paths) => git.stage(folder, paths),
  gitUnstage: (paths) => git.unstage(folder, paths),
  /** Asks first: this is the one thing in source control that loses work. Resolves true when done. */
  gitDiscard: async (paths) => {
    if (!Array.isArray(paths) || !paths.length) throw new Error("Bad request");
    const what = paths.length === 1 ? String(paths[0]) : paths.length + " files";
    if (!(await question("confirm", "Discard the changes to " + what + "?", "Changed files go back to the last commit, deleted ones come back, and new files that were never committed are deleted.\n\nThis cannot be undone.", "Discard"))) return false;
    await git.discard(folder, paths);
    return true;
  },
  gitFile: (at, name) => git.file(folder, text(at, 200), text(name)),
  gitChanged: (from, to) => git.changed(folder, text(from, 200), text(to, 200)),
  gitRefs: () => git.refs(folder),
  /** Who last changed a line; `content` is the text being edited, when it differs from the disk. */
  gitBlame: (name, line, content) => git.blame(folder, text(name), whole(line, 0, 10_000_000), typeof content === "string" ? text(content, 20 << 20) : undefined),
  marketReadme: (namespace, name) => market.readme(text(namespace, 100), text(name, 100), (address, options) => net.fetch(address, options)),
  marketIcon: (url) => market.icon(text(url, 600), (address, options) => net.fetch(address, options), pictures, (bytes, type) => {
    // A photograph of an icon is brought down to the size it is shown at.
    if (type === "image/svg+xml" || type === "image/gif" || bytes.length < 48 * 1024) return null;
    const picture = nativeImage.createFromBuffer(bytes);
    if (picture.isEmpty() || picture.getSize().width <= 160) return null;
    return { type: "image/png", bytes: picture.resize({ width: 128, quality: "best" }).toPNG() };
  }),

  extSend: (message) => { if (message && typeof message === "object" && typeof message.type === "string" && message.type !== "init") host?.postMessage(message); },

  // --- SSH -----------------------------------------------------------------------------------
  promptAnswer: (id, value) => {
    const answer = questions.get(id);
    questions.delete(id);
    answer?.(typeof value === "string" ? value.slice(0, 4096) : value === true ? true : value === false ? false : null);
  },
  sshSessions: () => sshSessions().map((s) => ({ ...s, known: !!knownHosts.get(s.host + ":" + s.port), on: remoteSession?.id === s.id })),
  sshSave: (session) => ssh.save(user("ssh-sessions.json"), session).id,
  sshRemove: (id) => { if (remoteSession?.id === id) leaveRemote("removed"); ssh.remove(user("ssh-sessions.json"), text(id, 40)); },
  sshImport: async () => {
    let config = "";
    try { config = await fs.readFile(path.join(os.homedir(), ".ssh", "config"), "utf8"); } catch { throw new Error("There is no ~/.ssh/config on this machine."); }
    const have = new Set(sshSessions().map((s) => s.name));
    const fresh = ssh.fromConfig(config).filter((s) => !have.has(s.name));
    for (const s of fresh) ssh.save(user("ssh-sessions.json"), s);
    return fresh.length;
  },
  sshForget: (id) => { const s = sshSessions().find((x) => x.id === text(id, 40)); if (s) knownHosts.set(s.host + ":" + s.port, ""); },
  sshConnect: async (id) => {
    const session = sshSessions().find((s) => s.id === text(id, 40));
    if (!session) throw new Error("That session is no longer saved.");
    const connected = await ssh.connect(session, { secret: (t, d) => question("secret", t, d), confirm: (t, d) => question("confirm", t, d) }, knownHosts);
    let root;
    try {
      root = await connected.resolve(session.folder);
      if (!(await connected.isDirectory(root))) throw new Error(root + " is not a folder on " + session.name);
    } catch (e) { connected.end(); throw e; }
    if (remote) leaveRemote(""); else localFolder = folder;
    unwatch();
    remote = connected; remoteSession = session;
    connected.onStale = (dir) => { if (remote === connected) notice(dir, "", false); };
    folder = root;
    git.over(connected);
    // Extensions run here and could only see this machine's files, so they rest for now.
    host?.kill(); host = null;
    connected.onClose = () => { if (remote === connected) leaveRemote("The connection to " + session.name + " was lost."); };
    window.setTitle("Runes — " + session.name + " (SSH)");
    return { id: session.id, name: session.name, folder: root };
  },
  /** Another folder on the connected machine. */
  sshOpen: async (dir) => {
    if (!remote) throw new Error("Not connected.");
    const root = await remote.resolve(text(dir));
    if (!(await remote.isDirectory(root))) throw new Error(root + " is not a folder on " + remoteSession.name);
    folder = root;
    return root;
  },
  sshDisconnect: () => { leaveRemote(""); return folder; },

  termCreate: (id, shellPath, cwd, cols, rows) => {
    whole(id, 1, 10000);
    if (remote) {
      // A shell on the other machine. Keys typed before it is ready are kept for it.
      terminals.get(id)?.kill();
      const early = [];
      const term = { far: true, write: (d) => early.push(d), resize: () => {}, kill: () => { term.dead = true; } };
      terminals.set(id, term);
      const gone = () => { if (terminals.get(id) === term) terminals.delete(id); if (window && !window.isDestroyed()) window.webContents.send("runes:termExit", id); };
      remote.shell(folder, whole(cols, 2, 1000), whole(rows, 1, 1000), (data) => { if (window && !window.isDestroyed()) window.webContents.send("runes:term", id, data); }, gone)
        .then((shell) => {
          if (term.dead) return shell.kill();
          Object.assign(term, shell, { far: true });
          for (const d of early) shell.write(d);
        }, gone);
      return;
    }
    const pty = require("@lydell/node-pty");
    const command = text(shellPath) || readSettings()["terminal.shell"] || defaultShell();
    let start = text(cwd) || folder || os.homedir();
    if (!fsSync.existsSync(start)) start = os.homedir();
    terminals.get(id)?.kill();
    const term = pty.spawn(command, [], { name: "xterm-256color", cols: whole(cols, 2, 1000), rows: whole(rows, 1, 1000), cwd: start, env: { ...process.env, TERM_PROGRAM: "runes", COLORTERM: "truecolor" } });
    terminals.set(id, term);
    term.onData((data) => { if (window && !window.isDestroyed()) window.webContents.send("runes:term", id, data); });
    term.onExit(() => { if (terminals.get(id) === term) terminals.delete(id); if (window && !window.isDestroyed()) window.webContents.send("runes:termExit", id); });
  },
  termWrite: (id, data) => terminals.get(id)?.write(text(data, 1 << 20)),
  termResize: (id, cols, rows) => { try { terminals.get(id)?.resize(whole(cols, 2, 1000), whole(rows, 1, 1000)); } catch {} },
  termKill: (id) => { terminals.get(id)?.kill(); terminals.delete(id); },

  /**
   * Starts Runes afresh in the same window: the page is loaded again and the extension host
   * with it. The folder (and a machine reached over SSH) stay as they are.
   */
  reload: () => {
    for (const [id, term] of terminals) { try { term.kill(); } catch {} terminals.delete(id); }
    unwatch();
    endHost(host); host = null;
    setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.reload(); }, 30);
  },
  zoom: (by) => { const w = window.webContents; w.setZoomLevel(by === 0 ? 0 : Math.max(-3, Math.min(5, w.getZoomLevel() + (by > 0 ? 0.5 : -0.5)))); },
  devtools: () => window.webContents.toggleDevTools(),
  /**
   * A link in a readme or a Markdown preview. Only http(s), and only after the user has seen
   * the whole address and agreed: the text of a link says nothing about where it goes.
   */
  openLink: async (url) => {
    let target;
    try { target = new URL(text(url, 2000)); } catch { return; }
    if (target.protocol !== "https:" && target.protocol !== "http:") return;
    const answer = await dialog.showMessageBox(window, {
      type: "question", buttons: ["Open in browser", "Cancel"], defaultId: 0, cancelId: 1,
      message: "Open this link in your browser?", detail: target.href,
    });
    if (answer.response === 0) shell.openExternal(target.href);
  },
};


// Something that went wrong where nothing was waiting for it is written down, and the app
// carries on: the alternative is a box that stops every window until it is answered.
process.on("uncaughtException", (e) => { console.error("[runes]", e?.stack ?? e); });
process.on("unhandledRejection", (e) => { console.error("[runes]", e?.stack ?? e); });

app.whenReady().then(() => {
  // dist/ is served as runes://app/, so the page can fetch its own files and nothing else.
  protocol.handle("runes", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    const file = path.normalize(path.join(dist, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
    if (!file.startsWith(dist + path.sep)) return new Response("Forbidden", { status: 403 });
    const response = await net.fetch(pathToFileURL(file).toString());
    // The page's rules travel with the page: scripts and styles from the app only, no network.
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", CSP);
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
  for (const [name, handle] of Object.entries(handlers)) {
    ipcMain.handle("runes:" + name, (event, ...args) => {
      // Only our own page, in its top frame, may call in.
      const frame = event.senderFrame;
      if (!frame || frame !== event.sender.mainFrame || !String(frame.url).startsWith(ORIGIN + "/")) throw new Error("Refused");
      return handle(...args);
    });
  }
  session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) => allow(permission === "clipboard-sanitized-write" || permission === "clipboard-read"));
  Menu.setApplicationMenu(null);

  // Only the editor's background is see-through, and a window can only be made able to show
  // what is behind it when it is created. So this is decided once, from the saved setting.
  window = new BrowserWindow({
    width: 1400, height: 880, minWidth: 720, minHeight: 420,
    title: "Runes", icon: path.join(dist, "logo.png"),
    backgroundColor: "#000000",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  // The window shows Runes and nothing else: no navigation, no new windows.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.loadURL(ORIGIN + "/");
});

app.on("window-all-closed", () => {
  unwatch();
  remote?.end();
  for (const term of terminals.values()) { try { term.kill(); } catch {} }
  host?.postMessage({ type: "stop" });
  setTimeout(() => app.quit(), 150);
});
