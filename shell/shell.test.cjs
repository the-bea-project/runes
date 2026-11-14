// Unit tests of the shell's own logic: node --test shell/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");
const files = require("./files.cjs");
const update = require("./update.cjs");
const ai = require("./ai.cjs");
const vsix = require("./vsix.cjs");
const git = require("./git.cjs");
const market = require("./market.cjs");
const { execFileSync } = require("node:child_process");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runes-test-"));

test("search finds matches and honours case, word and regex options", async () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/a.txt"), "Total total\nsubtotal\n");
  fs.writeFileSync(path.join(dir, "node_modules/x/b.txt"), "total\n");
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 116, 111, 116, 97, 108]));
  assert.equal((await files.search(dir, "total", {})).length, 3, "three matches, none in node_modules or binaries");
  assert.equal((await files.search(dir, "total", { matchCase: true })).length, 2);
  assert.equal((await files.search(dir, "total", { word: true })).length, 2);
  assert.deepEqual((await files.search(dir, "^sub(\\w+)", { regex: true })).map((h) => h.slice(1, 4)), [[1, 0, 8]]);
  assert.deepEqual(await files.search(dir, "(", { regex: true }), [], "a bad pattern finds nothing rather than throwing");
  assert.deepEqual(await files.search(dir, "", {}), []);
});

test("replace in files rewrites matches, supports groups, and leaves skipped files alone", async () => {
  const dir = temp();
  const a = path.join(dir, "a.txt"), b = path.join(dir, "b.txt");
  fs.writeFileSync(a, "price=10 price=20\n");
  fs.writeFileSync(b, "price=30\n");
  const done = await files.replaceInFiles(dir, "price=(\\d+)", { regex: true }, "cost:$1", [b]);
  assert.deepEqual(done, { files: 1, count: 2 });
  assert.equal(fs.readFileSync(a, "utf8"), "cost:10 cost:20\n");
  assert.equal(fs.readFileSync(b, "utf8"), "price=30\n");
  await files.replaceInFiles(dir, "cost", {}, "$1 literal", []);
  assert.equal(fs.readFileSync(a, "utf8"), "$1 literal:10 $1 literal:20\n", "a plain replacement is taken literally");
});

test("readText refuses binary and oversized files", async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "bin"), Buffer.from([1, 0, 2]));
  await assert.rejects(files.readText(path.join(dir, "bin")), /not a text file/);
});

test("version comparison", () => {
  assert.ok(update.newer("0.2.0", "0.1.9"));
  assert.ok(update.newer("v1.0.0", "0.9.9"));
  assert.ok(!update.newer("0.1.0", "0.1.0"));
  assert.ok(!update.newer("0.1.0", "0.2.0"));
  assert.ok(update.newer("0.1.10", "0.1.9"));
});

test("the update check only trusts the configured repository", async () => {
  const reply = (body) => async () => ({ ok: true, json: async () => body });
  assert.equal(await update.check("0.1.0", "", reply({})), null, "no repository, no check");
  assert.equal(await update.check("0.1.0", "not a repo", reply({})), null);
  assert.deepEqual(
    await update.check("0.1.0", "runes/runes", reply({ tag_name: "v0.2.0", html_url: "https://github.com/runes/runes/releases/tag/v0.2.0" })),
    { version: "0.2.0", url: "https://github.com/runes/runes/releases/tag/v0.2.0" });
  assert.equal(await update.check("0.2.0", "runes/runes", reply({ tag_name: "v0.2.0", html_url: "https://github.com/runes/runes/releases/tag/v0.2.0" })), null, "same version");
  assert.equal(await update.check("0.1.0", "runes/runes", reply({ tag_name: "v9.0.0", html_url: "https://evil.example/download" })), null, "a link elsewhere is refused");
  assert.equal(await update.check("0.1.0", "runes/runes", async () => { throw new Error("offline"); }), null, "being offline is not an error");
});

