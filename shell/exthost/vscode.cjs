// The `vscode` module, as far as Runes provides it. Extensions `require("vscode")` and get
// this. The surface is the part language-server extensions (vscode-languageclient) use;
// anything not listed still resolves to a harmless stand-in, so an extension that touches
// an API Runes lacks keeps running instead of throwing at load.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { URI, Utils } = require("vscode-uri");

const VERSION = "1.96.0";

// --- Small building blocks ----------------------------------------------------------------------

class Disposable {
  constructor(dispose) { this._dispose = dispose; }
  static from(...items) { return new Disposable(() => items.forEach((i) => i?.dispose?.())); }
  dispose() { const d = this._dispose; this._dispose = null; d?.(); }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const entry = thisArg ? listener.bind(thisArg) : listener;
      this._listeners.add(entry);
      const d = new Disposable(() => this._listeners.delete(entry));
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(value) {
    for (const l of [...this._listeners]) {
      try { l(value); } catch (e) { console.error("[runes] an extension's event listener failed:", e); }
    }
  }
  dispose() { this._listeners.clear(); }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
    this._emitter = emitter;
  }
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; this._emitter.fire(); } }
  dispose() { this._emitter.dispose(); }
}
class CancellationError extends Error { constructor() { super("Canceled"); this.name = "Canceled"; } }

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isBeforeOrEqual(o) { return this.isBefore(o) || this.isEqual(o); }
  isAfter(o) { return !this.isBeforeOrEqual(o); }
  isAfterOrEqual(o) { return !this.isBefore(o); }
  isEqual(o) { return this.line === o.line && this.character === o.character; }
  compareTo(o) { return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1; }
  translate(a = 0, b = 0) { return typeof a === "object" ? new Position(this.line + (a.lineDelta ?? 0), this.character + (a.characterDelta ?? 0)) : new Position(this.line + a, this.character + b); }
  with(a = this.line, b = this.character) { return typeof a === "object" ? new Position(a.line ?? this.line, a.character ?? this.character) : new Position(a, b); }
}

class Range {
  constructor(a, b, c, d) {
    let start = typeof a === "number" ? new Position(a, b) : a;
    let end = typeof a === "number" ? new Position(c, d) : b;
    if (end.isBefore?.(start) ?? false) [start, end] = [end, start];
    this.start = start instanceof Position ? start : new Position(start.line, start.character);
    this.end = end instanceof Position ? end : new Position(end.line, end.character);
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(o) { return o instanceof Range ? this.contains(o.start) && this.contains(o.end) : !o.isBefore(this.start) && !o.isAfter(this.end); }
  isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
  intersection(o) {
    const start = this.start.isAfter(o.start) ? this.start : o.start, end = this.end.isBefore(o.end) ? this.end : o.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(o) { return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end); }
  with(start = this.start, end = this.end) { return start && !(start instanceof Position) && ("start" in start || "end" in start) ? new Range(start.start ?? this.start, start.end ?? this.end) : new Range(start, end); }
}
class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d);
    this.anchor = typeof a === "number" ? new Position(a, b) : a;
    this.active = typeof a === "number" ? new Position(c, d) : b;
  }
  get isReversed() { return this.anchor.isAfter(this.active); }
}
class Location { constructor(uri, rangeOrPosition) { this.uri = uri; this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition; } }

