// Working on another machine over SSH.
//
// Nothing is installed on the other machine. Runes speaks plain SSH to it: SFTP for the
// files, a shell channel for terminals, and ordinary commands (`git`, `find`, `grep`) where
// the machine has them. That is less than VS Code's remote server does (language servers
// do not run over there) and it needs nothing set up, on any machine that takes SSH.
//
// No Electron in here, so it can be tested with plain Node.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const posix = path.posix;
const MAX_FILE = 8 * 1024 * 1024;
// A listing is kept for a minute, and trusted without a second look for two seconds.
const KEEP = 60 * 1000, SETTLED = 2000, AHEAD = 24;
const SKIP = [".git", "node_modules", ".beabuild", "build", "target", "dist", "out", ".venv", "__pycache__", ".next", ".cache"];

/** A word made safe to hand to the other machine's shell. */
const quote = (word) => "'" + String(word).replace(/'/g, "'\\''") + "'";

/** How people compare host keys: SHA256, base64, no padding. */
const fingerprint = (key) => "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

// --- Saved sessions ----------------------------------------------------------------------------

const AUTH = ["auto", "password", "key", "agent"];
const NAME = /^[^\x00-\x1f]{1,80}$/, HOST = /^[A-Za-z0-9._:-]{1,255}$/, USER = /^[A-Za-z0-9._@-]{1,64}$/;

/** Checks a session as the window describes it. Nothing secret is ever part of one. */
function session(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const out = {
    id: /^[a-z0-9]{6,24}$/.test(text(s.id)) ? text(s.id) : crypto.randomBytes(6).toString("hex"),
    name: text(s.name), host: text(s.host), user: text(s.user),
    port: Number.isInteger(Number(s.port)) && Number(s.port) > 0 && Number(s.port) < 65536 ? Number(s.port) : 22,
    key: text(s.key).slice(0, 1000), folder: text(s.folder).slice(0, 1000),
    // How to sign in: "auto" tries what there is, the others use that one way and nothing else.
    auth: AUTH.includes(text(s.auth)) ? text(s.auth) : "auto",
  };
  if (!HOST.test(out.host) || out.host.startsWith("-")) throw new Error("That is not a host name or address");
  if (!USER.test(out.user) || out.user.startsWith("-")) throw new Error("A user name is needed, of letters, digits, dots and dashes");
  if (!out.name) out.name = out.user + "@" + out.host;
  if (!NAME.test(out.name)) throw new Error("That name cannot be used");
  if (out.folder && !out.folder.startsWith("/") && !out.folder.startsWith("~")) throw new Error("The folder must be a full path on the other machine, or start with ~");
  return out;
}

function load(file) {
  try {
    const found = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(found) ? found.flatMap((s) => { try { return [session(s)]; } catch { return []; } }) : [];
  } catch { return []; }
}
function store(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".part", JSON.stringify(sessions, null, 2));
  fs.renameSync(file + ".part", file);
}
function save(file, raw) {
  const next = session(raw), all = load(file);
  const at = all.findIndex((s) => s.id === next.id);
  if (at >= 0) all[at] = next; else all.push(next);
  store(file, all);
  return next;
}
function remove(file, id) { store(file, load(file).filter((s) => s.id !== id)); }

/** The hosts in an OpenSSH config file, as sessions ready to save. Patterns (`Host *`) are skipped. */
function fromConfig(text) {
  const found = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = /^(\S+)[\s=]+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      current = null;
      const name = value.split(/\s+/).find((n) => !/[*?!]/.test(n));
      if (name) { current = { name, host: name, user: os.userInfo().username, port: 22, key: "", folder: "", auth: "auto" }; found.push(current); }
    } else if (current) {
      if (key === "hostname") current.host = value;
      else if (key === "user") current.user = value;
      else if (key === "port") current.port = Number(value) || 22;
      else if (key === "identityfile" && !current.key) current.key = value;
    }
  }
  return found.flatMap((s) => { try { return [session(s)]; } catch { return []; } });
}

// --- A connection ------------------------------------------------------------------------------

const home = (file) => (file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file);

/**
 * Connects, and resolves with a Remote. `ask` is how questions reach the person:
 *   ask.secret(title, detail) -> the text typed, or null to give up
 *   ask.confirm(title, detail) -> true or false
 * `known` is where host keys seen before are kept: { get(host), set(host, fingerprint) }.
 */