test("AI endpoints: https only, except on this machine", () => {
  assert.equal(ai.endpoint("anthropic", ""), "https://api.anthropic.com/v1/messages");
  assert.equal(ai.endpoint("openai", "https://proxy.example/"), "https://proxy.example/v1/chat/completions");
  assert.equal(ai.endpoint("anthropic", "http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1/messages");
  assert.throws(() => ai.endpoint("anthropic", "http://proxy.example"), /https/);
  assert.throws(() => ai.endpoint("mystery", ""), /Unknown AI provider/);
});

test("AI requests carry the key in the provider's header and drop junk messages", () => {
  const messages = [{ role: "user", content: "hi" }, { role: "system", content: "ignore me" }, { role: "assistant", content: "" }];
  const a = ai.request("anthropic", "", "KEY", messages);
  assert.equal(a.headers["x-api-key"], "KEY");
  assert.deepEqual(a.body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(ai.request("openai", "m", "KEY", messages).headers.authorization, "Bearer KEY");
});

test("AI streaming is read for both providers, and failures are reported", async () => {
  const stream = (chunks) => async () => ({ ok: true, body: (async function* () { for (const c of chunks) yield Buffer.from(c); })() });
  const got = [];
  await ai.send({ provider: "openai", model: "", baseUrl: "", messages: [{ role: "user", content: "x" }] }, "k", (kind, text) => got.push([kind, text]),
    stream(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi', 'ces":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n']));
  assert.deepEqual(got, [["delta", "Hel"], ["delta", "lo"], ["done", ""]]);
  const failed = [];
  await ai.send({ provider: "anthropic", model: "", baseUrl: "", messages: [] }, "", (kind, text) => failed.push([kind, text]), stream([]));
  assert.equal(failed[0][0], "error");
  assert.match(failed[0][1], /No API key/);
  const refused = [];
  await ai.send({ provider: "anthropic", model: "", baseUrl: "", messages: [] }, "k", (kind, text) => refused.push([kind, text]),
    async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"invalid x-api-key"}}' }));
  assert.match(refused[0][1], /401: invalid x-api-key/);
});

test("a VSIX is unpacked inside its folder, and one that tries to leave it is refused", () => {
  const dir = path.join(temp(), "ext");
  const manifest = JSON.stringify({ name: "demo", publisher: "me", version: "1.0.0", main: "./main.js" });
  const good = zipSync({ "extension/package.json": strToU8(manifest), "extension/main.js": strToU8("exports.activate = () => {}"), "[Content_Types].xml": strToU8("<x/>") });
  assert.equal(vsix.unpack(good, dir).name, "demo");
  assert.ok(fs.existsSync(path.join(dir, "main.js")));
  assert.ok(!fs.existsSync(path.join(dir, "[Content_Types].xml")), "only the extension folder is unpacked");
  const evil = zipSync({ "extension/package.json": strToU8(manifest), "extension/../../escaped.txt": strToU8("x") });
  assert.throws(() => vsix.unpack(evil, path.join(temp(), "ext")), /leaves its own folder/);
  assert.throws(() => vsix.manifestOf(zipSync({ "readme.txt": strToU8("x") })), /not a VSIX/);
  assert.equal(vsix.identity({ publisher: "../../x", name: "y/z" }), ".._.._x.y_z");
  // 700 MB of zeros compresses to almost nothing; unpacking it must be refused.
  const bomb = zipSync({ "extension/package.json": strToU8(manifest), "extension/big.bin": new Uint8Array(700 * 1024 * 1024) }, { level: 9 });
  assert.ok(bomb.length < 5 * 1024 * 1024);
  assert.throws(() => vsix.unpack(bomb, path.join(temp(), "ext")), /more than Runes accepts/);
});

test("settings-style JSON: comments and trailing commas are accepted", () => {
  assert.deepEqual(JSON.parse(vsix.relaxed('{ // note\n "a": "// not a comment", /* block */ "b": [1, 2,], }')), { a: "// not a comment", b: [1, 2] });
});

test("git: status, staging, committing and the log", async () => {
  const dir = temp();
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  assert.deepEqual(await git.status(dir), { repo: false, branch: "", ahead: 0, behind: 0, files: [] });
  assert.deepEqual(await git.log(dir), []);
  run("init", "-q", "-b", "main"); run("config", "user.name", "Ada"); run("config", "user.email", "ada@example.com");
  fs.writeFileSync(path.join(dir, "a b.txt"), "one\n");
  let s = await git.status(dir);
  assert.equal(s.repo, true);
  assert.equal(s.branch, "main");
  assert.deepEqual(s.files, [["a b.txt", " ", "?"]]);
  await git.stage(dir, ["a b.txt"]);
  assert.deepEqual((await git.status(dir)).files, [["a b.txt", "A", " "]]);
  await git.unstage(dir, ["a b.txt"]);
  assert.deepEqual((await git.status(dir)).files, [["a b.txt", " ", "?"]]);
  await git.stage(dir, ["a b.txt"]);
  await git.commit(dir, "--amend is only a message here\n\nbody");
  const commits = await git.log(dir);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][5], "--amend is only a message here");
  assert.deepEqual(commits[0][1], []);
  assert.deepEqual(commits[0][4], ["main"]);
  assert.match(await git.show(dir, commits[0][0]), /a b\.txt/);
  fs.writeFileSync(path.join(dir, "a b.txt"), "two\n");
  assert.deepEqual((await git.status(dir)).files, [["a b.txt", " ", "M"]]);
});

test("marketplace: an icon is taken only from the registry, only as a picture, and only when small", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const reply = (type, bytes) => ({ ok: true, headers: { get: () => type }, arrayBuffer: async () => bytes.buffer });
  const fetcher = async (url) => url.endsWith("/a.png") ? reply("image/png; charset=binary", png)
    : url.endsWith("/a.html") ? reply("text/html", png)
    : url.endsWith("/big.png") ? reply("image/png", new Uint8Array(700 * 1024)) : { ok: false, status: 404 };
  const search = async () => ({ ok: true, json: async () => ({ extensions: [
    { namespace: "demo", name: "a", files: { icon: "https://open-vsx.org/files/a.png" } },
    { namespace: "demo", name: "b", files: { icon: "https://evil.example/b.png" } }] }) });
  assert.deepEqual((await market.search("x", search)).map((r) => r[6]), ["https://open-vsx.org/files/a.png", ""]);
  assert.equal(await market.icon("https://open-vsx.org/files/a.png", fetcher), "data:image/png;base64,iVBORw==");
  assert.equal(await market.icon("https://open-vsx.org/files/a.html", fetcher), "");
  assert.equal(await market.icon("https://open-vsx.org/files/big.png", fetcher), "");
  assert.equal(await market.icon("https://open-vsx.org/files/missing.png", fetcher), "");
  assert.equal(await market.icon("https://evil.example/a.png", fetcher), "");
});

