// The `vscode` module extensions are given: the parts added so that large, real extensions
// (the Python extension, for one) start, and what they say reaches the editor.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const shim = require("../shell/exthost/vscode.cjs");

function make() {
  const sent = [];
  const host = {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "runes-api-")), appRoot: "", settings: {}, defaults: { "python.languageServer": "Default" },
    events: {}, providers: {}, commands: new Map(), collections: new Set(), documents: new Map(), extensions: new Map(),
    send: (m) => sent.push(m), activeEditor: () => undefined, diagnosticsChanged() {}, applyEdit: () => true, findFiles: async () => [],
  };
  const vscode = shim.create(host, { id: "test.ext", packageJSON: { displayName: "Test" } });
  return { vscode, host, sent };
}

test("file system errors are the ones VS Code has, made the way extensions make them", async () => {
  const { vscode, host } = make();
  const error = vscode.FileSystemError.FileNotFound(vscode.Uri.file("/nowhere/at/all"));
  assert.ok(error instanceof vscode.FileSystemError && error instanceof Error);
  assert.equal(error.code, "FileNotFound");
  assert.match(error.name, /FileNotFound/);
  for (const kind of ["FileExists", "FileNotADirectory", "FileIsADirectory", "NoPermissions", "Unavailable"]) assert.equal(vscode.FileSystemError[kind]("x").code, kind);
  // And workspace.fs fails with them, so `catch (e) { if (e.code === "FileNotFound") … }` works.
  await assert.rejects(vscode.workspace.fs.stat(vscode.Uri.file(path.join(host.root, "missing"))), (e) => e instanceof vscode.FileSystemError && e.code === "FileNotFound");
  await assert.rejects(vscode.workspace.fs.readFile(vscode.Uri.file(path.join(host.root, "missing"))), (e) => e.code === "FileNotFound");
  await assert.rejects(vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(host.root, "missing"))), (e) => e.code === "FileNotFound");
});

test("workspace.fs reads, writes, copies, renames and deletes", async () => {
  const { vscode, host } = make();
  const at = (name) => vscode.Uri.file(path.join(host.root, name));
  await vscode.workspace.fs.createDirectory(at("d/e"));
  await vscode.workspace.fs.writeFile(at("d/a.txt"), Buffer.from("hello"));
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(at("d/a.txt"))).toString(), "hello");
  assert.equal((await vscode.workspace.fs.stat(at("d"))).type, vscode.FileType.Directory);
  assert.equal((await vscode.workspace.fs.stat(at("d/a.txt"))).type, vscode.FileType.File);
  assert.deepEqual((await vscode.workspace.fs.readDirectory(at("d"))).sort(), [["a.txt", 1], ["e", 2]]);
  await vscode.workspace.fs.copy(at("d/a.txt"), at("d/b.txt"));
  await assert.rejects(vscode.workspace.fs.rename(at("d/a.txt"), at("d/b.txt")), (e) => e.code === "FileExists");
  await vscode.workspace.fs.rename(at("d/a.txt"), at("d/b.txt"), { overwrite: true });
  await vscode.workspace.fs.delete(at("d"), { recursive: true });
  assert.ok(!fs.existsSync(path.join(host.root, "d")));
});

test("parts of VS Code that Runes does not have take whatever is asked of them", async () => {
  const { vscode } = make();
  // A test controller, used the way the Python extension uses one.
  const controller = vscode.tests.createTestController("id", "Label");
  controller.resolveHandler = async () => {};
  const item = controller.createTestItem("a", "A", vscode.Uri.file("/x"));
  controller.items.add(item);
  assert.equal(controller.items.size, 1);
  assert.deepEqual([...vscode.tests.testResults], []);
  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, () => {}, true).configureHandler = () => {};
  controller.dispose();
  // Namespaces and types nobody has heard of.
  assert.equal(typeof vscode.someFutureNamespace.registerSomething, "function");
  vscode.someFutureNamespace.registerSomething({}).dispose();
  assert.equal(typeof vscode.someFutureNamespace.onDidChangeSomething(() => {}).dispose, "function");
  const Unknown = vscode.SomeFutureType;
  assert.ok(new Unknown(1, 2) instanceof Unknown);
  assert.equal(typeof Unknown.SomeStatic, "function", "a static may be called as a maker");
  assert.ok(Unknown.SomeStatic("x") instanceof Unknown);
  assert.notEqual(Unknown.A, Unknown.B, "or compared as an enum's members");
  // Things made by the window: usable, awaitable, iterable, disposable.
  const pick = vscode.window.createQuickPick();
  pick.items = [{ label: "a" }];
  pick.onDidAccept(() => {});
  pick.show(); pick.dispose();
  const tree = vscode.window.createTreeView("x", { treeDataProvider: {} });
  await tree.reveal({});
  assert.equal(await vscode.window.showQuickPick(["a"]), undefined);
  assert.deepEqual(await vscode.lm.selectChatModels(), []);
  assert.deepEqual(await vscode.tasks.fetchTasks(), []);
  assert.equal(await vscode.debug.startDebugging(), false);
  // Real value types the big extensions construct.
  assert.equal(new vscode.TreeItem("x", vscode.TreeItemCollapsibleState.Collapsed).collapsibleState, 1);
  assert.equal(new vscode.ShellExecution("python", ["-c", "1"]).args.length, 2);
  assert.equal(new vscode.Task({ type: "x" }, vscode.TaskScope.Workspace, "n", "s").name, "n");
  assert.equal(vscode.IndentAction.Outdent, 3);
});

