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
  EnvironmentVariableMutatorType: { Replace: 1, Append: 2, Prepend: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  TerminalShellExecutionCommandLineConfidence: { Low: 0, Medium: 1, High: 2 },
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  DebugConsoleMode: { Separate: 0, MergeWithParent: 1 },
  DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
  ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  TextEditorLineNumbersStyle: { Off: 0, On: 1, Relative: 2, Interval: 3 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
  FilePermission: { Readonly: 1 },
  ExtensionRuntime: { Node: 1, Webworker: 2 },
  NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  NotebookControllerAffinity: { Default: 1, Preferred: 2 },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  SyntaxTokenType: { Other: 0, Comment: 1, String: 2, RegEx: 3 },
  DocumentPasteTriggerKind: { Automatic: 0, PasteAs: 1 },
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
  TelemetryTrustedValue: class { constructor(value) { this.value = value; } },
  PortAutoForwardAction: { Notify: 1, OpenBrowser: 2, OpenPreview: 3, Silent: 4, Ignore: 5 },
};

/** A class for an API type Runes has no use for: it keeps what it is given. */
function standIn(name) {
  const cls = { [name]: class { constructor(...args) { this.args = args; } dispose() {} } }[name];
  // A static of such a type may be a value (an enum's member) or a maker (`Kind.Of(...)`):
  // what is handed out serves as both.
  const member = (k) => Object.assign(function (...args) { return new cls(...args); }, { toString: () => name + "." + k, value: k });
  return new Proxy(cls, { get: (t, k) => (k in t ? t[k] : typeof k === "string" && /^[A-Z]/.test(k) ? (t[k] = member(k)) : undefined) });
}

/**
 * Something an extension was handed for a part of the editor Runes does not have (a test
 * controller, a tree view, a status item): whatever is asked of it, it takes, and does nothing.
 */
function nothing(name = "") {
  const kept = {};
  const target = function () {};
  return new Proxy(target, {
    get(_t, k) {
      if (k === "then" || k === "toJSON") return undefined;
      if (k === Symbol.iterator) return function* () {};
      if (k === Symbol.toPrimitive) return () => "";
      if (typeof k !== "string") return undefined;
      if (k in kept) return kept[k];
      if (k === "dispose") return () => {};
      if (/^on[A-Z]/.test(k)) return (kept[k] = new EventEmitter().event);
      return (kept[k] = nothing(k));
    },
    set(_t, k, v) { kept[k] = v; return true; },
    has: () => true,
    apply: () => (/^(create|register|get[A-Z]|add|push)/.test(name) ? nothing() : undefined),
    construct: () => nothing(),
  });
}

class FileSystemError extends Error {
  constructor(messageOrUri, code = "Unknown") {
    super(typeof messageOrUri === "string" ? messageOrUri : messageOrUri?.toString?.(true) ?? code);
    this.name = code === "Unknown" ? "FileSystemError" : `${code} (FileSystemError)`;
    this.code = code;
  }
}
for (const code of ["FileNotFound", "FileExists", "FileNotADirectory", "FileIsADirectory", "NoPermissions", "Unavailable"]) {
  FileSystemError[code] = (messageOrUri) => new FileSystemError(messageOrUri, code);
}
/** A failure of Node's fs, as the error an extension expects of `workspace.fs`. */
const fsError = (e, uri) => {
  const code = { ENOENT: "FileNotFound", EEXIST: "FileExists", ENOTDIR: "FileNotADirectory", EISDIR: "FileIsADirectory", EACCES: "NoPermissions", EPERM: "NoPermissions" }[e?.code];
  return code ? FileSystemError[code](uri) : e;
};

class TreeItem { constructor(label, collapsibleState = 0) { if (label?.scheme) this.resourceUri = label; else this.label = label; this.collapsibleState = collapsibleState; } }
class ShellExecution { constructor(commandLine, args, options) { this.commandLine = commandLine; if (Array.isArray(args)) { this.command = commandLine; this.args = args; this.options = options; } else this.options = args; } }
class ProcessExecution { constructor(process, args, options) { this.process = process; if (Array.isArray(args)) { this.args = args; this.options = options; } else { this.args = []; this.options = args; } } }
class CustomExecution { constructor(callback) { this.callback = callback; } }
class Task { constructor(definition, scope, name, source, execution, problemMatchers) { Object.assign(this, { definition, scope, name, source, execution, problemMatchers: [].concat(problemMatchers ?? []), isBackground: false, presentationOptions: {}, runOptions: {} }); } }
class TaskGroup { constructor(id, label) { this.id = id; this.label = label; } }
Object.assign(TaskGroup, { Clean: new TaskGroup("clean", "Clean"), Build: new TaskGroup("build", "Build"), Rebuild: new TaskGroup("rebuild", "Rebuild"), Test: new TaskGroup("test", "Test") });
class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelToolResult { constructor(content) { this.content = content; } }
class TestMessage { constructor(message) { this.message = message; } static diff(message, expected, actual) { return Object.assign(new TestMessage(message), { expectedOutput: expected, actualOutput: actual }); } }
class TestTag { constructor(id) { this.id = id; } }
class TestRunRequest { constructor(include, exclude, profile, continuous = false) { Object.assign(this, { include, exclude, profile, continuous }); } }
class DebugAdapterExecutable { constructor(command, args = [], options) { Object.assign(this, { command, args, options }); } }
class DebugAdapterServer { constructor(port, host) { this.port = port; this.host = host; } }
class DebugAdapterInlineImplementation { constructor(implementation) { this.implementation = implementation; } }
class QuickInputButtons {}
QuickInputButtons.Back = { iconPath: new (class { constructor() { this.id = "arrow-left"; } })() };
class DataTransferItem { constructor(value) { this.value = value; } asString() { return Promise.resolve(String(this.value)); } asFile() { return undefined; } }
class DataTransfer { constructor() { this._items = new Map(); } get(k) { return this._items.get(k); } set(k, v) { this._items.set(k, v); } forEach(f) { this._items.forEach((v, k) => f(v, k, this)); } [Symbol.iterator]() { return this._items[Symbol.iterator](); } }
class NotebookRange { constructor(start, end) { this.start = start; this.end = end; } get isEmpty() { return this.start === this.end; } }
class NotebookCellData { constructor(kind, value, languageId) { Object.assign(this, { kind, value, languageId }); } }
class InlineCompletionItem { constructor(insertText, range, command) { Object.assign(this, { insertText, range, command }); } }
class EvaluatableExpression { constructor(range, expression) { this.range = range; this.expression = expression; } }
class InlineValueText { constructor(range, text) { this.range = range; this.text = text; } }
class InlineValueVariableLookup { constructor(range, variableName, caseSensitiveLookup = true) { Object.assign(this, { range, variableName, caseSensitiveLookup }); } }
class InlineValueEvaluatableExpression { constructor(range, expression) { this.range = range; this.expression = expression; } }
class TerminalLink { constructor(startIndex, length, tooltip) { Object.assign(this, { startIndex, length, tooltip }); } }
class TerminalProfile { constructor(options) { this.options = options; } }
class FileDecoration { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } }
class Breakpoint { constructor(enabled = true, condition, hitCondition, logMessage) { Object.assign(this, { enabled, condition, hitCondition, logMessage }); } }
class SourceBreakpoint extends Breakpoint { constructor(location, ...rest) { super(...rest); this.location = location; } }
class FunctionBreakpoint extends Breakpoint { constructor(functionName, ...rest) { super(...rest); this.functionName = functionName; } }
const classes = { FileSystemError, TreeItem, ShellExecution, ProcessExecution, CustomExecution, Task, TaskGroup, TabInputText, TabInputTextDiff, LanguageModelTextPart, LanguageModelToolResult,
  TestMessage, TestTag, TestRunRequest, DebugAdapterExecutable, DebugAdapterServer, DebugAdapterInlineImplementation, QuickInputButtons, DataTransferItem, DataTransfer,
  NotebookRange, NotebookCellData, InlineCompletionItem, EvaluatableExpression, InlineValueText, InlineValueVariableLookup, InlineValueEvaluatableExpression,
  TerminalLink, TerminalProfile, FileDecoration, Breakpoint, SourceBreakpoint, FunctionBreakpoint };