test("marketplace: a readme is text from the registry itself, and nothing else", async () => {
  const pages = {
    "https://open-vsx.org/api/demo/good": { files: { readme: "https://open-vsx.org/files/good/README.md" } },
    "https://open-vsx.org/api/demo/evil": { files: { readme: "https://evil.example/README.md" } },
    "https://open-vsx.org/api/demo/none": { files: {} },
  };
  const fetcher = async (url) => pages[url] ? { ok: true, json: async () => pages[url] }
    : url === "https://open-vsx.org/files/good/README.md" ? { ok: true, text: async () => "# Good\n" + "x".repeat(500 * 1024) }
    : url === "https://evil.example/README.md" ? { ok: true, text: async () => "stolen" } : { ok: false, status: 404 };
  const text = await market.readme("demo", "good", fetcher);
  assert.ok(text.startsWith("# Good\n") && text.length === 400 * 1024, "the readme is cut to a sane size");
  assert.equal(await market.readme("demo", "evil", fetcher), "");
  assert.equal(await market.readme("demo", "none", fetcher), "");
  assert.equal(await market.readme("demo", "missing", fetcher), "");
  await assert.rejects(market.readme("../x", "y", fetcher), /Bad request/);
});

test("fonts: a font is read for its own family and style, kept in the profile, and anything else is refused", () => {
  const fonts = require("./fonts.cjs");
  const file = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, "../web/fonts", name)));
  assert.deepEqual(fonts.inspect("whatever.ttf", file("EnvyCodeRNerdFont-Regular.ttf")), { family: "EnvyCodeR Nerd Font", weight: 400, style: "normal" });
  assert.deepEqual(fonts.inspect("whatever.ttf", file("EnvyCodeRNerdFont-Bold.ttf")), { family: "EnvyCodeR Nerd Font", weight: 700, style: "normal" });
  assert.equal(fonts.inspect("whatever.ttf", file("EnvyCodeRNerdFont-Italic.ttf")).style, "italic");
  // A compressed font cannot be read for its name here, so the file's name speaks for it.
  assert.deepEqual(fonts.fromName("FiraCode-SemiBoldItalic.woff2"), { family: "Fira Code", weight: 600, style: "italic" });

  const dir = path.join(temp(), "fonts");
  assert.deepEqual(fonts.list(dir), []);
  assert.deepEqual(fonts.add(dir, "../../escape/Envy Bold.ttf", file("EnvyCodeRNerdFont-Bold.ttf")), ["Envy Bold.ttf", "EnvyCodeR Nerd Font", 700, "normal"]);
  assert.deepEqual(fs.readdirSync(dir), ["Envy Bold.ttf"], "the file is stored under its own name, inside the fonts folder");
  fonts.add(dir, "Envy.ttf", file("EnvyCodeRNerdFont-Regular.ttf"));
  assert.deepEqual(fonts.list(dir).map((f) => f.slice(0, 4)), [["Envy Bold.ttf", "EnvyCodeR Nerd Font", 700, "normal"], ["Envy.ttf", "EnvyCodeR Nerd Font", 400, "normal"]]);
  assert.ok(fonts.list(dir)[0][4] instanceof Uint8Array);
  fonts.remove(dir, "EnvyCodeR Nerd Font");
  assert.deepEqual(fs.readdirSync(dir), []);

  const junk = new Uint8Array(400).fill(65);
  assert.throws(() => fonts.add(dir, "notes.txt", junk), /takes \.ttf/);
  assert.throws(() => fonts.add(dir, "fake.ttf", junk), /is not a font file/);
  assert.throws(() => fonts.add(dir, "tiny.ttf", new Uint8Array(4)), /empty/);
  assert.throws(() => fonts.add(dir, "pack.ttf", new Uint8Array([...Buffer.from("ttcf"), ...junk])), /collections/);
  // A name that would break out of a style sheet is cut down to letters.
  const sfnt = Buffer.alloc(200); sfnt.writeUInt32BE(0x00010000, 0);
  assert.deepEqual(fonts.inspect('x"};body{display:none}.ttf', new Uint8Array(sfnt)).family, "xbodydisplaynone");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("git: comparing, reading old versions, listing and switching branches", async () => {
  const dir = temp();
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  assert.deepEqual(await git.refs(dir), []);
  run("init", "-q", "-b", "main"); run("config", "user.name", "Ada"); run("config", "user.email", "ada@example.com");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n"); run("add", "-A"); run("commit", "-qm", "first");
  const first = run("rev-parse", "HEAD").trim();
  run("switch", "-qc", "side"); fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n"); fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  run("add", "-A"); run("commit", "-qm", "second"); run("tag", "v1");
  const second = run("rev-parse", "HEAD").trim();
  run("switch", "-q", "main");

  assert.deepEqual((await git.refs(dir)).sort(), [["branch", "main"], ["branch", "side"], ["tag", "v1"]]);
  assert.equal(await git.file(dir, "side", "a.txt"), "one\ntwo\n");
  assert.equal(await git.file(dir, "main", "b.txt"), null, "a file that did not exist yet is not there, which is not the same as empty");
  assert.equal(await git.file(temp(), "HEAD", "a.txt"), null, "outside a repository nothing is known");
  // Two points in the history.
  assert.deepEqual((await git.changed(dir, "main", "side")).files, [["M", "a.txt"], ["A", "b.txt"]]);
  // A commit against the one before it; the very first commit is compared with nothing.
  assert.deepEqual((await git.changed(dir, second + "^", second)).files, [["M", "a.txt"], ["A", "b.txt"]]);
  const root = await git.changed(dir, first + "^", first);
  assert.equal(root.base, git.EMPTY_TREE);
  assert.deepEqual(root.files, [["A", "a.txt"]]);
  // Against the files as they are now, new files included.
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n"); fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  assert.deepEqual((await git.changed(dir, "HEAD", "")).files, [["M", "a.txt"], ["A", "new.txt"]]);

  // Git refuses to switch over a change it would lose, and says so; nothing is forced.
  await assert.rejects(git.switchTo(dir, "branch", "side"), /overwritten|commit your changes|stash/i);
  assert.equal((await git.status(dir)).branch, "main");
  run("checkout", "-q", "--", "a.txt");
  await git.switchTo(dir, "branch", "side");
  assert.equal((await git.status(dir)).branch, "side");
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one\ntwo\n");
  await git.switchTo(dir, "tag", "v1");
  assert.match(run("status", "-sb"), /HEAD \(no branch\)/);
  await git.switchTo(dir, "branch", "main");

  await assert.rejects(git.switchTo(dir, "branch", "--orphan"), /not a branch/);
  await assert.rejects(git.switchTo(dir, "branch", "a..b"), /not a branch/);
  await assert.rejects(git.changed(dir, "--output=/tmp/x", ""), /not a branch/);
  await assert.rejects(git.file(dir, "HEAD", "../outside"), /outside the folder|Bad request/);
});