class MarkdownString {
  constructor(value = "", supportThemeIcons = false) { this.value = value; this.supportThemeIcons = supportThemeIcons; this.isTrusted = false; this.supportHtml = false; }
  appendText(text) { this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&"); return this; }
  appendMarkdown(text) { this.value += text; return this; }
  appendCodeblock(code, language = "") { this.value += "\n```" + language + "\n" + code + "\n```\n"; return this; }
}
class SnippetString {
  constructor(value = "") { this.value = value; }
  appendText(t) { this.value += t.replace(/[$}\\]/g, "\\$&"); return this; }
  appendTabstop(n = 0) { this.value += "$" + n; return this; }
  appendPlaceholder(v, n = 1) { this.value += "${" + n + ":" + (typeof v === "function" ? "" : v) + "}"; return this; }
  appendChoice(values, n = 1) { this.value += "${" + n + "|" + values.join(",") + "|}"; return this; }
  appendVariable(name, d = "") { this.value += "${" + name + (d ? ":" + d : "") + "}"; return this; }
}
class TextEdit {
  constructor(range, newText) { this.range = range; this.newText = newText; }
  static replace(range, newText) { return new TextEdit(range, newText); }
  static insert(position, newText) { return new TextEdit(new Range(position, position), newText); }
  static delete(range) { return new TextEdit(range, ""); }
  static setEndOfLine(eol) { const e = new TextEdit(new Range(0, 0, 0, 0), ""); e.newEol = eol; return e; }
}
class WorkspaceEdit {
  constructor() { this._edits = []; }
  replace(uri, range, newText) { this._edits.push([uri, new TextEdit(range, newText)]); }
  insert(uri, position, newText) { this.replace(uri, new Range(position, position), newText); }
  delete(uri, range) { this.replace(uri, range, ""); }
  set(uri, edits) { for (const e of edits) this._edits.push([uri, e]); }
  get(uri) { return this._edits.filter(([u]) => u.toString() === uri.toString()).map(([, e]) => e); }
  has(uri) { return this.get(uri).length > 0; }
  entries() { const by = new Map(); for (const [u, e] of this._edits) { const k = u.toString(); if (!by.has(k)) by.set(k, [u, []]); by.get(k)[1].push(e); } return [...by.values()]; }
  get size() { return this.entries().length; }
  createFile() {} deleteFile() {} renameFile() {}
}
class Diagnostic {
  constructor(range, message, severity = 0) { this.range = range; this.message = message; this.severity = severity; }
}
class DiagnosticRelatedInformation { constructor(location, message) { this.location = location; this.message = message; } }
class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class CompletionList { constructor(items = [], isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; } }
class CodeActionKind {
  constructor(value) { this.value = value; }
  append(part) { return new CodeActionKind(this.value ? this.value + "." + part : part); }
  contains(other) { return other.value === this.value || other.value.startsWith(this.value + "."); }
  intersects(other) { return this.contains(other) || other.contains(this); }
}
Object.assign(CodeActionKind, {
  Empty: new CodeActionKind(""), QuickFix: new CodeActionKind("quickfix"), Refactor: new CodeActionKind("refactor"),
  RefactorExtract: new CodeActionKind("refactor.extract"), RefactorInline: new CodeActionKind("refactor.inline"),
  RefactorMove: new CodeActionKind("refactor.move"), RefactorRewrite: new CodeActionKind("refactor.rewrite"),
  Source: new CodeActionKind("source"), SourceOrganizeImports: new CodeActionKind("source.organizeImports"),
  SourceFixAll: new CodeActionKind("source.fixAll"), Notebook: new CodeActionKind("notebook"),
});
// Value types extensions construct or subclass. Each keeps the fields VS Code's own has.
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } get isResolved() { return !!this.command; } }
class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
class SymbolInformation {
  constructor(name, kind, containerOrRange, locationOrUri) {
    this.name = name; this.kind = kind;
    if (typeof containerOrRange === "string" || containerOrRange === undefined) { this.containerName = containerOrRange; this.location = locationOrUri; }
    else { this.location = new Location(locationOrUri, containerOrRange); }
  }
}
class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); } }
class ParameterInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; } }
class SignatureInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; } }
class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } }
class DocumentHighlight { constructor(range, kind = 0) { this.range = range; this.kind = kind; } }
class FoldingRange { constructor(start, end, kind) { this.start = start; this.end = end; this.kind = kind; } }
class SelectionRange { constructor(range, parent) { this.range = range; this.parent = parent; } }
class InlayHint { constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; } }
class InlayHintLabelPart { constructor(value) { this.value = value; } }
class CallHierarchyItem { constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); } }
class TypeHierarchyItem { constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); } }
class Color { constructor(red, green, blue, alpha) { Object.assign(this, { red, green, blue, alpha }); } }
class ColorInformation { constructor(range, color) { this.range = range; this.color = color; } }
class ColorPresentation { constructor(label) { this.label = label; } }
class SemanticTokens { constructor(data, resultId) { this.data = data; this.resultId = resultId; } }

class RelativePattern {
  constructor(base, pattern) { this.baseUri = typeof base === "string" ? URI.file(base) : base.uri ?? base; this.base = this.baseUri.fsPath; this.pattern = pattern; }
}
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
ThemeIcon.File = new ThemeIcon("file"); ThemeIcon.Folder = new ThemeIcon("folder");
class ThemeColor { constructor(id) { this.id = id; } }
class SemanticTokensLegend { constructor(tokenTypes, tokenModifiers = []) { this.tokenTypes = tokenTypes; this.tokenModifiers = tokenModifiers; } }

