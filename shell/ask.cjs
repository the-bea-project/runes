// Git, ssh and gpg sometimes need something only the person knows: the passphrase of a signing
// key, the password of a remote. They cannot ask in a terminal here, because there is none, so
// they are given small helper programs (in helpers/) that pass the question to Runes over a
// private socket, and Runes asks it in the window. No Electron in here.
//
// The socket lives in a folder only this user can enter, and every question must carry a token
// made afresh each time Runes starts; without it nothing is asked and nothing is answered.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

/** What kind of question some words from git, ssh or gpg are: "confirm", "secret" or "text". */
function kindOf(prompt) {
  if (/\(yes\/no(\/\[fingerprint\])?\)/i.test(prompt)) return "confirm";
  if (/pass(word|phrase)|\bPIN\b|token|secret/i.test(prompt)) return "secret";
  return "text";
}

/**
 * Starts listening. `ask(kind, prompt)` resolves to the answer: a string, or for "confirm" a
 * boolean; null when the person gives up. `runtime` is the program that runs the helpers
 * (Electron itself, as Node) and `scripts` the folder to write the launchers into.
 * Resolves to { env, close }: `env` is what a git on this machine is run with.
 */
async function serve(ask, { runtime = process.execPath, scripts, helpers = path.join(__dirname, "helpers") } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const windows = process.platform === "win32";
  let home = null;
  const address = windows ? `\\\\.\\pipe\\runes-ask-${crypto.randomBytes(8).toString("hex")}`
    : path.join((home = fs.mkdtempSync(path.join(os.tmpdir(), "runes-ask-"))), "s");
  if (home) fs.chmodSync(home, 0o700);

  const server = net.createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) return socket.destroy();
      const end = text.indexOf("\n");
      if (end === -1) return;
      let request;
      try { request = JSON.parse(text.slice(0, end)); } catch { return socket.destroy(); }
      text = "";
      const given = Buffer.from(String(request?.token ?? ""));
      if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) return socket.destroy();
      const prompt = String(request.prompt ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 2000);
      const kind = ["confirm", "secret", "text"].includes(request.kind) ? request.kind : kindOf(prompt);
      let answer = null;
      try { answer = await ask(kind, prompt); } catch {}
      if (kind === "confirm") answer = answer ? "yes" : "no";
      socket.end(JSON.stringify({ answer: typeof answer === "string" ? answer : null }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  server.unref();

  // The launchers: git wants the name of one program, so each helper gets a tiny script that
  // starts the runtime as Node on it. Written where they can be executed (not inside an archive).
  fs.mkdirSync(scripts, { recursive: true, mode: 0o700 });
  const launcher = (name) => {
    const helper = path.join(helpers, name + ".cjs").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    const sh = path.join(scripts, name + ".sh");
    const quoted = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoted(runtime)} ${quoted(helper)} "$@"\n`, { mode: 0o700 });
    if (!windows) return sh;
    const cmd = path.join(scripts, name + ".cmd");
    fs.writeFileSync(cmd, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runtime}" "${helper}" %*\r\n`);
    return cmd;
  };
  const askpass = launcher("askpass");
  const env = {
    RUNES_ASK_SOCKET: address, RUNES_ASK_TOKEN: token,
    // Git for Windows runs GIT_ASKPASS through its own sh; ssh there wants a program.
    GIT_ASKPASS: windows ? path.join(scripts, "askpass.sh").replace(/\\/g, "/") : askpass,
    SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force",
    // Older ssh only uses an askpass program when it believes there is a display.
    ...(windows || process.env.DISPLAY ? {} : { DISPLAY: ":0" }),
    RUNES_GPG_WRAPPER: launcher("gpg"),
  };
  return { env, close: () => { server.close(); if (home) fs.rmSync(home, { recursive: true, force: true }); } };
}

/** For the helpers: ask Runes one question. Resolves to the answer, or null. */
function put(kind, prompt, env = process.env) {
  return new Promise((resolve) => {
    if (!env.RUNES_ASK_SOCKET || !env.RUNES_ASK_TOKEN) return resolve(null);
    const socket = net.connect(env.RUNES_ASK_SOCKET);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ token: env.RUNES_ASK_TOKEN, kind, prompt }) + "\n"));
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("error", () => resolve(null));
    socket.on("close", () => { try { resolve(JSON.parse(text).answer ?? null); } catch { resolve(null); } });
  });
}

module.exports = { serve, put, kindOf };