test("git: a file's history, the whole tree at a commit, and the calendar's days", async () => {
  const dir = temp();
  const at = (date) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, TZ: "UTC" });
  const run = (date, ...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: at(date) }).toString();
  run("2001-03-04T12:00:00Z", "init", "-q", "-b", "main"); run("", "config", "user.name", "Ada"); run("", "config", "user.email", "ada@example.com");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/a.txt"), "one\n"); fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  run("2001-03-04T12:00:00Z", "add", "-A"); run("2001-03-04T12:00:00Z", "commit", "-qm", "first");
  fs.writeFileSync(path.join(dir, "src/a.txt"), "one\ntwo\n");
  run("2001-03-04T15:00:00Z", "commit", "-qam", "second");
  fs.writeFileSync(path.join(dir, "b.txt"), "b2\n");
  run("2014-07-01T09:00:00Z", "commit", "-qam", "third, years later");
  fs.writeFileSync(path.join(dir, "src/a.txt"), "one\ntwo\nthree\n"); fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
  run("2026-01-02T09:00:00Z", "add", "-A"); run("2026-01-02T09:00:00Z", "commit", "-qm", "fourth");
  const hashes = run("", "log", "--format=%H").trim().split("\n").reverse();
  const before = process.env.TZ; process.env.TZ = "UTC";
  try {
    // Every day with commits, however long ago, with how many.
    assert.deepEqual(await git.days(dir), [["2001-03-04", 2], ["2014-07-01", 1], ["2026-01-02", 1]]);
    // The history as it stood at the end of a day.
    assert.deepEqual((await git.log(dir, 50, "2014-12-31")).map((c) => c[5]), ["third, years later", "second", "first"]);
    assert.deepEqual((await git.log(dir, 50, "2001-03-04")).map((c) => c[5]), ["second", "first"]);
    assert.equal((await git.log(dir, 50)).length, 4);
    await assert.rejects(git.log(dir, 50, "2014-12-31 --output=/tmp/x"), /Bad request/);
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }

  // One file's history: only the commits that changed it, and which of them a given commit sees.
  const history = await git.history(dir, "src/a.txt", hashes[2]);
  assert.deepEqual(history.commits.map((c) => c[3]), ["fourth", "second", "first"]);
  assert.equal(history.at, hashes[1], "at the third commit, the file is as the second left it");
  assert.equal((await git.history(dir, "src/a.txt", "HEAD")).at, hashes[3]);
  assert.equal(await git.file(dir, history.at, "src/a.txt"), "one\ntwo\n");
  assert.equal((await git.history(dir, "never.txt", "HEAD")).at, "");
  await assert.rejects(git.history(dir, "../outside", "HEAD"), /outside the folder/);
  // Everything there was at a commit.
  assert.deepEqual(await git.tree(dir, hashes[0]), ["b.txt", "src/a.txt"]);
  assert.deepEqual(await git.tree(dir, "HEAD"), ["b.txt", "c.txt", "src/a.txt"]);
  assert.deepEqual(await git.tree(dir, "nonsense"), []);
});