const enums = {
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
  CompletionItemKind: Object.fromEntries(["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter", "User", "Issue"].map((n, i) => [n, i])),
  CompletionItemTag: { Deprecated: 1 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
  SymbolKind: Object.fromEntries(["File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator", "TypeParameter"].map((n, i) => [n, i])),
  SymbolTag: { Deprecated: 1 },
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  EndOfLine: { LF: 1, CRLF: 2 },
  InsertTextFormat: { PlainText: 1, Snippet: 2 },
  SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
  CodeActionTriggerKind: { Invoke: 1, Automatic: 2 },
  DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  UIKind: { Desktop: 1, Web: 2 },
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  TaskScope: { Global: 1, Workspace: 2 },
  InlayHintKind: { Type: 1, Parameter: 2 },
  FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  TextEditorCursorStyle: { Line: 1, Block: 2, Underline: 3 },
};

/** A class for an API type Runes has no use for: it keeps what it is given. */
function standIn(name) {
  const cls = { [name]: class { constructor(...args) { this.args = args; } dispose() {} } }[name];
  return new Proxy(cls, { get: (t, k) => (k in t ? t[k] : typeof k === "string" && /^[A-Z]/.test(k) ? (t[k] = new t()) : undefined) });
}

// --- Documents ------------------------------------------------------------------------------------

class TextDocument {
  constructor(uri, languageId, text) {
    this.uri = uri; this.fileName = uri.fsPath; this.languageId = languageId; this.version = 1;
    this.isUntitled = uri.scheme === "untitled"; this.isDirty = false; this.isClosed = false; this.eol = 1; this.encoding = "utf8";
    this._set(text);
  }
  _set(text) {
    this._text = text;
    this._starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this._starts.push(i + 1);
  }
  get lineCount() { return this._starts.length; }
  getText(range) { return range ? this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this._text; }
  offsetAt(p) {
    const line = Math.max(0, Math.min(p.line, this.lineCount - 1));
    const end = line + 1 < this.lineCount ? this._starts[line + 1] - 1 : this._text.length;
    return Math.max(this._starts[line], Math.min(this._starts[line] + p.character, end));
  }
  positionAt(offset) {
    offset = Math.max(0, Math.min(offset, this._text.length));
    let lo = 0, hi = this._starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this._starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return new Position(lo, offset - this._starts[lo]);
  }
  lineAt(at) {
    const n = Math.max(0, Math.min(typeof at === "number" ? at : at.line, this.lineCount - 1));
    const end = n + 1 < this.lineCount ? this._starts[n + 1] - 1 : this._text.length;
    const text = this._text.slice(this._starts[n], end).replace(/\r$/, "");
    const first = text.search(/\S/);
    return {
      lineNumber: n, text, range: new Range(n, 0, n, text.length),
      rangeIncludingLineBreak: n + 1 < this.lineCount ? new Range(n, 0, n + 1, 0) : new Range(n, 0, n, text.length),
      firstNonWhitespaceCharacterIndex: first === -1 ? text.length : first, isEmptyOrWhitespace: first === -1,
    };
  }
  getWordRangeAtPosition(position, regex = /[\p{L}\p{N}_]+/gu) {
    const { text } = this.lineAt(position.line);
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    for (let m; (m = re.exec(text)); ) {
      if (m[0] === "") { re.lastIndex++; continue; }
      if (m.index <= position.character && position.character <= m.index + m[0].length) return new Range(position.line, m.index, position.line, m.index + m[0].length);
    }
    return undefined;
  }
  validatePosition(p) { return this.positionAt(this.offsetAt(p)); }
  validateRange(r) { return new Range(this.validatePosition(r.start), this.validatePosition(r.end)); }
  save() { return Promise.resolve(false); }
}

function matches(selector, document) {
  if (Array.isArray(selector)) return Math.max(0, ...selector.map((s) => matches(s, document)));
  if (typeof selector === "string") return selector === "*" ? 5 : selector === document.languageId ? 10 : 0;
  if (!selector) return 0;
  if (selector.scheme && selector.scheme !== "*" && selector.scheme !== document.uri.scheme) return 0;
  if (selector.language && selector.language !== "*" && selector.language !== document.languageId) return 0;
  if (selector.pattern) {
    const glob = typeof selector.pattern === "string" ? selector.pattern : selector.pattern.pattern;
    const ending = /\*\.(\{[^}]+\}|[\w.]+)$/.exec(glob)?.[1];
    if (ending) {
      const endings = ending.startsWith("{") ? ending.slice(1, -1).split(",") : [ending];
      if (!endings.some((e) => document.fileName.endsWith("." + e))) return 0;
    }
  }
  return 10;
}

