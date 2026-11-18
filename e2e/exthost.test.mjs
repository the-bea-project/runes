// Runs the real Bea and Gleam extensions in the extension host, outside Electron, and checks
// that their language servers answer. Needs `bea` and `gleam` on the PATH.
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "runes-exthost-"));

function unpack(vsix) {
  const zip = unzipSync(readFileSync(join(root, "extensions/prebuilt", vsix)));
  const manifest = JSON.parse(Buffer.from(zip["extension/package.json"]).toString());
  const id = `${manifest.publisher}.${manifest.name}`;
  const dir = join(work, "ext", id);
  for (const [name, data] of Object.entries(zip)) {
    if (!name.startsWith("extension/") || name.endsWith("/")) continue;
    const to = join(dir, name.slice("extension/".length));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data);
  }
  return { id, dir, manifest };
}

const project = join(work, "shop");
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "bea.toml"), 'name = "shop"\nversion = "0.1.0"\n\n[dependencies]\ngleam_stdlib = ">= 0.44.0 and < 2.0.0"\n');
const good = 'import gleam/int\n\npub def double(n: Int) -> Int {\n  n * 2\n}\n\npub def label(n: Int) -> String {\n  int.to_string(double(n))\n}\n';
const file = join(project, "src/shop.bea");
writeFileSync(file, good);

