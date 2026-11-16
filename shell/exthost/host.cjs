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
    return { document, selection: new shim.Selection(zero, zero), selections: [new shim.Selection(zero, zero)], visibleRanges: [], options: { tabSize: host.tabSize ?? 4, insertSpaces: host.insertSpaces ?? true }, viewColumn: 1, edit: async () => false, insertSnippet: async () => false, setDecorations() {}, revealRange() {}, show() {}, hide() {} };
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

// Files of the open folder whose names fit a glob such as [two stars]/[star].py or "{a,b}/x.toml".
host.findFiles = async (glob, base, max = 2000) => {
  if (!base || typeof glob !== "string") return [];
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { source += "(?:.*/)?"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "{") source += "(?:";
    else if (c === "}") source += ")";
    else if (c === ",") source += "|";
    else source += /[\w/-]/.test(c) ? c : "\\" + c;
  }
  let test;
  try { test = new RegExp("^" + source + "$"); } catch { return []; }
  const found = [];
  let seen = 0;
  const walk = async (dir, rel, depth) => {
    if (found.length >= max || depth > 12 || seen > 20000) return;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      seen += 1;
      const at = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git" && !e.isSymbolicLink()) await walk(path.join(dir, e.name), at, depth + 1); }
      else if (test.test(at) && found.length < max) found.push(URI.file(path.join(dir, e.name)));
    }
  };
  await walk(base, "", 0);
  return found;
};

/** The quick fixes last offered, so the one the user picks can be found again. */
const offered = new Map();
let lastOffer = 0;

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

/** Tell the shell how an extension stands, for the list of running extensions. */
const status = (id, state, more = {}) => port.send({ type: "status", extension: id, state, ...more });