function connect(config, ask, known, options = {}) {
  const { Client, utils } = require("ssh2");
  const s = session(config);
  const where = s.host + ":" + s.port;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false, refusal = "";
    const fail = (error) => { if (!settled) { settled = true; try { conn.end(); } catch {} reject(error instanceof Error ? error : new Error(String(error))); } };

    // What to try, in order, each only if the other machine accepts that kind. A session
    // can ask for one way only ("password", "key", "agent"); left on "auto", an agent and
    // key files that need nothing typed go first, then a password.
    const mode = s.auth;
    const usual = ["id_ed25519", "id_ecdsa", "id_rsa"].map((n) => path.join(options.home ?? os.homedir(), ".ssh", n));
    const keys = (s.key ? [home(s.key)] : usual).filter((f) => fs.existsSync(f));
    if (mode === "key" && s.key && !keys.length) return reject(new Error("The key file " + s.key + " is not on this machine."));
    const agent = options.agent ?? process.env.SSH_AUTH_SOCK;
    const steps = [];
    if (agent && (mode === "auto" || mode === "agent")) steps.push({ kind: "publickey", make: async () => ({ type: "agent", username: s.user, agent }) });
    if (mode === "agent" && !agent) return reject(new Error("No SSH agent is running on this machine (SSH_AUTH_SOCK is not set)."));
    for (const file of mode === "auto" || mode === "key" ? keys : []) {
      let data;
      try { data = fs.readFileSync(file); } catch { continue; }
      const locked = utils.parseKey(data) instanceof Error;
      // One of the usual keys that needs a passphrase is not worth a question when the
      // machine would take a password anyway: nobody asked for that key by name.
      steps.push({ kind: "publickey", late: mode === "auto" && locked && !s.key, make: async () => {
        let passphrase;
        if (locked) {
          // An encrypted key: ask for its passphrase until one opens it, or the person gives up.
          for (let tries = 0; ; tries++) {
            passphrase = await ask.secret("Passphrase for " + path.basename(file), tries ? "That passphrase did not open the key. Try again." : "The key " + file + " is protected by a passphrase.");
            if (passphrase === null) return null;
            if (!(utils.parseKey(data, passphrase) instanceof Error)) break;
            if (tries >= 2) return null;
          }
        }
        return { type: "publickey", username: s.user, key: data, passphrase };
      } });
    }
    const typing = mode === "auto" || mode === "password";
    let passwords = 0;
    const password = { kind: "password", make: async () => {
      const typed = await ask.secret("Password for " + s.user + "@" + s.host, passwords++ ? "That password was not accepted. Try again." : "Runes does not keep it.");
      return typed === null ? null : { type: "password", username: s.user, password: typed };
    } };
    const interactive = { kind: "keyboard-interactive", make: async () => ({
      type: "keyboard-interactive", username: s.user,
      prompt: async (_name, instructions, _lang, prompts, finish) => {
        const answers = [];
        for (const p of prompts) {
          const typed = await ask.secret(p.prompt.replace(/:\s*$/, "") + " for " + s.user + "@" + s.host, instructions || "Runes does not keep it.");
          if (typed === null) return finish([]);
          answers.push(typed);
        }
        finish(answers);
      },
    }) };
    let first = true, asked = false, tried = 0;
    const WAYS = { password: "a password", key: "a key file", agent: "the SSH agent", auto: "any way of signing in Runes has" };

    conn.on("ready", () => {
      conn.sftp((error, sftp) => {
        if (error) return fail(new Error("Signed in, but the machine does not offer file transfer (SFTP): " + error.message));
        settled = true;
        resolve(new Remote(conn, sftp, s));
      });
    });
    conn.on("error", (error) => {
      fail(new Error(refusal || (error.level === "client-authentication" ? "Could not sign in to " + where + " as " + s.user + "." : "Could not connect to " + where + ": " + error.message)));
    });
    conn.on("close", () => fail(new Error(refusal || "The connection to " + where + " closed.")));

    conn.connect({
      host: s.host, port: s.port, username: s.user, readyTimeout: options.timeout ?? 20000, keepaliveInterval: 15000, keepaliveCountMax: 4,
      // The first time, the person is shown the machine's key and decides. After that the key
      // must be the one they accepted: a different one is refused, never asked about.
      hostVerifier: (key, verify) => {
        const seen = fingerprint(key), had = known.get(where);
        if (had === seen) return verify(true);
        if (had) {
          refusal = "The key of " + where + " has changed since you first connected (it is now " + seen + ").\nThat can mean someone is in between. Nothing was sent. If the machine really was reinstalled, forget its key in the SSH view and connect again.";
          return verify(false);
        }
        Promise.resolve(ask.confirm("Connect to " + where + " for the first time?", "Its key fingerprint is\n" + seen + "\n\nCheck it against the machine if you can. Runes will remember it and refuse a different one.")).then((yes) => {
          if (yes) known.set(where, seen); else refusal = "Not connected: the key of " + where + " was not accepted.";
          verify(!!yes);
        }, () => verify(false));
      },
      authHandler: (left, _partial, next) => {
        // Asking with no method first makes the machine say which ones it takes.
        if (first) { first = false; return next({ type: "none", username: s.user }); }
        const allowed = left ?? [];
        (async () => {
          for (;;) {
            const typed = typing && (allowed.includes("password") || allowed.includes("keyboard-interactive"));
            let step = steps.find((x) => allowed.includes(x.kind) && !(x.late && typed));
            if (step) steps.splice(steps.indexOf(step), 1);
            else if (typing && allowed.includes("password") && passwords < 3) step = password;
            else if (typing && allowed.includes("keyboard-interactive") && !asked) { asked = true; step = interactive; }
            if (!step) {
              if (!tried && mode !== "auto") refusal = where + " does not take " + WAYS[mode] + " for " + s.user + (allowed.length ? "; it takes " + allowed.join(", ") + "." : ".");
              return next(false);
            }
            tried++;
            let method = null;
            try { method = await step.make(); } catch {}
            if (method) return next(method);
            if (step === password) { refusal = "Not connected: no password was given."; return next(false); }
          }
        })();
      },
    });
  });
}