const host = fork(join(root, "shell/exthost/host.cjs"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
const notes = [];
const diagnostics = new Map();
const waiting = new Map();
const edited = [];
host.on("message", (m) => {
  if (m.type === "note") notes.push(m.text);
  if (m.type === "diagnostics") diagnostics.set(m.path, m.items);
  if (m.type === "response") waiting.get(m.id)?.(m.result);
  if (m.type === "edits") edited.push(...m.files);
});
let ids = 0;
const ask = (kind, line, col, extra = {}) => new Promise((resolve) => {
  const id = ++ids;
  waiting.set(id, resolve);
  host.send({ type: "request", id, kind, path: file, line, col, ...extra });
  setTimeout(() => resolve(undefined), 20000);
});
const until = async (what, test, ms = 60000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = test();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Timed out waiting for " + what + "\n" + notes.slice(-25).join("\n"));
};

try {
  host.send({ type: "init", root: project, appRoot: root, storage: join(work, "storage"), settings: {}, extensions: [unpack("adimj11.bea-vscode.vsix"), unpack("gleam.gleam.vsix")] });
  host.send({ type: "opened", path: file, language: "bea", text: good });
  await until("the Bea extension to activate", () => notes.some((n) => n.includes("activated adimj11.bea-vscode")));
  console.log("ok  the Bea extension activates");

  // A type error must come back as a diagnostic at the right place.
  const bad = good.replace("n * 2", 'n * "two"');
  host.send({ type: "changed", path: file, version: 2, text: bad });
  host.send({ type: "saved", path: file });
  const items = await until("a diagnostic", () => (diagnostics.get(file)?.length ? diagnostics.get(file) : null), 120000);
  assert.equal(items[0].severity, 1);
  assert.equal(items[0].line, 3);
  console.log(`ok  diagnostics arrive: line ${items[0].line + 1}: ${items[0].message.split("\n")[0]}`);

  host.send({ type: "changed", path: file, version: 3, text: good });
  host.send({ type: "saved", path: file });
  await until("the diagnostic to clear", () => diagnostics.get(file)?.length === 0, 120000);
  console.log("ok  diagnostics clear when the file is fixed");

  const hover = await ask("hover", 7, 17);
  assert.match(String(hover), /Int/);
  console.log("ok  hover: " + String(hover).split("\n")[0]);

  const definition = await ask("definition", 7, 17);
  assert.equal(definition?.path, file);
  assert.equal(definition?.line, 2);
  console.log(`ok  go to definition: line ${definition.line + 1}`);

  // After "int." on line 8: asked as VS Code asks, with the dot as the trigger character.
  const answer = await ask("completion", 7, 6, { ch: "." });
  const completion = answer?.items;
  assert.ok(Array.isArray(completion) && completion.length > 0);
  const parse = completion.find((c) => c.label === "int.parse");
  assert.ok(parse, "int.parse is among them");
  // Each item says where its text starts, what it is matched by, and what it is.
  assert.equal(parse.start, 2);
  assert.equal(parse.kind, "function");
  assert.ok(parse.filter && parse.sort && parse.doc.includes("```"), "filter text, sort text and Markdown documentation come through");
  // A character no provider named as a trigger gets no answer at all: the list on show is to be left alone.
  assert.equal(await ask("completion", 7, 6, { ch: "!" }), null);
  const more = await ask("resolveCompletion", parse.id, 0);
  assert.ok(more && Array.isArray(more.edits));
  console.log(`ok  completion: ${completion.length} items, e.g. ${completion.slice(0, 3).map((c) => c.label).join(", ")}`);

  host.send({ type: "changed", path: file, version: 4, text: good.replace("  n * 2", "      n*2") });
  const edits = await ask("format", 0, 0);
  assert.ok(Array.isArray(edits) && edits.length > 0);
  console.log(`ok  format document: ${edits.length} edit(s)`);

  // What the call being written expects, from the real server: the signature, and the argument in hand.
  const calling = 'import gleam/int\n\npub def double(n: Int) -> Int {\n  n * 2\n}\n\npub def label(n: Int) -> String {\n  int.to_string(double(\n}\n';
  host.send({ type: "changed", path: file, version: 5, text: calling });
  // The server answers once it has read the change: asked until it does.
  const again = async (kind, line, col, extra) => {
    for (let i = 0; i < 40; i++) { const found = await ask(kind, line, col, extra); if (found && (!Array.isArray(found) || found.length)) return found; await new Promise((r) => setTimeout(r, 500)); }
    return null;
  };
  const help = await again("signature", 7, 23, { ch: "(", open: false });
  assert.ok(help && /double/.test(help.label), "signature help: " + JSON.stringify(help));
  assert.ok(help.to > help.from && /n/.test(help.label.slice(help.from, help.to)), "the argument in hand is marked: " + JSON.stringify(help));
  assert.equal(await ask("signature", 7, 23, { ch: "x", open: false }), null, "a character the server did not name opens nothing");
  console.log(`ok  signature help: ${help.label}, argument "${help.label.slice(help.from, help.to)}"`);

  // The named things of the file, for the line above the editor.
  host.send({ type: "changed", path: file, version: 6, text: good });
  const named = (await again("symbols", 0, 0)) ?? [];
  assert.deepEqual(named.map((s) => s.name), ["double", "label"], JSON.stringify(named));
  assert.ok(named[0].line <= 2 && named[0].endLine >= 4 && named[0].kind === "function", JSON.stringify(named[0]));
  console.log(`ok  document symbols: ${named.map((s) => s.name).join(", ")}`);

  // A dependency added to the manifest while the editor runs is known without starting again:
  // the extension is told the manifest changed (its file watcher is real), and its server,
  // which does not take that in while it runs, is started again for it.
  const needs = 'import gleam/json\n' + good;
  host.send({ type: "changed", path: file, version: 7, text: needs });
  await until("the import of a package that is not there to be an error", () => (diagnostics.get(file) ?? []).some((d) => d.severity === 1 && /Unknown module/.test(d.message)));
  writeFileSync(join(project, "bea.toml"), 'name = "shop"\nversion = "0.1.0"\n\n[dependencies]\ngleam_stdlib = ">= 0.44.0 and < 2.0.0"\ngleam_json = ">= 3.0.0 and < 4.0.0"\n');
  await until("the server to be started again for the changed manifest", () => notes.some((n) => /bea\.toml changed: running bea\.restartServer/.test(n)), 20000);
  await until("the package to be known", () => { const now = diagnostics.get(file) ?? []; return !now.some((d) => /Unknown module/.test(d.message)) && now.some((d) => /Unused/.test(d.message)); }, 120000);
  console.log("ok  a dependency added to bea.toml is known without a reload");
  host.send({ type: "changed", path: file, version: 8, text: good });

  // A quick fix from a real language server: Gleam offers to remove an import nothing uses.
  const gleamProject = join(work, "gshop");
  mkdirSync(join(gleamProject, "src"), { recursive: true });
  writeFileSync(join(gleamProject, "gleam.toml"), 'name = "gshop"\nversion = "0.1.0"\n\n[dependencies]\ngleam_stdlib = ">= 0.44.0 and < 2.0.0"\n');
  const gleamFile = join(gleamProject, "src/gshop.gleam");
  const gleamText = 'import gleam/int\nimport gleam/list\n\npub fn double(n: Int) -> Int {\n  n * 2\n}\n';
  writeFileSync(gleamFile, gleamText);
  host.send({ type: "opened", path: gleamFile, language: "gleam", text: gleamText });
  let actions = [];
  for (const started = Date.now(); !actions.length; ) {
    if (Date.now() - started > 180000) throw new Error("Timed out waiting for Gleam to offer a quick fix\n" + notes.slice(-25).join("\n"));
    await new Promise((r) => setTimeout(r, 1500));
    host.send({ type: "saved", path: gleamFile });
    const found = await ask("codeActions", 0, 3, { path: gleamFile, endLine: 0, endCol: 3 });
    if (Array.isArray(found)) actions = found;
  }
  assert.ok(actions.every((a) => typeof a.title === "string" && a.title), "every action has a title");
  const fix = actions.find((a) => /unused import/i.test(a.title));
  assert.ok(fix, "offered: " + actions.map((a) => a.title).join(", "));
  await ask("applyAction", fix.id, 0);
  const change = await until("the fix's edits", () => edited.find((f) => f.path === gleamFile));
  assert.ok(change.edits.length > 0 && change.edits.every((e) => e.text === ""), "the fix removes text");
  console.log(`ok  quick fix from the Gleam language server: "${fix.title}", ${change.edits.length} edit(s)`);
  console.log("\nAll extension host checks passed.");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  host.send({ type: "stop" });
  setTimeout(() => host.kill(), 1500);
}
