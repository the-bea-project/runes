// Tests for the SSH side, against a server made with the same library (e2e/sshd.cjs).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { utils } = require("ssh2");
const ssh = require("./ssh.cjs");
const git = require("./git.cjs");
const files = require("./files.cjs");
const sshd = require("../e2e/sshd.cjs");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runes-ssh-"));
const memory = () => { const seen = new Map(); return { get: (h) => seen.get(h), set: (h, f) => seen.set(h, f), seen }; };
/** Answers questions from a script, and remembers what was asked. */
const person = (answers) => {
  const asked = [];
  return {
    asked,
    secret: async (title) => { asked.push(title); return answers.length ? answers.shift() : null; },
    confirm: async (title, detail) => { asked.push(title + " " + detail); return answers.length ? answers.shift() : false; },
  };
};

test("sessions: checked, saved by name, and never hold a secret", () => {
  const file = path.join(temp(), "ssh.json");
  assert.deepEqual(ssh.load(file), []);
  const saved = ssh.save(file, { name: "  build box ", host: "10.0.0.7", user: "dev", port: "2222", folder: "~/work", password: "hunter2", key: "~/.ssh/id_work" });
  assert.deepEqual({ ...saved, id: "" }, { id: "", name: "build box", host: "10.0.0.7", user: "dev", port: 2222, key: "~/.ssh/id_work", folder: "~/work" });
  assert.ok(!fs.readFileSync(file, "utf8").includes("hunter2"));
  ssh.save(file, { ...saved, name: "renamed" });
  assert.deepEqual(ssh.load(file).map((s) => s.name), ["renamed"], "saving with the same id replaces");
  assert.equal(ssh.save(file, { host: "example.org", user: "ada" }).name, "ada@example.org");
  ssh.remove(file, saved.id);
  assert.deepEqual(ssh.load(file).map((s) => s.name), ["ada@example.org"]);
  // Nothing that could be read as an option to a command, or that is not a host at all.
  for (const bad of [{ host: "-oProxyCommand=x", user: "a" }, { host: "a b", user: "a" }, { host: "h", user: "" }, { host: "h", user: "-l" }, { host: "h", user: "a", folder: "work" }]) {
    assert.throws(() => ssh.session(bad));
  }
  assert.equal(ssh.quote("it's; rm -rf ~"), `'it'\\''s; rm -rf ~'`);
});

test("sessions: hosts are taken from an OpenSSH config", () => {
  const found = ssh.fromConfig(`
    # comment
    Host build  b
      HostName 10.1.2.3
      User dev
      Port 2200
      IdentityFile ~/.ssh/id_build
    Host *
      ServerAliveInterval 30
    Host plain
  `);
  assert.deepEqual(found.map((s) => [s.name, s.host, s.user, s.port, s.key]), [["build", "10.1.2.3", "dev", 2200, "~/.ssh/id_build"], ["plain", "plain", os.userInfo().username, 22, ""]]);
});

test("connecting: the key is shown once, a password is asked for, and a changed key is refused", async () => {
  const home = temp();
  const server = await sshd.start({ dev: { password: "s3cret" } }, home);
  const config = { name: "box", host: "127.0.0.1", port: server.port, user: "dev" };
  const known = memory();
  try {
    // First time: shown the fingerprint; declining connects to nothing and remembers nothing.
    const wary = person([false]);
    await assert.rejects(ssh.connect(config, wary, known, { agent: "" }), /was not accepted/);
    assert.ok(wary.asked[0].includes(ssh.fingerprint(server.hostKey())), "the real fingerprint is what is shown");
    assert.equal(known.seen.size, 0);

    // Accepting, then a wrong password, then the right one.
    const someone = person([true, "wrong", "s3cret"]);
    const remote = await ssh.connect(config, someone, known, { agent: "" });
    assert.deepEqual(someone.asked.slice(1), ["Password for dev@127.0.0.1", "Password for dev@127.0.0.1"]);
    assert.equal(known.get("127.0.0.1:" + server.port), ssh.fingerprint(server.hostKey()));
    remote.end();

    // Known now: no question about the key. Giving no password stops, without a third party being asked.
    const quiet = person([null]);
    await assert.rejects(ssh.connect(config, quiet, known, { agent: "" }), /no password was given/);
    assert.deepEqual(quiet.asked, ["Password for dev@127.0.0.1"]);
    await assert.rejects(ssh.connect(config, person(["a", "b", "c", "d"]), known, { agent: "" }), /Could not sign in/);

    // The machine's key changes: refused outright, the password never asked for, the old key kept.
    await server.rekey();
    const careful = person([true, "s3cret"]);
    await assert.rejects(ssh.connect(config, careful, known, { agent: "" }), /has changed since you first connected/);
    assert.deepEqual(careful.asked, []);
    assert.notEqual(known.get("127.0.0.1:" + server.port), ssh.fingerprint(server.hostKey()));
  } finally { await server.close(); }
});

