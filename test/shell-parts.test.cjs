// Parts of the shell that need no window: deletions that can be taken back, files that are
// looked at, the watching of the disk for extensions, and how reported problems are shown.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const undo = require("../shell/undo.cjs");
const view = require("../shell/view.cjs");
const watch = require("../shell/exthost/watch.cjs");
const { level } = require("../shell/exthost/problems.cjs");

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), "runes-" + name + "-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 4000) => { const start = Date.now(); while (Date.now() - start < ms) { if (await test()) return true; await wait(40); } return false; };

// --- Deleting, and taking it back ---------------------------------------------------------------

function holding() {
  const root = temp("root"), dir = path.join(temp("held"), "undo"), trashed = [];
  const held = undo.create({ dir, limit: 3, trash: async (file) => { trashed.push(file); await fs.promises.rm(file, { recursive: true, force: true }); } });
  return { root, dir, trashed, held };
}

test("a deleted file and a deleted folder come back exactly as they were", async () => {
  const { root, held, trashed } = holding();
  fs.writeFileSync(path.join(root, "a.txt"), "alpha");
  fs.mkdirSync(path.join(root, "pkg/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg/deep/b.bin"), Buffer.from([0, 1, 2, 255]));
  fs.symlinkSync("../a.txt", path.join(root, "pkg/link"));
  const gone = await held.hold([path.join(root, "a.txt"), path.join(root, "pkg")], root);
  assert.deepEqual(gone, [path.join(root, "a.txt"), path.join(root, "pkg")]);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(held.pending(root), true);
  const back = await held.undo(root);
  assert.deepEqual(back, { restored: [path.join(root, "a.txt"), path.join(root, "pkg")], kept: [] });
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "alpha");
  assert.deepEqual([...fs.readFileSync(path.join(root, "pkg/deep/b.bin"))], [0, 1, 2, 255]);
  // A link is still a link, pointing where it pointed: it was never followed.
  assert.equal(fs.readlinkSync(path.join(root, "pkg/link")), "../a.txt");
  assert.equal(held.pending(root), false);
  assert.deepEqual(trashed, [], "nothing went to the trash");
  await assert.rejects(held.undo(root), /no deletion to undo/);
});

test("deletions are taken back last first, and only in the folder they were made in", async () => {
  const { root, held } = holding();
  for (const name of ["one", "two"]) fs.writeFileSync(path.join(root, name), name);
  await held.hold([path.join(root, "one")], root);
  await held.hold([path.join(root, "two")], root);
  await assert.rejects(held.undo("/somewhere/else"), /no deletion to undo/);
  assert.deepEqual((await held.undo(root)).restored, [path.join(root, "two")]);
  assert.deepEqual((await held.undo(root)).restored, [path.join(root, "one")]);
});

test("what cannot go back because its place is taken goes to the trash, and the deletion before it is next", async () => {
  const { root, dir, held, trashed } = holding();
  fs.writeFileSync(path.join(root, "first"), "first");
  await held.hold([path.join(root, "first")], root);
  fs.writeFileSync(path.join(root, "a"), "old"); fs.writeFileSync(path.join(root, "b"), "bee");
  await held.hold([path.join(root, "a"), path.join(root, "b")], root);
  fs.writeFileSync(path.join(root, "a"), "new");
  const back = await held.undo(root);
  assert.deepEqual(back, { restored: [path.join(root, "b")], kept: [path.join(root, "a")] });
  assert.equal(fs.readFileSync(path.join(root, "a"), "utf8"), "new", "what took its place is not overwritten");
  assert.equal(trashed.length, 1, "the one that could not go back is in the trash");
  assert.ok(trashed[0].startsWith(dir) && trashed[0].endsWith(path.sep + "a"));
  // Nothing is stuck: the deletion before it comes back at the next asking.
  assert.deepEqual(await held.undo(root), { restored: [path.join(root, "first")], kept: [] });
  assert.deepEqual(fs.readdirSync(dir), []);
  // All of a deletion's places taken: nothing comes back, and it says which.
  fs.writeFileSync(path.join(root, "x"), "1");
  await held.hold([path.join(root, "x")], root);
  fs.writeFileSync(path.join(root, "x"), "2");
  assert.deepEqual(await held.undo(root), { restored: [], kept: [path.join(root, "x")] });
  await assert.rejects(held.undo(root), /no deletion to undo/);
});