/** A language configuration as plain JSON: patterns as { pattern, flags }, actions by name. */
function plainRules(configuration) {
  const pattern = (r) => (r instanceof RegExp ? { pattern: r.source, flags: r.flags } : typeof r === "string" ? r : r && typeof r.pattern === "string" ? { pattern: r.pattern, flags: String(r.flags ?? "") } : undefined);
  const names = ["none", "indent", "indentOutdent", "outdent"];
  const out = {};
  if (Array.isArray(configuration?.brackets)) out.brackets = configuration.brackets.filter((b) => Array.isArray(b)).map((b) => [String(b[0]), String(b[1])]);
  if (Array.isArray(configuration?.onEnterRules)) {
    out.onEnterRules = configuration.onEnterRules.slice(0, 200).map((rule) => ({
      beforeText: pattern(rule.beforeText), afterText: pattern(rule.afterText), previousLineText: pattern(rule.previousLineText),
      action: { indent: typeof rule.action?.indentAction === "number" ? names[rule.action.indentAction] ?? "none" : String(rule.action?.indent ?? "none"), appendText: rule.action?.appendText, removeText: rule.action?.removeText },
    })).filter((rule) => rule.beforeText);
  }
  const indentation = configuration?.indentationRules;
  if (indentation) out.indentationRules = { increaseIndentPattern: pattern(indentation.increaseIndentPattern), decreaseIndentPattern: pattern(indentation.decreaseIndentPattern) };
  return out;
}

