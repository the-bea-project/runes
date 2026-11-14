// Runes as a desktop app: one window around dist/, and everything that window may ask the
// machine for. The window is sandboxed and loads nothing from the network; all it can do
// goes through the handlers below, and every one of them checks who is asking.
"use strict";
const { app, BrowserWindow, dialog, ipcMain, net, protocol, Menu, safeStorage, session, shell, utilityProcess } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { relaxed, unpack, manifestOf, identity } = require("./vsix.cjs");
const files = require("./files.cjs");
const update = require("./update.cjs");
const ai = require("./ai.cjs");
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

/** Every installed extension that brings code, unpacked and ready for the extension host. */
function codeExtensions() {
  const found = new Map();
  const sources = [];
  try { for (const n of JSON.parse(fsSync.readFileSync(path.join(dist, "extensions/index.json"), "utf8"))) sources.push(path.join(dist, "extensions", n)); } catch {}
  try { for (const n of fsSync.readdirSync(user("extensions"))) if (n.endsWith(".vsix")) sources.push(user("extensions", n)); } catch {}
  for (const source of sources) {
    try {
      const bytes = fsSync.readFileSync(source);
      const manifest = manifestOf(bytes);
      if (!manifest.main) continue;
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

function startHost() {
  host?.kill();
  host = utilityProcess.fork(path.join(__dirname, "exthost", "host.cjs"), [], { serviceName: "Runes Extension Host", stdio: "inherit" });
  const mine = host;
  mine.on("message", (m) => { if (host === mine && window && !window.isDestroyed()) window.webContents.send("runes:ext", m); });
  mine.on("exit", (code) => {
    if (host !== mine) return;
    host = null;
    if (code && window && !window.isDestroyed()) window.webContents.send("runes:ext", { type: "note", level: "error", text: "The extension host stopped unexpectedly. Reopen the folder to start it again." });
  });
  mine.postMessage({
    type: "init", root: folder, appRoot: path.join(__dirname, ".."), storage: user("extension-storage"),
    settings: readSettings(), extensions: codeExtensions(),
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
  gitCommit: (message) => git.commit(folder, message),
  gitFile: (at, name) => git.file(folder, text(at, 200), text(name)),
  gitChanged: (from, to) => git.changed(folder, text(from, 200), text(to, 200)),
  gitRefs: () => git.refs(folder),
  gitSwitch: (kind, name) => git.switchTo(folder, text(kind, 10), text(name, 200)),
  marketReadme: (namespace, name) => market.readme(text(namespace, 100), text(name, 100), (address, options) => net.fetch(address, options)),
  marketIcon: (url) => market.icon(text(url, 600), (address, options) => net.fetch(address, options)),

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
    remote = connected; remoteSession = session;
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

  aiSend: async (id, request) => {
    const provider = text(request?.provider, 40);
    let key = "";
    try { key = safeStorage.decryptString(await fs.readFile(user("keys", provider.replace(/\W/g, "") + ".key"))); } catch {}
    key ||= process.env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] ?? "";
    await ai.send({ provider, model: text(request.model ?? "", 200), baseUrl: text(request.baseUrl ?? "", 500), messages: Array.isArray(request.messages) ? request.messages : [] }, key, (kind, value) => {
      if (window && !window.isDestroyed()) window.webContents.send("runes:ai", id, kind, value);
    }, (url, options) => net.fetch(url, options));
  },
  aiSetKey: async (provider, key) => {
    // On Linux without a keyring Electron falls back to a fixed password, which protects nothing.
    const weak = process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text";
    if (!safeStorage.isEncryptionAvailable() || weak) throw new Error("This system has no keychain Runes can use, so the key was not stored. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment instead.");
    await fs.mkdir(user("keys"), { recursive: true, mode: 0o700 });
    await fs.writeFile(user("keys", text(provider, 40).replace(/\W/g, "") + ".key"), safeStorage.encryptString(text(key, 500)), { mode: 0o600 });
  },

  checkUpdate: () => (readSettings()["runes.update.check"] === false ? null : update.check(app.getVersion())),
  zoom: (by) => { const w = window.webContents; w.setZoomLevel(by === 0 ? 0 : Math.max(-3, Math.min(5, w.getZoomLevel() + (by > 0 ? 0.5 : -0.5)))); },
  devtools: () => window.webContents.toggleDevTools(),
  /** Only ever https, and only github.com: this is used for the update link. */
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
  openExternal: (url) => { if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\//.test(text(url, 500))) shell.openExternal(url); },
};


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
  remote?.end();
  for (const term of terminals.values()) { try { term.kill(); } catch {} }
  host?.postMessage({ type: "stop" });
  setTimeout(() => app.quit(), 150);
});