test("what an extension writes to its output channels is sent on, under its own name", () => {
  const { vscode, sent } = make();
  const plain = vscode.window.createOutputChannel("Python");
  plain.appendLine("Starting Jedi");
  const log = vscode.window.createOutputChannel("Python Language Server", { log: true });
  log.error("it broke", new Error("badly"));
  log.info({ a: 1 });
  const out = sent.filter((m) => m.type === "output");
  assert.deepEqual(out.map((m) => [m.extension, m.channel]), [["test.ext", "Python"], ["test.ext", "Python Language Server"], ["test.ext", "Python Language Server"]]);
  assert.equal(out[0].text, "Starting Jedi");
  assert.match(out[1].text, /^error: it broke Error: badly/);
  assert.equal(out[2].text, '{"a":1}');
  // A circular thing is not a reason to throw in an extension's logging.
  const loop = {}; loop.self = loop;
  log.info(loop);
  assert.equal(sent.filter((m) => m.type === "output").length, 4);
});

test("a language's rules, set as an extension runs, are handed on as plain JSON", () => {
  const { vscode, sent } = make();
  vscode.languages.setLanguageConfiguration("python", {
    onEnterRules: [
      { beforeText: /^\s*(?:def|class).*:\s*$/, action: { indentAction: vscode.IndentAction.Indent } },
      { beforeText: /^\s+(?:pass|break)\s*$/i, afterText: /^$/, action: { indentAction: vscode.IndentAction.Outdent } },
      { beforeText: /^\s*#.*/, action: { indentAction: vscode.IndentAction.None, appendText: "# " } },
    ],
    indentationRules: { increaseIndentPattern: /:\s*$/, decreaseIndentPattern: /^\s*else:/ },
  }).dispose();
  const said = sent.find((m) => m.type === "language");
  assert.equal(said.language, "python");
  const rules = JSON.parse(said.rules);
  assert.deepEqual(rules.onEnterRules.map((r) => r.action.indent), ["indent", "outdent", "none"]);
  assert.deepEqual(rules.onEnterRules[1].beforeText, { pattern: "^\\s+(?:pass|break)\\s*$", flags: "i" });
  assert.equal(rules.onEnterRules[2].action.appendText, "# ");
  assert.equal(rules.indentationRules.decreaseIndentPattern.pattern, "^\\s*else:");
  // And the editor's own reading of them agrees.
  return import("../src/runes_layout.mjs").then((L) => {
    assert.deepEqual(L.enter_rule(said.rules, "def f():", "", ""), [1, "", 0]);
    assert.deepEqual(L.enter_rule(said.rules, "    PASS", "", ""), [3, "", 0]);
    assert.deepEqual(L.enter_rule(said.rules, "# note", "", ""), [0, "# ", 0]);
  });
});

test("a setting an extension changes holds for the session; reading goes through defaults", async () => {
  const { vscode, host } = make();
  const python = vscode.workspace.getConfiguration("python");
  assert.equal(python.get("languageServer"), "Default");
  assert.equal(python.get("missing", 7), 7);
  await python.update("languageServer", "Jedi");
  assert.equal(vscode.workspace.getConfiguration("python").get("languageServer"), "Jedi");
  assert.equal(host.settings["python.languageServer"], "Jedi");
  assert.equal(python.inspect("languageServer").defaultValue, "Default");
  await python.update("languageServer", undefined);
  assert.equal(vscode.workspace.getConfiguration().get("python.languageServer"), "Default");
});