/** A machine that has been connected to: its files, its commands, its shells. */
class Remote {
  constructor(conn, sftp, config) {
    this.conn = conn; this.sftp = sftp; this.config = config;
    this.closed = false; this.onClose = () => {};
    this.tools = null;
    // Listings already fetched, by folder: { at, entries } and, while one is on its way, { pending }.
    this.lists = new Map();
    this.queue = []; this.busy = 0;
    this.onStale = () => {};
    conn.on("close", () => { if (!this.closed) { this.closed = true; this.onClose(); } });
  }
  end() { this.closed = true; try { this.conn.end(); } catch {} }

  call(method, ...args) {
    return new Promise((resolve, reject) => this.sftp[method](...args, (error, value) => (error ? reject(this.plain(error, args[0])) : resolve(value))));
  }
  plain(error, file) {
    const text = { 2: "There is no " + file + " on " + this.config.name, 3: "You may not open " + file + " on " + this.config.name }[error.code];
    return new Error(text ?? error.message);
  }

  /** Runs a command and resolves with what it printed; rejects, with what it complained of, if it failed. */
  exec(command, { limit = 64 * 1024 * 1024, input } = {}) {
    return new Promise((resolve, reject) => {
      this.conn.exec(command, (error, stream) => {
        if (error) return reject(error);
        const out = [], err = [];
        let size = 0;
        stream.on("data", (d) => { size += d.length; if (size <= limit) out.push(d); });
        stream.stderr.on("data", (d) => { if (err.length < 200) err.push(d); });
        stream.on("close", (code) => {
          const text = Buffer.concat(out).toString("utf8");
          if (code === 0) return resolve(text);
          const problem = new Error((Buffer.concat(err).toString("utf8").trim() || "The command failed") .slice(0, 2000));
          problem.code = code; problem.stdout = text;
          reject(problem);
        });
        if (input !== undefined) stream.end(input);
      });
    });
  }
  /** Which of the commands Runes can make use of the machine has. */
  async has(tool) {
    if (!this.tools) {
      try { this.tools = new Set((await this.exec("for t in git find grep; do command -v $t >/dev/null 2>&1 && echo $t; done")).split("\n").filter(Boolean)); }
      catch { this.tools = new Set(); }
    }
    return this.tools.has(tool);
  }

  async resolve(folder) {
    const asked = folder || ".";
    return this.call("realpath", asked.startsWith("~") ? "." + asked.slice(1) : asked);
  }
  async isDirectory(file) { try { return (await this.call("stat", file)).isDirectory(); } catch { return false; } }