test("git: requests that reach outside the folder or smuggle options are refused", async () => {
  const dir = temp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await assert.rejects(async () => git.stage(dir, ["../outside.txt"]), /outside the folder/);
  await assert.rejects(async () => git.stage(dir, ["--force"]), /Bad request/);
  await assert.rejects(async () => git.stage(dir, []), /Bad request/);
  await assert.rejects(git.show(dir, "HEAD; rm -rf /"), /Bad request/);
  await assert.rejects(git.show(dir, "--output=/tmp/x"), /Bad request/);
  await assert.rejects(git.commit(dir, "   "), /needs a message/);
});

test("marketplace: results are read, and a download must come from the registry itself", async () => {
  const pages = {
    "https://open-vsx.org/api/demo/good": { files: { download: "https://open-vsx.org/files/good.vsix" } },
    "https://open-vsx.org/api/demo/evil": { files: { download: "https://evil.example/x.vsix" } },
  };
  const fetcher = async (url) => {
    if (url.includes("/api/-/search")) return { ok: true, json: async () => ({ extensions: [{ namespace: "demo", name: "good", displayName: "Good", description: "d", version: "1.0.0", downloadCount: 5 }, { namespace: "../x", name: "bad" }] }) };
    if (pages[url]) return { ok: true, json: async () => pages[url] };
    if (url === "https://open-vsx.org/files/good.vsix") return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return { ok: false, status: 404 };
  };
  assert.deepEqual(await market.search("good", fetcher), [["demo", "good", "Good", "d", "1.0.0", 5, ""]]);
  assert.deepEqual([...(await market.download("demo", "good", fetcher))], [1, 2, 3]);
  await assert.rejects(market.download("demo", "evil", fetcher), /somewhere else/);
  await assert.rejects(market.download("demo", "missing", fetcher), /has no demo\.missing/);
  await assert.rejects(market.download("../etc", "passwd", fetcher), /Bad request/);
});

