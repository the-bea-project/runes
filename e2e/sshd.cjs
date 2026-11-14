// A small SSH server for the tests, made with the ssh2 library: password and public-key
// sign-in, commands, shells with a terminal, and SFTP over the real files of this machine.
// It is a stand-in for a real server, good enough to exercise Runes' side of the protocol;
// it is not OpenSSH, and nothing here is meant to face a network.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Server, utils } = require("ssh2");

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

function attrsOf(stat) {
  return { mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) };
}

function serveFiles(sftp) {
  const open = new Map();
  let ids = 0;
  const handle = (value) => { const h = Buffer.alloc(4); h.writeUInt32BE(++ids); open.set(ids, value); return h; };
  const of = (h) => open.get(h.readUInt32BE(0));
  const attempt = (id, work) => { try { work(); } catch (e) { sftp.status(id, e.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : e.code === "EACCES" || e.code === "EPERM" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, e.message); } };
  sftp.on("REALPATH", (id, file) => attempt(id, () => sftp.name(id, [{ filename: fs.realpathSync(path.resolve(process.env.SSHD_HOME ?? "/", file)), longname: "", attrs: {} }])));
  sftp.on("STAT", (id, file) => attempt(id, () => sftp.attrs(id, attrsOf(fs.statSync(file)))));
  sftp.on("LSTAT", (id, file) => attempt(id, () => sftp.attrs(id, attrsOf(fs.lstatSync(file)))));
  sftp.on("FSTAT", (id, h) => attempt(id, () => sftp.attrs(id, attrsOf(fs.fstatSync(of(h).fd)))));
  sftp.on("OPENDIR", (id, dir) => attempt(id, () => sftp.handle(id, handle({ dir, names: fs.readdirSync(dir), sent: false }))));
  sftp.on("READDIR", (id, h) => attempt(id, () => {
    const d = of(h);
    if (d.sent) return sftp.status(id, STATUS_CODE.EOF);
    d.sent = true;
    sftp.name(id, d.names.map((name) => ({ filename: name, longname: name, attrs: attrsOf(fs.lstatSync(path.join(d.dir, name))) })));
  }));
  sftp.on("OPEN", (id, file, flags, attrs) => attempt(id, () => {
    const mode = (flags & OPEN_MODE.WRITE) ? ((flags & OPEN_MODE.TRUNC) ? "w" : (flags & OPEN_MODE.APPEND) ? "a" : "r+") : "r";
    sftp.handle(id, handle({ fd: fs.openSync(file, mode, attrs?.mode ?? 0o644) }));
  }));
  sftp.on("READ", (id, h, offset, length) => attempt(id, () => {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(of(h).fd, buffer, 0, length, offset);
    if (read === 0) sftp.status(id, STATUS_CODE.EOF); else sftp.data(id, buffer.subarray(0, read));
  }));
  sftp.on("WRITE", (id, h, offset, data) => attempt(id, () => { fs.writeSync(of(h).fd, data, 0, data.length, offset); sftp.status(id, STATUS_CODE.OK); }));
  sftp.on("CLOSE", (id, h) => attempt(id, () => { const v = of(h); if (v?.fd !== undefined) fs.closeSync(v.fd); open.delete(h.readUInt32BE(0)); sftp.status(id, STATUS_CODE.OK); }));
  sftp.on("REMOVE", (id, file) => attempt(id, () => { fs.unlinkSync(file); sftp.status(id, STATUS_CODE.OK); }));
  sftp.on("RENAME", (id, from, to) => attempt(id, () => { if (fs.existsSync(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); fs.renameSync(from, to); sftp.status(id, STATUS_CODE.OK); }));
  for (const name of ["SETSTAT", "FSETSTAT"]) sftp.on(name, (id) => sftp.status(id, STATUS_CODE.OK));
  sftp.on("EXTENDED", (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED));
}

/**
 * Starts a server on a free local port. `accounts` is { user: { password?, key? (public key text) } }.
 * Resolves with { port, hostKey (public, as bytes), log (what was run), close(), rekey() }.
 */
/** A new host key. The generator now and then makes one its own parser will not read; those are thrown back. */
function freshKey() {
  for (;;) {
    const made = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(made.private) instanceof Error)) return made;
  }
}

function start(accounts, home) {
  let host = freshKey();
  const log = [];
  const sockets = new Set();
  const make = () => new Server({ hostKeys: [host.private] }, (client) => {
    let who = "";
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("authentication", (ctx) => {
      const account = accounts[ctx.username];
      if (!account || ctx.method === "none") return ctx.reject(["password", "publickey"]);
      if (ctx.method === "password") { log.push("password:" + ctx.username); return account.password !== undefined && ctx.password === account.password ? (who = ctx.username, ctx.accept()) : ctx.reject(["password", "publickey"]); }
      if (ctx.method === "publickey" && account.key) {
        const allowed = utils.parseKey(account.key);
        const same = ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0;
        if (same && (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) { if (ctx.signature) { who = ctx.username; log.push("key:" + ctx.username); } return ctx.accept(); }
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        let terminal = null;
        session.on("pty", (ok, _no, info) => { terminal = info; ok?.(); });
        session.on("sftp", (ok) => serveFiles(ok()));
        session.on("exec", (ok, _no, info) => {
          const stream = ok();
          log.push("exec:" + info.command);
          const env = { ...process.env, HOME: home, USER: who, SHELL: "/bin/sh" };
          if (terminal) {
            const pty = require("@lydell/node-pty").spawn("/bin/sh", ["-c", info.command], { name: terminal.term || "xterm", cols: terminal.cols, rows: terminal.rows, cwd: home, env });
            pty.onData((d) => stream.write(d));
            pty.onExit(({ exitCode }) => { stream.exit(exitCode); stream.end(); });
            stream.on("data", (d) => pty.write(d.toString("utf8")));
            session.on("window-change", (ok2, _no2, size) => { try { pty.resize(size.cols, size.rows); } catch {} ok2?.(); });
            stream.on("close", () => { try { pty.kill(); } catch {} });
          } else {
            const child = spawn("/bin/sh", ["-c", info.command], { cwd: home, env });
            child.stdout.on("data", (d) => stream.write(d));
            child.stderr.on("data", (d) => stream.stderr.write(d));
            stream.on("data", (d) => child.stdin.write(d));
            stream.on("end", () => child.stdin.end());
            child.on("close", (code) => { stream.exit(code ?? 1); stream.end(); });
          }
        });
      });
    });
    client.on("error", () => {});
  });
  let server = make();
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    process.env.SSHD_HOME = home;
    resolve({
      port, log,
      hostKey: () => utils.parseKey(host.public).getPublicSSH(),
      close: () => new Promise((done) => { for (const s of sockets) s.end(); server.close(() => done()); }),
      /** The machine gets a new key, as after a reinstall, or as an impostor would have. */
      rekey: () => new Promise((done) => {
        for (const s of sockets) s.end();
        server.close(() => {
          host = freshKey();
          server = make();
          server.listen(port, "127.0.0.1", () => done());
        });
      }),
    });
  }));
}

module.exports = { start };