test("connecting: a key file signs in, and one with a passphrase asks for it", async () => {
  const home = temp(), keys = temp();
  // The generator now and then makes a key its own parser will not read; those are thrown back.
  const pair = (options, passphrase) => { for (;;) { const made = utils.generateKeyPairSync("ed25519", options); if (!(utils.parseKey(made.private, passphrase) instanceof Error)) return made; } };
  const plain = pair(), locked = pair({ passphrase: "open sesame", cipher: "aes256-ctr" }, "open sesame");
  fs.writeFileSync(path.join(keys, "plain"), plain.private); fs.writeFileSync(path.join(keys, "locked"), locked.private);
  const server = await sshd.start({ ada: { key: plain.public }, bob: { key: locked.public, password: "fallback" } }, home);
  try {
    const nobody = person([true]);
    const one = await ssh.connect({ host: "127.0.0.1", port: server.port, user: "ada", key: path.join(keys, "plain") }, nobody, memory(), { agent: "" });
    assert.equal(nobody.asked.length, 1, "only the first-time question; no password");
    one.end();
    const someone = person([true, "wrong", "open sesame"]);
    const two = await ssh.connect({ host: "127.0.0.1", port: server.port, user: "bob", key: path.join(keys, "locked") }, someone, memory(), { agent: "" });
    assert.deepEqual(someone.asked.slice(1), ["Passphrase for locked", "Passphrase for locked"]);
    two.end();
    // Giving up on the passphrase falls back to the password.
    const other = person([true, null, "fallback"]);
    (await ssh.connect({ host: "127.0.0.1", port: server.port, user: "bob", key: path.join(keys, "locked") }, other, memory(), { agent: "" })).end();
    assert.deepEqual(other.asked.slice(1), ["Passphrase for locked", "Password for bob@127.0.0.1"]);
  } finally { await server.close(); }
});

