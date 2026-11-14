// The extension host: a separate process that loads the code of installed extensions and
// answers for them. It talks to the shell in plain messages; nothing here touches the window.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const shim = require("./vscode.cjs");
const { URI, TextDocument, Position, Range, EventEmitter, CancellationTokenSource } = shim;

const port = process.parentPort
  ? { send: (m) => process.parentPort.postMessage(m), listen: (f) => process.parentPort.on("message", (e) => f(e.data)) }
  : { send: (m) => process.send?.(m), listen: (f) => process.on("message", f) };

const host = {
  root: "", appRoot: "", storage: "", settings: {}, defaults: {},
  events: {}, providers: {}, commands: new Map(), collections: new Set(),
  documents: new Map(), extensions: new Map(), active: null,
  send: (m) => port.send(m),
  activeEditor() {
    const document = host.active && host.documents.get(host.active);
    if (!document) return undefined;
    const zero = new Position(0, 0);
    return { document, selection: new shim.Range(zero, zero), selections: [], options: { tabSize: 2, insertSpaces: true }, viewColumn: 1, edit: async () => false, setDecorations() {}, revealRange() {} };
  },
  diagnosticsChanged(uri) {
    const key = uri.toString();
    const items = [];
    for (const collection of host.collections) {
      for (const d of collection.get(uri) ?? []) {
        items.push({
          line: d.range.start.line, col: d.range.start.character, endLine: d.range.end.line, endCol: d.range.end.character,
          severity: (d.severity ?? 0) + 1, message: String(d.message), source: d.source ?? collection.name ?? "",
        });
      }
    }
    if (uri.scheme === "file") port.send({ type: "diagnostics", path: uri.fsPath, items: items.slice(0, 500) });
    void key;
  },
};
/** Hand a WorkspaceEdit to the editor, as plain edits per file. */
host.applyEdit = (edit) => {
  const files = [];
  for (const [uri, edits] of edit?.entries?.() ?? []) {
    if (uri.scheme !== "file") continue;
    files.push({ path: uri.fsPath, edits: edits.filter((e) => e?.range).map((e) => ({ line: e.range.start.line, col: e.range.start.character, endLine: e.range.end.line, endCol: e.range.end.character, text: e.newText ?? "" })) });
  }
  if (!files.length) return false;
  port.send({ type: "edits", files });
  return true;
};

/** The quick fixes last offered, so the one the user picks can be found again. */
let offered = [];

const fire = (name, value) => (host.events[name] ??= new EventEmitter()).fire(value);
const note = (level, text) => port.send({ type: "note", level, text });

// --- Loading extensions ----------------------------------------------------------------------

/** id -> { dir, api, module, activated, description } */
const loaded = new Map();

const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "vscode") {
    const from = parent?.filename ?? "";
    for (const entry of loaded.values()) {
      if (from.startsWith(entry.dir + path.sep)) return entry.api;
    }
    // Asked for from somewhere unexpected: still a working module, tied to no extension.
    return [...loaded.values()][0]?.api ?? {};
  }
  return load.call(this, request, parent, ...rest);
};

function describe(extension) {
  const manifest = extension.manifest;
  const description = {
    id: extension.id, extensionPath: extension.dir, extensionUri: URI.file(extension.dir), packageJSON: manifest,
    extensionKind: 1, isActive: false, exports: undefined, activate: () => activate(extension.id).then(() => description.exports),
  };
  for (const section of [].concat(manifest.contributes?.configuration ?? [])) {
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      if ("default" in schema) host.defaults[key] = schema.default;
    }
  }
  Object.assign(host.defaults, manifest.contributes?.configurationDefaults ?? {});
  return description;
}

function context(entry) {
  const storage = path.join(host.storage, entry.description.id);
  const memento = () => {
    const data = new Map();
    return { get: (k, d) => (data.has(k) ? data.get(k) : d), update: async (k, v) => { data.set(k, v); }, keys: () => [...data.keys()], setKeysForSync() {} };
  };
  return {
    subscriptions: [], extension: entry.description, extensionPath: entry.dir, extensionUri: URI.file(entry.dir), extensionMode: 1,
    asAbsolutePath: (p) => path.join(entry.dir, p),
    globalState: memento(), workspaceState: memento(),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: new EventEmitter().event },
    storageUri: URI.file(path.join(storage, "workspace")), globalStorageUri: URI.file(path.join(storage, "global")), logUri: URI.file(path.join(storage, "log")),
    storagePath: path.join(storage, "workspace"), globalStoragePath: path.join(storage, "global"), logPath: path.join(storage, "log"),
    environmentVariableCollection: { persistent: false, replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {}, getScoped() { return this; } },
    languageModelAccessInformation: { onDidChange: new EventEmitter().event, canSendRequest: () => false },
  };
}