async function activate(id) {
  const entry = loaded.get(id);
  if (!entry || entry.activated) return;
  entry.activated = true;
  const began = Date.now();
  status(id, "starting");
  try {
    const main = path.resolve(entry.dir, entry.manifest.main);
    if (!main.startsWith(entry.dir + path.sep)) throw new Error("its main script lies outside the extension");
    entry.module = require(main);
    entry.context = context(entry);
    entry.description.exports = await entry.module.activate?.(entry.context);
    entry.description.isActive = true;
    status(id, "active", { ms: Date.now() - began });
    note("log", `[Extension Host] activated ${id}`);
  } catch (e) {
    status(id, "failed", { ms: Date.now() - began, error: String(e?.stack ?? e?.message ?? e).slice(0, 4000) });
    note("error", `The extension ${id} failed to start: ${e?.message ?? e}. Its output is under Extensions, Running Extensions.`);
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

/**
 * What a server says about something (a hover, an item's documentation), as Markdown: a
 * string, a MarkdownString, a { language, value } piece of code, or a list of those.
 */
const markdown = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markdown).filter(Boolean).join("\n\n");
  if (typeof value.value !== "string") return "";
  if (value.language) return "```" + value.language + "\n" + value.value + "\n```";
  // LSP's plain text kind: nothing in it is to be read as Markdown.
  if (value.kind === "plaintext") return value.value.replace(/[\\`*_{}[\]<>()#+\-.!|]/g, "\\$&");
  return value.value;
};

const KINDS = ["text", "method", "function", "constructor", "field", "variable", "class", "interface", "module", "property", "unit", "value", "enum", "keyword", "snippet",
  "color", "file", "reference", "folder", "enum-member", "constant", "struct", "event", "operator", "type-parameter"];
const edits = (list) => (Array.isArray(list) ? list : []).filter((e) => e?.range && typeof e.newText === "string").slice(0, 200)
  .map((e) => ({ line: e.range.start.line, col: e.range.start.character, endLine: e.range.end.line, endCol: e.range.end.character, text: e.newText }));

// The items of the last answer, so that one of them can be filled in later (its documentation,
// the import it needs) when the person rests on it or takes it.
let served = [];

/** One completion item, as the window needs it. `at` is where the cursor was when it was asked for. */
function describeItem(item, id, at, resolvable) {
  const label = typeof item.label === "string" ? item.label : item.label?.label ?? "";
  const insert = item.insertText ?? item.textEdit?.newText ?? label;
  const snippet = typeof insert === "object" && insert !== null;
  // Where the text goes: the server may say (replacing what is typed so far, sometimes more);
  // if it does not, the window uses the word at the cursor.
  const range = item.range?.replacing ?? item.range?.inserting ?? item.range ?? item.textEdit?.range ?? item.textEdit?.replace;
  const here = range && range.start.line === at.line && range.end.line === at.line && range.start.character <= at.character;
  return {
    id, label: label.slice(0, 300), snippet, insert: String(snippet ? insert.value : insert).slice(0, 20000),
    detail: String(item.detail ?? (typeof item.label === "object" ? [item.label.detail, item.label.description].filter(Boolean).join(" ") : "")).slice(0, 300),
    kind: KINDS[item.kind] ?? "text",
    start: here ? range.start.character : -1, after: here ? Math.max(0, range.end.character - at.character) : 0,
    filter: String(item.filterText ?? label).slice(0, 300), sort: String(item.sortText ?? label).slice(0, 300),
    doc: markdown(item.documentation).slice(0, 6000), edits: edits(item.additionalTextEdits),
    first: !!item.preselect, resolvable,
  };
}

/**
 * Completion, as VS Code asks for it. `m.ch` is the character just typed when it was not part
 * of a word: only providers that named it as a trigger are asked, and if none did the answer
 * is null ("that character means nothing here; carry on"). Otherwise every provider for the
 * language is asked, and their items are put together.
 */
async function completion(m, document, position, token) {
  const all = (host.providers.completion ?? []).filter((p) => shim.matches(p.selector, document) > 0);
  const asked = m.ch ? all.filter((p) => p.rest.includes(m.ch)) : all;
  if (m.ch && !asked.length) return null;
  const context = m.ch ? { triggerKind: 1, triggerCharacter: m.ch } : { triggerKind: 0, triggerCharacter: undefined };
  const fresh = [];
  let incomplete = false;
  await Promise.all(asked.map(async ({ provider }) => {
    try {
      const found = await provider.provideCompletionItems(document, position, token, context);
      incomplete ||= !!found?.isIncomplete;
      for (const item of Array.isArray(found) ? found : found?.items ?? []) if (item) fresh.push({ item, provider });
    } catch (e) {
      note("log", `[Extension Host] completion failed: ${e?.message ?? e}`);
    }
  }));
  served = fresh.slice(0, 3000);
  return { incomplete: incomplete || fresh.length > served.length, items: served.map((s, id) => describeItem(s.item, id, position, typeof s.provider.resolveCompletionItem === "function")) };
}

/** Fills in one item of the last answer: what the server left for later. */
async function resolveCompletion(id) {
  const entry = served[id];
  if (!entry) return null;
  try {
    if (!entry.resolved && typeof entry.provider.resolveCompletionItem === "function") {
      entry.item = (await entry.provider.resolveCompletionItem(entry.item, new CancellationTokenSource().token)) ?? entry.item;
      entry.resolved = true;
    }
  } catch (e) {
    note("log", `[Extension Host] resolving a completion failed: ${e?.message ?? e}`);
  }
  return { detail: String(entry.item.detail ?? "").slice(0, 300), doc: markdown(entry.item.documentation).slice(0, 6000), edits: edits(entry.item.additionalTextEdits) };
}

async function codeActions(m, document) {
  const range = new Range(new Position(m.line, m.col), new Position(m.endLine ?? m.line, m.endCol ?? m.col));
  const diagnostics = [];
  for (const collection of host.collections) {
    for (const d of collection.get(document.uri) ?? []) if (d.range.intersection?.(range) || d.range.start.line === m.line) diagnostics.push(d);
  }
  const token = new CancellationTokenSource().token;
  const found = [];
  const providers = (host.providers.registerCodeActionsProvider ?? []).filter((p) => shim.matches(p.selector, document) > 0);
  for (const { provider } of providers) {
    try {
      const answered = await provider.provideCodeActions(document, range, { diagnostics, only: undefined, triggerKind: m.quiet ? 2 : 1 }, token);
      for (const action of answered ?? []) {
        if (!action?.title || action.disabled) continue;
        found.push({ action, provider });
      }
    } catch (e) {
      note("log", `[Extension Host] code actions failed: ${e?.message ?? e}`);
    }
  }
  // The fix a server would choose itself comes first, then fixes, then the rest as given.
  const weight = (o) => (o.action.isPreferred ? 0 : (o.action.kind?.value ?? "quickfix").startsWith("quickfix") ? 1 : 2);
  const listed = found.map((o, i) => [o, i]).sort((a, b) => weight(a[0]) - weight(b[0]) || a[1] - b[1]).map(([o]) => o).slice(0, 60);
  // Each gets a number of its own that stays good while later questions are asked (the light
  // bulb asks again whenever the cursor rests); only the oldest are forgotten.
  const out = listed.map((o) => {
    const id = ++lastOffer;
    offered.set(id, o);
    return { id, title: String(o.action.title).slice(0, 200), kind: String(o.action.kind?.value ?? (typeof o.action.command === "string" ? "command" : "quickfix")), preferred: !!o.action.isPreferred };
  });
  for (const id of offered.keys()) { if (offered.size <= 400) break; offered.delete(id); }
  return out;
}

async function applyAction(id) {
  const entry = offered.get(id);
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
  if (m.kind === "resolveCompletion") return resolveCompletion(m.line);
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
  if (m.kind === "completion") return completion(m, document, position, token);
  const providers = (host.providers[m.kind] ?? []).filter((p) => shim.matches(p.selector, document) > 0);
  for (const { provider } of providers) {
    try {
      if (m.kind === "hover") {
        const text = markdown((await provider.provideHover(document, position, token))?.contents).trim();
        if (text) return text;
      }
      if (m.kind === "definition") {
        const found = [].concat((await provider.provideDefinition(document, position, token)) ?? [])[0];
        const uri = found?.targetUri ?? found?.uri;
        const range = found?.targetSelectionRange ?? found?.targetRange ?? found?.range;
        if (uri?.scheme === "file" && range) return { path: uri.fsPath, line: range.start.line, col: range.start.character };
      }
      if (m.kind === "format") {
        const edits = await provider.provideDocumentFormattingEdits(document, { tabSize: m.tabSize ?? 4, insertSpaces: m.insertSpaces ?? true }, token);
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
        status(extension.id, "waiting");
      }
      host.languages = m.languages ?? [];
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
      // Extensions are given a moment to put things away; one that never finishes does not keep the host alive.
      setTimeout(() => process.exit(0), 1500).unref?.();
      await Promise.allSettled([...loaded.values()].map((e) => { try { return e.module?.deactivate?.(); } catch { return undefined; } }));
      process.exit(0);
    }
  } catch (e) {
    note("log", `[Extension Host] ${e?.stack ?? e}`);
  }
});

/** The extension some code belongs to, going by the files named in a stack. */
function owner(stack) {
  for (const [id, entry] of loaded) if (String(stack).includes(entry.dir + path.sep)) return id;
  return "";
}
const said = (extension, channel, text) => port.send({ type: "output", extension, channel, text: String(text).slice(0, 4000) });
process.on("uncaughtException", (e) => said(owner(e?.stack), "Errors", `uncaught: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => said(owner(e?.stack), "Errors", `unhandled: ${e?.stack ?? e}`));
// What extensions print with console.log and the like is theirs to see too.
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...parts) => said(owner(new Error().stack), "Console", (level === "warn" || level === "error" ? level + ": " : "") + parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? p.stack ?? p.message : (() => { try { return JSON.stringify(p); } catch { return String(p); } })())).join(" "));
}
// The host lives only as long as the editor that started it.
process.on("disconnect", () => process.exit(0));