test("a connected machine: files, search, git and a shell, with nothing installed there", async () => {
  const home = temp();
  const project = path.join(home, "it's a project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules/dep"), { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# Remote\n\nneedle here\n");
  fs.writeFileSync(path.join(project, "src/main.txt"), "one\nNeedle two\n");
  fs.writeFileSync(path.join(project, "node_modules/dep/index.js"), "needle\n");
  fs.writeFileSync(path.join(project, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(path.join(project, "src"), path.join(project, "link"));
  const run = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" }).toString();
  run("init", "-q", "-b", "main"); run("config", "user.name", "Ada"); run("config", "user.email", "ada@example.com");
  fs.writeFileSync(path.join(project, ".gitignore"), "node_modules\n"); run("add", "-A"); run("commit", "-qm", "first");

  const server = await sshd.start({ dev: { password: "pw" } }, home);
  const remote = await ssh.connect({ host: "127.0.0.1", port: server.port, user: "dev" }, person([true, "pw"]), memory(), { agent: "" });
  try {
    assert.equal(await remote.resolve(""), fs.realpathSync(home), "no folder given means the home folder");
    assert.equal(await remote.resolve("~/it's a project"), fs.realpathSync(project));
    assert.deepEqual((await remote.readDir(project)).sort(), [[".gitignore", false], ["README.md", false], ["link", true], ["node_modules", true], ["run.sh", false], ["src", true]]);
    assert.equal(await remote.readText(path.join(project, "README.md")), "# Remote\n\nneedle here\n");
    await assert.rejects(remote.readText(path.join(project, "missing.txt")), /There is no .*missing\.txt/);
    await assert.rejects(remote.readText(path.join(project, "src")), /is a folder/);

    // Saving replaces the file whole, keeps what it was allowed to do, and leaves nothing behind.
    await remote.writeText(path.join(project, "run.sh"), "#!/bin/sh\necho hi\n");
    assert.equal(fs.readFileSync(path.join(project, "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
    assert.equal(fs.statSync(path.join(project, "run.sh")).mode & 0o777, 0o755);
    await remote.writeText(path.join(project, "src/new file.txt"), "fresh\n");
    assert.deepEqual(fs.readdirSync(path.join(project, "src")).sort(), ["main.txt", "new file.txt"]);

    const all = (await remote.walk(project)).map((f) => path.relative(project, f)).sort();
    assert.deepEqual(all, [".gitignore", "README.md", "run.sh", "src/main.txt", "src/new file.txt"], "node_modules and .git are left out, a folder with a quote in its name is no trouble");
    // Searching reads only the files the machine says could match, and matches as it does locally.
    const hits = await files.search(project, "needle", {}, remote);
    assert.deepEqual(hits.map((h) => [path.relative(project, h[0]), h[1], h[2]]).sort(), [["README.md", 2, 0], ["src/main.txt", 1, 0]]);
    assert.deepEqual((await files.search(project, "needle", { matchCase: true }, remote)).length, 1);
    assert.deepEqual((await files.search(project, "^N\\w+", { regex: true, matchCase: true }, remote)).map((h) => h[4]), ["Needle two"]);
    const replaced = await files.replaceInFiles(project, "needle", {}, "thread", [], remote);
    assert.deepEqual(replaced, { files: 2, count: 2 });
    assert.equal(fs.readFileSync(path.join(project, "src/main.txt"), "utf8"), "one\nthread two\n");

    // Git runs over there, through the same code that runs it here.
    git.over(remote);
    const status = await git.status(project);
    assert.equal(status.branch, "main");
    assert.deepEqual(status.files.map((f) => f[0]).sort(), ["README.md", "run.sh", "src/main.txt", "src/new file.txt"]);
    await git.stage(project, ["src/new file.txt"]);
    await git.commit(project, "Add a file\n\nwith 'quotes' and $(nothing run)");
    assert.equal(run("log", "-1", "--format=%B").trim(), "Add a file\n\nwith 'quotes' and $(nothing run)");
    assert.equal(await git.file(project, "HEAD", "src/new file.txt"), "fresh\n");
    await assert.rejects(git.file(project, "HEAD", "../../etc/passwd"), /outside the folder/);
    git.over(null);

    // A shell, in the folder asked for.
    let printed = "";
    const shell = await remote.shell(project, 80, 24, (d) => { printed += d; }, () => { printed += "[ended]"; });
    shell.write("pwd; echo sum-$((40+2)); exit\n");
    for (let i = 0; i < 100 && !printed.includes("[ended]"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(printed.includes(fs.realpathSync(project)) && printed.includes("sum-42") && printed.includes("[ended]"), printed);
  } finally { git.over(null); remote.end(); await server.close(); }
});

test("a connection that drops says so", async () => {
  const home = temp();
  const server = await sshd.start({ dev: { password: "pw" } }, home);
  const remote = await ssh.connect({ host: "127.0.0.1", port: server.port, user: "dev" }, person([true, "pw"]), memory(), { agent: "" });
  let dropped = false;
  remote.onClose = () => { dropped = true; };
  await server.close();
  for (let i = 0; i < 60 && !dropped; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(dropped);
  await assert.rejects(ssh.connect({ host: "127.0.0.1", port: 1, user: "dev" }, person([]), memory(), { agent: "", timeout: 3000 }), /Could not connect to 127\.0\.0\.1:1/);
});