async function activate(id) {
  const entry = loaded.get(id);
  if (!entry || entry.activated) return;
  entry.activated = true;
  try {
    const main = path.resolve(entry.dir, entry.manifest.main);
    if (!main.startsWith(entry.dir + path.sep)) throw new Error("its main script lies outside the extension");
    entry.module = require(main);
    entry.context = context(entry);
    entry.description.exports = await entry.module.activate?.(entry.context);
    entry.description.isActive = true;
    note("log", `[Extension Host] activated ${id}`);
  } catch (e) {
    note("error", `The extension ${id} failed to start: ${e?.message ?? e}`);
    note("log", `[Extension Host] ${e?.stack ?? e}`);
  }
}

function contains(root, name, depth) {
  if (depth < 0) return false;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  if (entries.some((e) => e.name === name)) return true;
  return entries.some((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && contains(path.join(root, e.name), name, depth - 1));
}

/** Start the extensions whose activation events have happened. */
function wake(language) {
  for (const [id, entry] of loaded) {
    if (entry.activated) continue;
    const m = entry.manifest;
    const events = m.activationEvents ?? [];
    const languages = (m.contributes?.languages ?? []).map((l) => l.id);
    const due = events.some((e) =>
      e === "*" || e === "onStartupFinished"
      || (e.startsWith("workspaceContains:") && host.root && contains(host.root, e.split("/").pop().split(":").pop(), 3))
      || (language && e === "onLanguage:" + language))
      || (language && languages.includes(language));
    if (due) activate(id);
  }
}

// --- Documents ---------------------------------------------------------------------------------

function opened(m) {
  const uri = URI.file(m.path);
  const document = new TextDocument(uri, m.language, m.text);
  host.documents.set(uri.toString(), document);
  host.active = uri.toString();
  wake(m.language);
  fire("open", document);
  fire("activeEditor", host.activeEditor());
}

function changed(m) {
  const uri = URI.file(m.path);
  const document = host.documents.get(uri.toString());
  if (!document || document.getText() === m.text) return;
  // One change that replaces everything: correct for full and for incremental sync alike.
  const all = new Range(new Position(0, 0), document.positionAt(document.getText().length));
  const length = document.getText().length;
  document._set(m.text);
  document.version += 1;
  document.isDirty = true;
  host.active = uri.toString();
  fire("change", { document, contentChanges: [{ range: all, rangeOffset: 0, rangeLength: length, text: m.text }], reason: undefined });
}

function closed(m) {
  const key = URI.file(m.path).toString();
  const document = host.documents.get(key);
  if (!document) return;
  host.documents.delete(key);
  document.isClosed = true;
  fire("close", document);
}

function saved(m) {
  const document = host.documents.get(URI.file(m.path).toString());
  if (!document) return;
  document.isDirty = false;
  fire("save", document);
}

// --- Questions from the editor -------------------------------------------------------------------

const plain = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plain).filter(Boolean).join("\n\n");
  if (typeof value.value === "string") return value.language ? value.value : value.value;
  return "";
};

async function codeActions(m, document) {
  const range = new Range(new Position(m.line, m.col), new Position(m.endLine ?? m.line, m.endCol ?? m.col));
  const diagnostics = [];
  for (const collection of host.collections) {
    for (const d of collection.get(document.uri) ?? []) if (d.range.intersection?.(range) || d.range.start.line === m.line) diagnostics.push(d);
  }
  const token = new CancellationTokenSource().token;
  offered = [];
  const providers = (host.providers.registerCodeActionsProvider ?? []).filter((p) => shim.matches(p.selector, document) > 0);
  for (const { provider } of providers) {
    try {
      const found = await provider.provideCodeActions(document, range, { diagnostics, only: undefined, triggerKind: 1 }, token);
      for (const action of found ?? []) {
        if (!action?.title || action.disabled) continue;
        offered.push({ action, provider });
      }
    } catch (e) {
      note("log", `[Extension Host] code actions failed: ${e?.message ?? e}`);
    }
  }
  return offered.slice(0, 40).map((o, id) => ({ id, title: String(o.action.title).slice(0, 200), kind: o.action.kind?.value ?? "" }));
}