  /** [[name, is it a folder]], links followed. Always asks the machine. */
  async list(dir) {
    const found = (await this.call("readdir", dir)).filter((e) => e.filename !== ".git" && e.filename !== "." && e.filename !== "..");
    return Promise.all(found.map(async (entry) => [entry.filename,
      entry.attrs.isSymbolicLink() ? await this.isDirectory(posix.join(dir, entry.filename)) : entry.attrs.isDirectory()]));
  }
  /**
   * A folder's listing, without the wait where that can be helped. Every round trip to the
   * other machine costs its distance, and a listing takes several, so:
   *  - a listing fetched in the last minute is answered at once, and checked again behind
   *    the scenes if it is more than a moment old (`onStale(dir)` says when it had changed);
   *  - whenever the person is shown a folder, the folders inside it are fetched too, a few at
   *    a time, so that opening any of them is already answered. Only that one level, only
   *    folders worth opening, and never more than a couple of dozen.
   * `ahead: false` is how the read-ahead itself asks, so it goes no deeper.
   */
  readDir(dir, { ahead = true, fresh = false } = {}) {
    const had = this.lists.get(dir), now = Date.now();
    const then = (entries) => { if (ahead) this.ahead(dir, entries); return entries; };
    if (!fresh && had?.entries && now - had.at < KEEP) {
      if (ahead && now - had.at > SETTLED && !had.pending) this.refresh(dir, had.entries);
      return Promise.resolve(then(had.entries));
    }
    if (had?.pending) return had.pending.then(then);
    const pending = this.list(dir).then((entries) => {
      this.lists.set(dir, { at: Date.now(), entries });
      if (this.lists.size > 600) this.lists.delete(this.lists.keys().next().value);
      return entries;
    }, (error) => { this.lists.delete(dir); throw error; });
    this.lists.set(dir, { ...had, pending });
    return pending.then(then);
  }
  /** Fetches a kept listing again and says so if it is no longer true. */
  refresh(dir, before) {
    const pending = this.list(dir).then((entries) => {
      this.lists.set(dir, { at: Date.now(), entries });
      if (JSON.stringify([...entries].sort()) !== JSON.stringify([...before].sort())) this.onStale(dir);
      return entries;
    }, () => { this.lists.delete(dir); this.onStale(dir); return before; });
    this.lists.set(dir, { at: Date.now(), entries: before, pending });
  }
  ahead(dir, entries) {
    const wanted = entries.filter(([name, folder]) => folder && !SKIP.includes(name)).slice(0, AHEAD).map(([name]) => posix.join(dir, name));
    for (const next of wanted) if (!this.lists.has(next) && !this.queue.includes(next)) this.queue.push(next);
    this.drain();
  }
  drain() {
    while (this.busy < 4 && this.queue.length && !this.closed) {
      const dir = this.queue.shift();
      if (this.lists.has(dir)) continue;
      this.busy++;
      this.readDir(dir, { ahead: false }).catch(() => {}).then(() => { this.busy--; this.drain(); });
    }
  }
  /** Drops what is kept about a folder (and, for a folder that went away, everything under it). */
  forget(dir, under = false) {
    this.lists.delete(dir);
    if (under) for (const key of [...this.lists.keys()]) if (key.startsWith(dir + "/")) this.lists.delete(key);
  }
  /** When each folder last had something added or taken away: [[dir, seconds]], or -1 for one that is gone. */
  times(dirs) {
    return Promise.all(dirs.map((dir) => this.call("stat", dir).then((stat) => [dir, stat.mtime], () => [dir, -1])));
  }

  // --- Changing what is there ---
  async exists(file) { try { await this.call("lstat", file); return true; } catch { return false; } }
  /** A new empty file or folder. The folders above it are made if they are missing; nothing is ever overwritten. */
  async create(file, folder) {
    if (await this.exists(file)) throw new Error(posix.basename(file) + " already exists");
    const above = [];
    for (let dir = posix.dirname(file); dir !== "/" && !(await this.exists(dir)); dir = posix.dirname(dir)) above.unshift(dir);
    for (const dir of above) await this.call("mkdir", dir);
    if (folder) await this.call("mkdir", file);
    else await this.call("close", await this.call("open", file, "wx"));
    this.forget(posix.dirname(above[0] ?? file));
  }
  async rename(from, to) {
    if (await this.exists(to)) throw new Error(posix.basename(to) + " already exists");
    await this.call("rename", from, to);
    this.forget(from, true); this.forget(posix.dirname(from)); this.forget(posix.dirname(to));
  }
  /** Removes a file, or a folder and all in it. There is no trash on the other machine: this is for good. */
  async remove(file) {
    const stat = await this.call("lstat", file);
    if (!stat.isDirectory()) await this.call("unlink", file);
    else {
      try { await this.exec("rm -rf -- " + quote(file)); }
      catch {
        // No shell to ask, or it would not: take the folder apart over SFTP.
        const empty = async (dir) => {
          for (const entry of await this.call("readdir", dir)) {
            if (entry.filename === "." || entry.filename === "..") continue;
            const full = posix.join(dir, entry.filename);
            if (entry.attrs.isDirectory()) await empty(full); else await this.call("unlink", full);
          }
          await this.call("rmdir", dir);
        };
        await empty(file);
      }
    }
    this.forget(file, true); this.forget(posix.dirname(file));
  }