test("what is not taken back goes to the trash from its own place: past the limit, and on closing", async () => {
  const { root, dir, held, trashed } = holding();
  for (const name of ["1", "2", "3", "4", "5"]) { fs.writeFileSync(path.join(root, name), name); await held.hold([path.join(root, name)], root); }
  // Three can be taken back; the two oldest have gone to the trash, each from where it was.
  assert.deepEqual(trashed, [path.join(root, "1"), path.join(root, "2")]);
  assert.equal(held.held(), 3);
  // A folder that is gone by then: the trash is given the held copy instead.
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, "x"), "x");
  await held.hold([path.join(sub, "x")], root);
  fs.rmdirSync(sub);
  await held.flush();
  assert.equal(held.held(), 0);
  assert.equal(trashed.length, 6);
  assert.ok(trashed.includes(path.join(root, "5")) && trashed.some((file) => file.startsWith(dir) && file.endsWith(path.sep + "x")));
  assert.deepEqual(fs.readdirSync(root), [], "nothing is left behind, and nothing came back");
  assert.deepEqual(fs.readdirSync(dir), [], "nothing is left held");
});

test("what a run that was stopped short left held is put in the trash when Runes next starts", async () => {
  const { root, dir, trashed } = holding();
  fs.mkdirSync(path.join(dir, "old-run/0"), { recursive: true });
  fs.writeFileSync(path.join(dir, "old-run/0/left.txt"), "left");
  const next = undo.create({ dir, trash: async (file) => { trashed.push(file); await fs.promises.rm(file, { recursive: true }); } });
  await next.sweep();
  assert.deepEqual(trashed, [path.join(dir, "old-run/0/left.txt")]);
  assert.deepEqual(fs.readdirSync(dir), []);
  void root;
});

test("on another disk, what is small is copied across to be held; what is large goes straight to the trash", async () => {
  const root = temp("root"), dir = path.join(temp("held"), "undo"), trashed = [];
  const other = () => Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  const held = undo.create({ dir, mostCopied: 100, mostFiles: 5, rename: async () => { throw other(); }, trash: async (file) => { trashed.push(file); await fs.promises.rm(file, { recursive: true }); } });
  fs.writeFileSync(path.join(root, "small.txt"), "tiny");
  fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(500));
  fs.mkdirSync(path.join(root, "many"));
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, "many", "f" + i), "x");
  const gone = await held.hold(["small.txt", "large.bin", "many"].map((name) => path.join(root, name)), root);
  assert.equal(gone.length, 3);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(trashed.sort(), [path.join(root, "large.bin"), path.join(root, "many")]);
  assert.deepEqual(await held.undo(root), { restored: [path.join(root, "small.txt")], kept: [] });
  assert.equal(fs.readFileSync(path.join(root, "small.txt"), "utf8"), "tiny");
  // Only large things: all gone, and nothing to take back.
  fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(500));
  assert.deepEqual(await held.hold([path.join(root, "large.bin")], root), [path.join(root, "large.bin")]);
  assert.equal(held.pending(root), false);
});

test("a deletion that fails says so and holds nothing", async () => {
  const { root, held } = holding();
  await assert.rejects(held.hold([path.join(root, "not-there")], root));
  assert.equal(held.held(), 0);
});

// --- Files that are looked at -------------------------------------------------------------------

test("what is served is decided by the name, from a fixed list, and nothing that can run is in it", () => {
  assert.equal(view.kindOf("/p/Photo.JPG"), "image");
  assert.equal(view.typeOf("/p/Photo.JPG"), "image/jpeg");
  assert.equal(view.kindOf("song.mp3"), "audio");
  assert.equal(view.kindOf("film.mp4"), "video");
  assert.equal(view.kindOf("paper.pdf"), "pdf");
  assert.equal(view.kindOf("book.xlsx"), "sheet");
  for (const name of ["page.html", "logo.svg", "run.js", "notes.md", "data.csv", "png", ".png", "archive.zip", "a.png/b"]) assert.equal(view.kindOf(name), "", name);
  for (const kind of Object.values(view.TYPES)) for (const type of Object.values(kind)) assert.ok(!/html|svg|script|xml$/.test(type), type);
});