async function applyAction(id) {
  const entry = offered[id];
  if (!entry) return "That fix is no longer on offer.";
  let action = entry.action;
  try {
    // Some servers fill in the edit only when the action is chosen.
    if (!action.edit && !action.command && entry.provider.resolveCodeAction) {
      action = (await entry.provider.resolveCodeAction(action, new CancellationTokenSource().token)) ?? action;
    }
    if (action.edit) host.applyEdit(action.edit);
    // A bare command has the same shape as an action: { title, command: "id", arguments }.
    const command = typeof action.command === "string" ? action : action.command;
    if (command?.command) await host.commands.get(command.command)?.(...(command.arguments ?? []));
    return "";
  } catch (e) {
    return String(e?.message ?? e);
  }
}

async function answer(m) {
  if (m.kind === "applyAction") return applyAction(m.line);
  if (m.kind === "command") {
    const run = host.commands.get(m.path);
    if (!run) return `No extension provides the command ${m.path}`;
    try { await run(); return ""; } catch (e) { return String(e?.message ?? e); }
  }
  const document = host.documents.get(URI.file(m.path).toString());
  if (!document) return null;
  if (m.kind === "codeActions") return codeActions(m, document);
  const position = new Position(m.line, m.col);
  const token = new CancellationTokenSource().token;
  const providers = (host.providers[m.kind] ?? []).filter((p) => shim.matches(p.selector, document) > 0);
  for (const { provider } of providers) {
    try {
      if (m.kind === "completion") {
        const found = await provider.provideCompletionItems(document, position, token, { triggerKind: 0 });
        const items = Array.isArray(found) ? found : found?.items ?? [];
        if (!items.length) continue;
        return items.slice(0, 200).map((i) => {
          const label = typeof i.label === "string" ? i.label : i.label?.label ?? "";
          const insert = i.insertText ?? i.textEdit?.newText ?? label;
          const snippet = typeof insert === "object";
          return { label, detail: i.detail ?? (typeof i.label === "object" ? i.label.description ?? "" : ""), insert: snippet ? insert.value : insert, snippet };
        });
      }
      if (m.kind === "hover") {
        const text = plain((await provider.provideHover(document, position, token))?.contents).replace(/```\w*\n?/g, "").trim();
        if (text) return text;
      }
      if (m.kind === "definition") {
        const found = [].concat((await provider.provideDefinition(document, position, token)) ?? [])[0];
        const uri = found?.targetUri ?? found?.uri;
        const range = found?.targetSelectionRange ?? found?.targetRange ?? found?.range;
        if (uri?.scheme === "file" && range) return { path: uri.fsPath, line: range.start.line, col: range.start.character };
      }
      if (m.kind === "format") {
        const edits = await provider.provideDocumentFormattingEdits(document, { tabSize: 2, insertSpaces: true }, token);
        if (edits?.length) return edits.map((e) => ({ line: e.range.start.line, col: e.range.start.character, endLine: e.range.end.line, endCol: e.range.end.character, text: e.newText }));
      }
    } catch (e) {
      note("log", `[Extension Host] ${m.kind} failed: ${e?.message ?? e}`);
    }
  }
  return null;
}

port.listen(async (m) => {
  try {
    if (m.type === "init") {
      Object.assign(host, { root: m.root, appRoot: m.appRoot, storage: m.storage, settings: m.settings ?? {} });
      for (const extension of m.extensions) {
        const description = describe(extension);
        const entry = { dir: extension.dir, manifest: extension.manifest, description, activated: false };
        entry.api = shim.create(host, description);
        loaded.set(extension.id, entry);
        host.extensions.set(extension.id, description);
      }
      wake();
    } else if (m.type === "settings") {
      host.settings = m.settings ?? {};
      fire("configuration", { affectsConfiguration: () => true });
    } else if (m.type === "opened") opened(m);
    else if (m.type === "changed") changed(m);
    else if (m.type === "closed") closed(m);
    else if (m.type === "saved") saved(m);
    else if (m.type === "request") port.send({ type: "response", id: m.id, result: await answer(m) });
    else if (m.type === "stop") {
      await Promise.allSettled([...loaded.values()].map((e) => e.module?.deactivate?.()));
      process.exit(0);
    }
  } catch (e) {
    note("log", `[Extension Host] ${e?.stack ?? e}`);
  }
});

process.on("uncaughtException", (e) => note("log", `[Extension Host] uncaught: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => note("log", `[Extension Host] unhandled: ${e?.stack ?? e}`));