// --- The module an extension sees -------------------------------------------------------------------

/**
 * @param host what the shim needs from the extension host: `send(message)`, `root`, `settings`,
 *   `storage` (a folder), `extensions` (id -> description) and the shared `documents` map.
 */
function create(host, extension) {
  const events = host.events;
  const event = (name) => (events[name] ??= new EventEmitter()).event;
  const note = (level, text) => host.send({ type: "note", level, text: String(text).slice(0, 2000) });
  const messageBox = (level) => (text, ...rest) => {
    note(level, `${extension.packageJSON.displayName ?? extension.id}: ${text}`);
    return Promise.resolve(undefined);
  };

  const channel = (name) => {
    const line = (prefix) => (...parts) => note("log", `[${name}] ${prefix}${parts.join(" ")}`);
    return {
      name, logLevel: 3, onDidChangeLogLevel: event("logLevel"),
      append: line(""), appendLine: line(""), replace: line(""), clear() {}, show() {}, hide() {}, dispose() {},
      trace: line("trace: "), debug: line("debug: "), info: line(""), warn: line("warning: "), error: line("error: "),
    };
  };

  const defaults = host.defaults;
  const configuration = (section) => {
    const key = (k) => (section ? (k ? section + "." + k : section) : k);
    const read = (k) => {
      const full = key(k);
      if (full in host.settings) return host.settings[full];
      if (full in defaults) return defaults[full];
      // A section asked for as a whole: gather every key under it.
      const under = {};
      let any = false;
      for (const source of [defaults, host.settings]) {
        for (const [name, value] of Object.entries(source)) {
          if (name.startsWith(full + ".")) { any = true; name.slice(full.length + 1).split(".").reduce((o, part, i, all) => (o[part] = i === all.length - 1 ? value : (o[part] ?? {})), under); }
        }
      }
      return any ? under : undefined;
    };
    const api = {
      get: (k, fallback) => { const v = read(k); return v === undefined ? fallback : v; },
      has: (k) => read(k) !== undefined,
      inspect: (k) => ({ key: key(k), defaultValue: defaults[key(k)], globalValue: host.settings[key(k)] }),
      update: () => Promise.resolve(),
    };
    return new Proxy(api, { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? read(k) : undefined) });
  };

  const providers = host.providers;
  const register = (kind) => (selector, provider, ...rest) => {
    const entry = { selector, provider, rest, extension: extension.id };
    (providers[kind] ??= []).push(entry);
    return new Disposable(() => { providers[kind] = providers[kind].filter((p) => p !== entry); });
  };

  const diagnosticCollection = (name) => {
    const store = new Map();
    const publish = (uri) => host.diagnosticsChanged(uri);
    const collection = {
      name,
      set(uri, items) {
        if (Array.isArray(uri)) { for (const [u, d] of uri) collection.set(u, d); return; }
        store.set(uri.toString(), { uri, items: items ?? [] });
        publish(uri);
      },
      delete(uri) { store.delete(uri.toString()); publish(uri); },
      clear() { const all = [...store.values()]; store.clear(); all.forEach((e) => publish(e.uri)); },
      get: (uri) => store.get(uri.toString())?.items,
      has: (uri) => store.has(uri.toString()),
      forEach(callback) { for (const e of store.values()) callback(e.uri, e.items, collection); },
      dispose() { collection.clear(); host.collections.delete(collection); },
      [Symbol.iterator]: function* () { for (const e of store.values()) yield [e.uri, e.items]; },
    };
    host.collections.add(collection);
    return collection;
  };

  const folders = () => (host.root ? [{ uri: URI.file(host.root), name: path.basename(host.root), index: 0 }] : undefined);
  const watcher = () => ({
    onDidCreate: event("fsCreate"), onDidChange: event("fsChange"), onDidDelete: event("fsDelete"),
    ignoreCreateEvents: false, ignoreChangeEvents: false, ignoreDeleteEvents: false, dispose() {},
  });
  const openDocument = async (target) => {
    const uri = typeof target === "string" ? URI.file(target) : target?.scheme ? target : URI.file(String(target?.fsPath ?? ""));
    const open = host.documents.get(uri.toString());
    if (open) return open;
    return new TextDocument(uri, "plaintext", await fs.promises.readFile(uri.fsPath, "utf8"));
  };
  const memento = () => {
    const data = new Map();
    return { get: (k, d) => (data.has(k) ? data.get(k) : d), update: (k, v) => { data.set(k, v); return Promise.resolve(); }, keys: () => [...data.keys()], setKeysForSync() {} };
  };

  /** A namespace Runes does not implement: every call succeeds and does nothing. */
  const hollow = (name) => new Proxy({}, {
    get: (t, k) => {
      if (typeof k !== "string") return undefined;
      if (k in t) return t[k];
      if (k.startsWith("on")) return (t[k] = new EventEmitter().event);
      return (t[k] = (...args) => (k.startsWith("register") || k.startsWith("create") ? new Proxy(new Disposable(() => {}), { get: (o, p) => (p in o ? o[p] : typeof p === "string" && p.startsWith("on") ? new EventEmitter().event : () => undefined), set: () => true }) : undefined));
    },
  });

  const api = {
    version: VERSION,
    Uri: Object.assign(URI, { joinPath: Utils.joinPath }),
    Disposable, EventEmitter, CancellationTokenSource, CancellationError,
    Position, Range, Selection, Location, MarkdownString, SnippetString, TextEdit, WorkspaceEdit,
    Diagnostic, DiagnosticRelatedInformation, Hover, CompletionItem, CompletionList, CodeActionKind,
    RelativePattern, ThemeIcon, ThemeColor, SemanticTokensLegend,
    CodeAction, CodeLens, DocumentLink, SymbolInformation, DocumentSymbol, ParameterInformation, SignatureInformation, SignatureHelp,
    DocumentHighlight, FoldingRange, SelectionRange, InlayHint, InlayHintLabelPart, CallHierarchyItem, TypeHierarchyItem,
    Color, ColorInformation, ColorPresentation, SemanticTokens,
    ...enums,

    commands: {
      registerCommand(id, handler, thisArg) {
        host.commands.set(id, thisArg ? handler.bind(thisArg) : handler);
        return new Disposable(() => host.commands.delete(id));
      },
      registerTextEditorCommand(id, handler) { return api.commands.registerCommand(id, () => handler(api.window.activeTextEditor)); },
      executeCommand: async (id, ...args) => {
        if (id === "setContext") return undefined;
        return host.commands.get(id)?.(...args);
      },
      getCommands: async () => [...host.commands.keys()],
    },

    window: new Proxy({
      showInformationMessage: messageBox("info"), showWarningMessage: messageBox("warning"), showErrorMessage: messageBox("error"),
      createOutputChannel: (name) => channel(name),
      createStatusBarItem: () => ({ text: "", tooltip: "", command: undefined, name: "", show() {}, hide() {}, dispose() {} }),
      withProgress: (_options, task) => Promise.resolve(task({ report() {} }, new CancellationTokenSource().token)),
      get activeTextEditor() { return host.activeEditor(); },
      get visibleTextEditors() { const e = host.activeEditor(); return e ? [e] : []; },
      onDidChangeActiveTextEditor: event("activeEditor"),
      onDidChangeVisibleTextEditors: event("visibleEditors"),
      onDidChangeTextEditorSelection: event("selection"),
      onDidChangeWindowState: event("windowState"),
      state: { focused: true, active: true },
      tabGroups: { all: [], activeTabGroup: { tabs: [], isActive: true, viewColumn: 1 }, onDidChangeTabs: event("tabs"), onDidChangeTabGroups: event("tabGroups"), close: async () => true },
      showTextDocument: async (doc) => ({ document: doc }),
      showQuickPick: async () => undefined, showInputBox: async () => undefined,
      setStatusBarMessage: () => new Disposable(() => {}),
      createTextEditorDecorationType: () => ({ key: "", dispose() {} }),
      activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: event("colorTheme"),
      terminals: [], onDidOpenTerminal: event("terminalOpen"), onDidCloseTerminal: event("terminalClose"),
    }, { get: (t, k) => (k in t ? t[k] : hollow("window")[k]) }),

    workspace: new Proxy({
      get workspaceFolders() { return folders(); },
      get rootPath() { return host.root || undefined; },
      get name() { return host.root ? path.basename(host.root) : undefined; },
      get textDocuments() { return [...host.documents.values()]; },
      notebookDocuments: [],
      isTrusted: true,
      workspaceFile: undefined,
      getWorkspaceFolder: (uri) => folders()?.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
      asRelativePath: (target) => { const p = typeof target === "string" ? target : target.fsPath; return host.root && p.startsWith(host.root) ? path.relative(host.root, p) : p; },
      getConfiguration: (section) => configuration(section),
      openTextDocument: openDocument,
      createFileSystemWatcher: watcher,
      findFiles: async () => [],
      // Edits an extension asks for (a quick fix run as a command, say) go to the editor.
      applyEdit: async (edit) => host.applyEdit(edit),
      saveAll: async () => true,
      registerTextDocumentContentProvider: () => new Disposable(() => {}),
      registerFileSystemProvider: () => new Disposable(() => {}),
      onDidOpenTextDocument: event("open"), onDidCloseTextDocument: event("close"),
      onDidChangeTextDocument: event("change"), onDidSaveTextDocument: event("save"),
      onWillSaveTextDocument: event("willSave"), onDidChangeConfiguration: event("configuration"),
      onDidChangeWorkspaceFolders: event("folders"), onDidGrantWorkspaceTrust: event("trust"),
      onDidCreateFiles: event("filesCreated"), onDidRenameFiles: event("filesRenamed"), onDidDeleteFiles: event("filesDeleted"),
      onWillCreateFiles: event("filesWillCreate"), onWillRenameFiles: event("filesWillRename"), onWillDeleteFiles: event("filesWillDelete"),
      onDidOpenNotebookDocument: event("nbOpen"), onDidCloseNotebookDocument: event("nbClose"),
      onDidChangeNotebookDocument: event("nbChange"), onDidSaveNotebookDocument: event("nbSave"),
      fs: {
        readFile: async (uri) => new Uint8Array(await fs.promises.readFile(uri.fsPath)),
        writeFile: (uri, data) => fs.promises.writeFile(uri.fsPath, data),
        stat: async (uri) => { const s = await fs.promises.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; },
        readDirectory: async (uri) => (await fs.promises.readdir(uri.fsPath, { withFileTypes: true })).map((e) => [e.name, e.isDirectory() ? 2 : 1]),
        createDirectory: (uri) => fs.promises.mkdir(uri.fsPath, { recursive: true }),
        isWritableFileSystem: () => true,
      },
    }, { get: (t, k) => (k in t ? t[k] : hollow("workspace")[k]) }),

    languages: new Proxy({
      match: matches,
      createDiagnosticCollection: diagnosticCollection,
      getDiagnostics: () => [],
      getLanguages: async () => [],
      setTextDocumentLanguage: async (doc) => doc,
      onDidChangeDiagnostics: event("diagnostics"),
      createLanguageStatusItem: () => ({ dispose() {} }),
      setLanguageConfiguration: () => new Disposable(() => {}),
      registerCompletionItemProvider: register("completion"),
      registerHoverProvider: register("hover"),
      registerDefinitionProvider: register("definition"),
      registerDocumentFormattingEditProvider: register("format"),
    }, {
      // Every other register*Provider is accepted and kept, ready for when Runes asks for it.
      get: (t, k) => (k in t ? t[k] : typeof k === "string" && k.startsWith("register") ? (t[k] = register(k)) : hollow("languages")[k]),
    }),

    env: {
      appName: "Runes", appRoot: host.appRoot, appHost: "desktop", language: "en", uriScheme: "runes",
      machineId: "runes", sessionId: String(Date.now()), remoteName: undefined, uiKind: 1, shell: process.env.SHELL ?? "",
      isNewAppInstall: false, isTelemetryEnabled: false, onDidChangeTelemetryEnabled: event("telemetry"),
      logLevel: 3, onDidChangeLogLevel: event("logLevel"), onDidChangeShell: event("shell"),
      clipboard: { readText: async () => "", writeText: async () => {} },
      openExternal: async () => false, asExternalUri: async (uri) => uri,
      createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {}, onDidChangeEnableStates: event("telemetryStates"), isUsageEnabled: false, isErrorsEnabled: false }),
    },

    extensions: {
      getExtension: (id) => host.extensions.get(id),
      get all() { return [...host.extensions.values()]; },
      onDidChange: event("extensions"),
    },

    l10n: { t: (message, ...args) => String(typeof message === "string" ? message : message.message).replace(/\{(\d+)\}/g, (_, i) => String((Array.isArray(args[0]) ? args[0] : args)[i])), bundle: undefined, uri: undefined },
  };

  return new Proxy(api, {
    get(target, key) {
      if (key in target || typeof key !== "string") return target[key];
      // An API type or namespace Runes does not have yet.
      return (target[key] = /^[A-Z]/.test(key) ? standIn(key) : hollow(key));
    },
  });
}

module.exports = { create, TextDocument, Position, Range, URI, EventEmitter, CancellationTokenSource, matches, VERSION };
