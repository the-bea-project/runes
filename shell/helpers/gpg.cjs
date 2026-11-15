// Stands in for gpg when git signs a commit. It runs the real gpg exactly as git asked. If
// that works (the key has no passphrase, the agent remembers it, or the system shows its own
// window for it), that is all. If it fails while signing, the passphrase is asked for in Runes
// and gpg is run again with it handed over directly. The passphrase is never written to disk
// and never passed on a command line. See ../ask.cjs.
"use strict";
const { spawn } = require("node:child_process");
const { put } = require("../ask.cjs");

const real = process.env.RUNES_GPG || "gpg";
const args = process.argv.slice(2);

function run(extra, input, passphrase) {
  return new Promise((resolve) => {
    const child = spawn(real, [...extra, ...args], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, RUNES_GPG_WRAPPER: "" } });
    const out = [], err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => resolve({ code: 127, out: Buffer.alloc(0), err: Buffer.from(String(e.message) + "\n") }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(out), err: Buffer.concat(err) }));
    for (const pipe of [child.stdin, child.stdio[3]]) pipe.on("error", () => {});
    child.stdio[3].end(passphrase === undefined ? "" : passphrase + "\n");
    child.stdin.end(input);
  });
}

(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  let result = await run([], input);
  // Git signs with `-bsau <key>`; only a failed signing is worth a question.
  const signing = args.some((a) => /^-[a-z]*s[a-z]*$/.test(a) || a === "--sign" || a === "--detach-sign");
  const key = args[args.findIndex((a) => /^-[a-z]*u$/.test(a) || a === "--local-user") + 1] ?? "";
  for (let tries = 0; signing && result.code !== 0 && tries < 3; tries++) {
    const text = result.err.toString();
    if (/No secret key|skipped: |Unusable secret key|expired/i.test(text)) break;
    const passphrase = await put("secret", (tries ? "That passphrase did not open the key. " : "") + "Passphrase for the signing key" + (key ? " " + key : ""));
    if (passphrase === null) break;
    result = await run(["--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "3"], input, passphrase);
  }
  process.stdout.write(result.out, () => process.stderr.write(result.err, () => process.exit(result.code)));
})();