const safeJson = (value) => { try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } };

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

  // What an extension writes to an output channel goes to the window's list of running
  // extensions, under the extension's own name.
  const channel = (name) => {
    const say = (text) => host.send({ type: "output", extension: extension.id, channel: String(name).slice(0, 80), text: String(text).slice(0, 4000) });
    const line = (prefix) => (...parts) => say(prefix + parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? p.stack ?? p.message : safeJson(p))).join(" "));
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
      inspect: (k) => ({ key: key(k), defaultValue: defaults[key(k)], globalValue: host.settings[key(k)], workspaceValue: undefined, workspaceFolderValue: undefined, languageIds: [] }),
      // A setting an extension changes holds for the session; settings.json is the person's own.
      update: (k, value) => { if (value === undefined) delete host.settings[key(k)]; else host.settings[key(k)] = value; return Promise.resolve(); },
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
  // Real when the host can follow the disk (see host.watch); otherwise a watcher that never fires.
  const watcher = (pattern, ignoreCreate, ignoreChange, ignoreDelete) => host.watch?.(pattern, ignoreCreate, ignoreChange, ignoreDelete) ?? ({
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
  const hollows = {};
  const hollow = (name) => (hollows[name] ??= new Proxy({}, {
    get: (t, k) => {
      if (typeof k !== "string") return undefined;
      if (k in t) return t[k];
      if (/^on[A-Z]/.test(k)) return (t[k] = new EventEmitter().event);
      // What makes or registers something hands back a thing that can be used and disposed of;
      // anything else is a call that does nothing.
      return (t[k] = (...args) => (/^(register|create)/.test(k) ? nothing() : undefined));
    },
    set: (t, k, v) => { t[k] = v; return true; },
  }));

  const testItems = () => { const m = new Map(); return { get size() { return m.size; }, add: (i) => m.set(i.id, i), delete: (id) => m.delete(id), get: (id) => m.get(id), replace: (items) => { m.clear(); for (const i of items) m.set(i.id, i); }, forEach: (f) => m.forEach((v) => f(v)), [Symbol.iterator]: () => [...m].map(([k, v]) => [k, v])[Symbol.iterator]() }; };
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
    ...classes,
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
      createStatusBarItem: () => ({ text: "", tooltip: "", command: undefined, name: "", color: undefined, backgroundColor: undefined, accessibilityInformation: undefined, alignment: 1, priority: 0, show() {}, hide() {}, dispose() {} }),
      createQuickPick: () => Object.assign(nothing(), { items: [], activeItems: [], selectedItems: [], buttons: [], value: "" }),
      createInputBox: () => Object.assign(nothing(), { value: "", buttons: [] }),
      createTerminal: () => nothing(),
      get activeTerminal() { return undefined; },
      get activeNotebookEditor() { return undefined; },
      visibleNotebookEditors: [],
      registerTreeDataProvider: () => new Disposable(() => {}),
      createTreeView: () => Object.assign(nothing(), { selection: [], visible: false, reveal: async () => {} }),
      registerUriHandler: () => new Disposable(() => {}),
      registerTerminalLinkProvider: () => new Disposable(() => {}),
      registerTerminalProfileProvider: () => new Disposable(() => {}),
      registerFileDecorationProvider: () => new Disposable(() => {}),
      registerWebviewViewProvider: () => new Disposable(() => {}),
      registerCustomEditorProvider: () => new Disposable(() => {}),
      showOpenDialog: async () => undefined, showSaveDialog: async () => undefined, showWorkspaceFolderPick: async () => undefined,
      withProgress: async (_options, task) => task({ report() {} }, new CancellationTokenSource().token),
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
      findFiles: async (include, _exclude, max) => host.findFiles(typeof include === "string" ? include : include?.pattern ?? "", typeof include === "object" && include?.base ? include.base : host.root, max),
      updateWorkspaceFolders: () => false,
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
        readFile: async (uri) => new Uint8Array(await fs.promises.readFile(uri.fsPath).catch((e) => { throw fsError(e, uri); })),
        writeFile: (uri, data) => fs.promises.writeFile(uri.fsPath, data).catch((e) => { throw fsError(e, uri); }),
        stat: async (uri) => {
          const s = await fs.promises.stat(uri.fsPath).catch((e) => { throw fsError(e, uri); });
          const link = await fs.promises.lstat(uri.fsPath).then((l) => l.isSymbolicLink(), () => false);
          return { type: (s.isDirectory() ? 2 : s.isFile() ? 1 : 0) | (link ? 64 : 0), ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
        },
        readDirectory: async (uri) => (await fs.promises.readdir(uri.fsPath, { withFileTypes: true }).catch((e) => { throw fsError(e, uri); }))
          .map((e) => [e.name, e.isSymbolicLink() ? 64 : e.isDirectory() ? 2 : e.isFile() ? 1 : 0]),
        createDirectory: (uri) => fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined, (e) => { throw fsError(e, uri); }),
        delete: (uri, options) => fs.promises.rm(uri.fsPath, { recursive: !!options?.recursive }).catch((e) => { throw fsError(e, uri); }),
        rename: async (from, to, options) => {
          if (!options?.overwrite && fs.existsSync(to.fsPath)) throw FileSystemError.FileExists(to);
          await fs.promises.rename(from.fsPath, to.fsPath).catch((e) => { throw fsError(e, from); });
        },
        copy: (from, to, options) => fs.promises.cp(from.fsPath, to.fsPath, { recursive: true, force: !!options?.overwrite, errorOnExist: !options?.overwrite }).catch((e) => { throw fsError(e, from); }),
        isWritableFileSystem: (scheme) => (scheme === "file" ? true : undefined),
      },
    }, { get: (t, k) => (k in t ? t[k] : hollow("workspace")[k]) }),

    languages: new Proxy({
      match: matches,
      createDiagnosticCollection: diagnosticCollection,
      getDiagnostics: () => [],
      getLanguages: async () => host.languages ?? [],
      setTextDocumentLanguage: async (doc) => doc,
      onDidChangeDiagnostics: event("diagnostics"),
      createLanguageStatusItem: (id, selector) => ({ id, selector, name: "", text: "", detail: "", severity: 0, busy: false, command: undefined, accessibilityInformation: undefined, dispose() {} }),
      // What an extension says about a language as it runs (Python's rules for Enter come this
      // way) is handed to the editor, as the same JSON a language-configuration.json holds.
      setLanguageConfiguration: (language, configuration) => {
        try { host.send({ type: "language", language: String(language), rules: JSON.stringify(plainRules(configuration)).slice(0, 200000) }); } catch {}
        return new Disposable(() => {});
      },
      registerCompletionItemProvider: register("completion"),
      registerHoverProvider: register("hover"),
      registerDefinitionProvider: register("definition"),
      registerDocumentFormattingEditProvider: register("format"),
      registerSignatureHelpProvider: register("signature"),
      registerDocumentSymbolProvider: register("symbols"),
    }, {
      // Every other register*Provider is accepted and kept, ready for when Runes asks for it.
      get: (t, k) => (k in t ? t[k] : typeof k === "string" && k.startsWith("register") ? (t[k] = register(k)) : hollow("languages")[k]),
    }),

    env: {
      appName: "Runes", appRoot: host.appRoot, appHost: "desktop", language: "en", uriScheme: "runes",
      machineId: "runes", sessionId: String(Date.now()), remoteName: undefined, uiKind: 1, shell: process.env.SHELL ?? "",
      isNewAppInstall: false, isTelemetryEnabled: false, onDidChangeTelemetryEnabled: event("telemetry"),
      logLevel: 3, onDidChangeLogLevel: event("logLevel"), onDidChangeShell: event("shell"),
      appQualityName: "stable",
      clipboard: { readText: async () => "", writeText: async () => {} },
      openExternal: async () => false, asExternalUri: async (uri) => uri,
      createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {}, onDidChangeEnableStates: event("telemetryStates"), isUsageEnabled: false, isErrorsEnabled: false }),
    },

    extensions: {
      getExtension: (id) => host.extensions.get(id),
      get all() { return [...host.extensions.values()]; },
      onDidChange: event("extensions"),
    },

    // Parts of VS Code that Runes has no counterpart for. They are named so that an extension
    // finds the shape it expects: what it registers is taken and never called.
    tests: Object.assign(hollow("tests"), { testResults: [], createTestController: (id, label) => Object.assign(nothing(), { id, label, items: testItems(), createTestItem: (itemId, itemLabel, uri) => ({ id: itemId, label: itemLabel, uri, children: testItems(), tags: [], canResolveChildren: false, busy: false }) }) }),
    lm: Object.assign(hollow("lm"), { tools: [], selectChatModels: async () => [], registerTool: () => new Disposable(() => {}), invokeTool: async () => ({ content: [] }) }),
    chat: Object.assign(hollow("chat"), { createChatParticipant: () => nothing() }),
    debug: Object.assign(hollow("debug"), { breakpoints: [], activeDebugSession: undefined, activeDebugConsole: { append() {}, appendLine() {} }, startDebugging: async () => false, stopDebugging: async () => {} }),
    tasks: Object.assign(hollow("tasks"), { taskExecutions: [], fetchTasks: async () => [], executeTask: async () => nothing(), registerTaskProvider: () => new Disposable(() => {}) }),
    notebooks: hollow("notebooks"), scm: hollow("scm"), comments: hollow("comments"), authentication: Object.assign(hollow("authentication"), { getSession: async () => undefined, getAccounts: async () => [] }),

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

module.exports = { create, TextDocument, Position, Range, Selection, URI, EventEmitter, CancellationTokenSource, matches, VERSION };