test("a player may ask for part of a file", () => {
  assert.equal(view.rangeOf(undefined, 100), null);
  assert.deepEqual(view.rangeOf("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(view.rangeOf("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(view.rangeOf("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(view.rangeOf("bytes=50-500", 100), { start: 50, end: 99 });
  for (const bad of ["bytes=100-", "bytes=9-3", "bytes=-", "items=0-1", "bytes=0-1,5-6", "bytes=a-b", "bytes=-0"]) assert.equal(view.rangeOf(bad, 100), false, bad);
});

test("a file is answered whole or in part, and never as anything but what its name says", async () => {
  const dir = temp("view"), file = path.join(dir, "tone.mp3");
  fs.writeFileSync(file, Buffer.from("0123456789"));
  const text = async (body) => (body ? Buffer.from(await new Response(body).arrayBuffer()).toString() : "");
  const whole = await view.answer(file, null);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers["content-type"], "audio/mpeg");
  assert.equal(whole.headers["x-content-type-options"], "nosniff");
  assert.match(whole.headers["content-security-policy"], /default-src 'none'.*sandbox/);
  assert.equal(await text(whole.body), "0123456789");
  const part = await view.answer(file, "bytes=2-5");
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], "bytes 2-5/10");
  assert.equal(part.headers["content-length"], "4");
  assert.equal(await text(part.body), "2345");
  assert.equal((await view.answer(file, "bytes=50-")).status, 416);
  assert.equal((await view.answer(file, null, "HEAD")).body, null);
  // A page dressed as a picture is a picture to the engine, or nothing: never a page.
  const page = path.join(dir, "page.html");
  fs.writeFileSync(page, "<script>alert(1)</script>");
  assert.equal((await view.answer(page, null)).status, 404);
  assert.equal((await view.answer(path.join(dir, "missing.png"), null)).status, 404);
  assert.equal((await view.answer(dir, null)).status, 404);
  // The PDF viewer cannot start in a sandboxed frame; what it may load is still nothing.
  fs.writeFileSync(path.join(dir, "a.pdf"), "%PDF-1.4");
  const pdf = await view.answer(path.join(dir, "a.pdf"), null);
  assert.match(pdf.headers["content-security-policy"], /default-src 'none'/);
  assert.doesNotMatch(pdf.headers["content-security-policy"], /sandbox/);
});

test("an address stands for one file, cannot be guessed, and the oldest are forgotten", () => {
  const given = view.grants(3);
  const a = given.grant("/p/a.png");
  assert.match(a, /^[0-9a-f]{36}$/);
  assert.equal(given.grant("/p/a.png"), a, "the same file keeps its address");
  assert.equal(given.file(a), "/p/a.png");
  assert.equal(given.file("nope"), null);
  assert.equal(given.file("../a.png"), null);
  const b = given.grant("/p/b.png"); given.grant("/p/c.png"); given.grant("/p/d.png");
  assert.equal(given.file(a), null, "the oldest is forgotten");
  assert.equal(given.file(b), "/p/b.png");
  given.clear();
  assert.equal(given.file(b), null);
});

// --- Watching the disk for extensions -------------------------------------------------------------

test("globs as extensions write them", () => {
  const yes = (glob, file) => assert.ok(watch.globRegex(glob).test(file), glob + " ~ " + file);
  const no = (glob, file) => assert.ok(!watch.globRegex(glob).test(file), glob + " !~ " + file);
  yes("**/bea.toml", "bea.toml"); yes("**/bea.toml", "a/b/bea.toml"); no("**/bea.toml", "a/xbea.toml");
  yes("**/*.{bea,gleam}", "src/a.bea"); yes("**/*.{bea,gleam}", "x.gleam"); no("**/*.{bea,gleam}", "x.beam");
  yes("**/{*.bea,bea.toml,src/**/*.gleam}", "src/deep/er/x.gleam"); no("**/{*.bea,bea.toml,src/**/*.gleam}", "lib/x.gleam");
  yes("*.py", "a.py"); no("*.py", "d/a.py"); yes("src/?.rs", "src/a.rs"); no("src/?.rs", "src/ab.rs");
  yes("a+b (c).txt", "a+b (c).txt"); yes("**", "anything/at/all");
  assert.equal(watch.globRegex(42), null);
});

test("what happens on disk is told: files made, changed and removed, in folders made later too", async () => {
  const root = temp("watch"), seen = [];
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".beabuild/build"), { recursive: true });
  fs.writeFileSync(path.join(root, "bea.toml"), "name = 1");
  const disk = watch.create({ onEvent: (kind, file) => seen.push(kind + " " + path.relative(root, file)), delay: 30 });
  disk.add(root);
  const got = (line) => until(() => seen.includes(line));
  fs.writeFileSync(path.join(root, "bea.toml"), "name = 2");
  assert.ok(await got("change bea.toml"), seen.join());
  fs.writeFileSync(path.join(root, "src/new.bea"), "x");
  assert.ok(await got("create " + path.join("src", "new.bea")), seen.join());
  fs.rmSync(path.join(root, "src/new.bea"));
  assert.ok(await got("delete " + path.join("src", "new.bea")), seen.join());
  // A folder made later is followed, and what is already in it by then is said to be new.
  fs.mkdirSync(path.join(root, "lib"));
  assert.ok(await got("create lib"), seen.join());
  fs.writeFileSync(path.join(root, "lib/late.bea"), "x");
  assert.ok(await got("create " + path.join("lib", "late.bea")), seen.join());
  // The top of a folder of built things is watched (a generated manifest lives there); what is under it is not.
  fs.writeFileSync(path.join(root, ".beabuild/gleam.toml"), "x");
  assert.ok(await got("create " + path.join(".beabuild", "gleam.toml")), seen.join());
  fs.writeFileSync(path.join(root, "node_modules/pkg/index.js"), "x");
  fs.writeFileSync(path.join(root, ".beabuild/build/out.js"), "x");
  await wait(250);
  assert.ok(!seen.some((line) => line.includes("index.js") || line.includes("out.js")), seen.join());
  const watched = disk.watching();
  assert.ok(watched >= 5 && watched <= 8, "folders watched: " + watched);
  disk.close();
  assert.equal(disk.watching(), 0);
  fs.writeFileSync(path.join(root, "bea.toml"), "name = 3");
  const before = seen.length;
  await wait(150);
  assert.equal(seen.length, before, "nothing is told once it is closed");
});