test("git: discarding brings back what was changed or deleted, and removes what is new", async () => {
  const dir = temp();
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main"); run("config", "user.name", "Ada"); run("config", "user.email", "ada@example.com");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "kept.txt"), "kept\n");
  fs.writeFileSync(path.join(dir, "src/gone.txt"), "here\n");
  fs.writeFileSync(path.join(dir, "staged.txt"), "old\n");
  run("add", "-A"); run("commit", "-qm", "first");

  fs.writeFileSync(path.join(dir, "kept.txt"), "changed\n");
  fs.rmSync(path.join(dir, "src/gone.txt"));
  fs.writeFileSync(path.join(dir, "staged.txt"), "new\n"); run("add", "staged.txt");
  fs.writeFileSync(path.join(dir, "fresh file.txt"), "untracked\n");
  fs.writeFileSync(path.join(dir, "added.txt"), "staged but never committed\n"); run("add", "added.txt");
  fs.writeFileSync(path.join(dir, "bystander.txt"), "mine\n");

  // One file only: the others are left exactly as they were.
  await git.discard(dir, ["kept.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "kept.txt"), "utf8"), "kept\n");
  assert.equal((await git.status(dir)).files.length, 5);

  await git.discard(dir, ["src/gone.txt", "staged.txt", "fresh file.txt", "added.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "src/gone.txt"), "utf8"), "here\n", "a deleted file comes back");
  assert.equal(fs.readFileSync(path.join(dir, "staged.txt"), "utf8"), "old\n", "a staged change is undone too");
  assert.ok(!fs.existsSync(path.join(dir, "fresh file.txt")) && !fs.existsSync(path.join(dir, "added.txt")), "new files are removed");
  assert.deepEqual((await git.status(dir)).files, [["bystander.txt", " ", "?"]], "what was not named is untouched");

  await assert.rejects(git.discard(dir, ["../outside.txt"]), /outside/);
  await assert.rejects(git.discard(dir, ["--force"]), /Bad request/);
  await assert.rejects(git.discard(dir, []), /Bad request/);
});