  async readText(file) {
    const stat = await this.call("stat", file);
    if (stat.isDirectory()) throw new Error(posix.basename(file) + " is a folder");
    if (stat.size > MAX_FILE) throw new Error("This file is larger than 8 MB; Runes does not open it yet");
    const data = await this.call("readFile", file);
    if (data.subarray(0, 8000).includes(0)) throw new Error(posix.basename(file) + " is not a text file");
    return data.toString("utf8");
  }
  /**
   * Saves a file. Where the machine can swap a file for another in one step (OpenSSH can),
   * the text is written beside the real file and swapped in, so a dropped connection cannot
   * leave half a file. Elsewhere it is written straight into the file: the file is never
   * missing, even for a moment.
   */
  async writeText(file, content) {
    this.forget(posix.dirname(file));
    let mode;
    try { mode = (await this.call("stat", file)).mode & 0o7777; } catch {}
    const part = posix.join(posix.dirname(file), "." + posix.basename(file) + ".runes-part");
    if (this.swaps !== false) {
      try {
        await this.call("writeFile", part, content, mode === undefined ? {} : { mode });
        await this.call("ext_openssh_rename", part, file);
        this.swaps = true;
        return;
      } catch {
        if (this.swaps !== true) this.swaps = false;
        await this.call("unlink", part).catch(() => {});
      }
    }
    await this.call("writeFile", file, content);
  }

  /** Every file under a folder, leaving out what is never worth searching. */
  async walk(root, limit = 20000) {
    if (await this.has("find")) {
      const prune = SKIP.map((n) => "-name " + quote(n)).join(" -o ");
      try {
        const out = await this.exec(`find ${quote(root)} \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${limit}`);
        return out.split("\n").filter(Boolean);
      } catch (e) { if (e.stdout) return e.stdout.split("\n").filter(Boolean); }
    }
    const found = [];
    const visit = async (dir, depth) => {
      if (found.length >= limit || depth > 10) return;
      let entries = [];
      try { entries = await this.readDir(dir); } catch { return; }
      for (const [name, folder] of entries) {
        if (folder) { if (!SKIP.includes(name)) await visit(posix.join(dir, name), depth + 1); }
        else found.push(posix.join(dir, name));
      }
    };
    await visit(root, 0);
    return found;
  }
  /** The files that might hold a match, found on the machine itself so only those are fetched. null: not known. */
  async candidates(root, query, options) {
    if (options?.regex || /[\n\r]/.test(query) || !(await this.has("grep"))) return null;
    const flags = "-rlIF" + (options?.matchCase ? "" : "i");
    try {
      return (await this.exec(`grep ${flags} ${SKIP.map((n) => "--exclude-dir=" + quote(n)).join(" ")} -e ${quote(query)} ${quote(root)} 2>/dev/null | head -n 5000`)).split("\n").filter(Boolean);
    } catch (e) { return e.code === 1 ? (e.stdout ?? "").split("\n").filter(Boolean) : null; }
  }

  /** Runs git in a folder on the machine. */
  git(root, args, input) {
    const command = `cd ${quote(root)} && GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C git -c core.quotepath=off -c color.ui=false ${args.map(quote).join(" ")}`;
    return this.exec(command, { input: input ?? "" }).catch((e) => { throw new Error(e.message.split("\n")[0]); });
  }

  /** An interactive shell in a folder. Resolves with { write, resize, kill } and calls back with what it prints. */
  shell(folder, cols, rows, onData, onExit) {
    return new Promise((resolve, reject) => {
      const start = `cd ${quote(folder)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`;
      this.conn.exec(start, { pty: { term: "xterm-256color", cols, rows } }, (error, stream) => {
        if (error) return reject(error);
        stream.on("data", (d) => onData(d.toString("utf8")));
        stream.stderr.on("data", (d) => onData(d.toString("utf8")));
        stream.on("close", () => onExit());
        resolve({
          write: (data) => stream.write(data),
          resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch {} },
          kill: () => { try { stream.close(); } catch {} },
        });
      });
    });
  }
}

module.exports = { connect, Remote, session, load, save, remove, fromConfig, fingerprint, quote };