test("no more folders are watched than the limit", () => {
  const root = temp("many");
  for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(root, "d" + i));
  const disk = watch.create({ onEvent() {}, limit: 10 });
  disk.add(root);
  assert.equal(disk.watching(), 10);
  disk.close();
});

// --- How a reported problem is shown ---------------------------------------------------------------

test("problems keep the level their server gave them, and hints are of three kinds", () => {
  assert.equal(level(0, "x"), 1);
  assert.equal(level(1, "x"), 2);
  assert.equal(level(2, "x"), 3);
  assert.equal(level(3, "x"), 4);
  assert.equal(level(3, "x is not accessed", [1]), 5);
  assert.equal(level(3, "old() is deprecated", [2]), 6);
  assert.equal(level(3, "both", [1, 2]), 6);
  assert.equal(level(undefined, "x"), 1, "a problem with no level is an error, as in VS Code");
  assert.equal(level("2", "x"), 1);
});

test("a module that cannot be found is an error, whatever its server called it", () => {
  for (const message of [
    "Unknown module", 'Import "requests" could not be resolved', 'Import "yaml" could not be resolved from source',
    "unresolved import `serde`", "No module named 'numpy'", "Cannot find module './thing' or its corresponding type declarations.",
    "could not find package fmt2", "failed to resolve: use of undeclared crate or module `tokio`", "file not found for module `util`",
    "Unable to resolve module react", "Package 'x' is not installed", "missing import: gleam/json",
  ]) for (const given of [1, 2, 3]) assert.equal(level(given, message), 1, message);
  // Other things said at those levels stay as they were said.
  for (const message of ["`os` is not accessed", "unused variable: x", "line too long", "Module docstring is missing", "this import is unused", "found 3 packages"]) {
    assert.equal(level(2, message), 3, message);
    assert.equal(level(1, message), 2, message);
  }
});
