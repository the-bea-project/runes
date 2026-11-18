// Where text stands: cell widths, wrapping, folds, indentation and the rules for Enter.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/runes_layout.mjs";

const PY = JSON.stringify({
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  onEnterRules: [
    { beforeText: "^\\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async|match|case).*?:\\s*$", action: { indent: "indent" } },
    { beforeText: "^\\s+(?:pass|return|raise|break|continue)\\b.*$", action: { indent: "outdent" } },
  ],
});

test("cells: ASCII is one each, tabs run to the next stop, wide characters take two", () => {
  L.set_tab(4);
  assert.equal(L.vcol("hello", 3), 3);
  assert.equal(L.vcol("\tx", 1), 4);
  assert.equal(L.vcol("ab\tx", 3), 4);
  assert.equal(L.vcol("日本語", 2), 4);
  assert.equal(L.vcol("a😀b", 3), 3, "an emoji is two units and two cells");
  assert.equal(L.vcol("x👨‍👩‍👧y", "x👨‍👩‍👧".length), 3, "a family is one character of two cells");
  assert.equal(L.vcol("éx", 2), 1, "a letter and its accent are one cell");
  assert.equal(L.vcol("🇮🇳!", 4), 2);
  L.set_tab(8);
  assert.equal(L.vcol("\tx", 1), 8);
  L.set_tab(4);
});

test("a cursor never stands inside a character", () => {
  const text = "a😀é👨‍👩‍👧z";
  const stops = [0];
  while (stops.at(-1) < text.length) stops.push(L.step(text, stops.at(-1), true));
  assert.deepEqual(stops, [0, 1, 3, 5, 5 + "👨‍👩‍👧".length, text.length]);
  const back = [text.length];
  while (back.at(-1) > 0) back.push(L.step(text, back.at(-1), false));
  assert.deepEqual(back.reverse(), stops);
  assert.equal(L.step("abc", 3, true), 3);
  assert.equal(L.step("abc", 0, false), 0);
});

test("a click lands on the nearest character edge, by cells", () => {
  assert.equal(L.col_at("日本語", 1.2), 1, "past the middle of the first wide character");
  assert.equal(L.col_at("日本語", 0.8), 0);
  assert.equal(L.col_at("\tx", 1), 0);
  assert.equal(L.col_at("\tx", 3), 1);
  assert.equal(L.col_at("abc", 99), 3);
  for (const text of ["a😀b", "日本語 text", "x\ty\tz", "plain"]) {
    for (let c = 0; c <= text.length; c = c === text.length ? c + 1 : L.step(text, c, true)) assert.equal(L.col_at(text, L.vcol(text, c)), c, text + " at " + c);
  }
});

test("characters that may not fit their cells are boxed; plain text is left alone", () => {
  const plain = [["let x = 1", "color:red"]];
  assert.equal(L.fitted(plain, "let x = 1", 0, 9), plain);
  const out = L.fitted([["a日😀b", "color:red"]], "a日😀b", 0, 99);
  assert.deepEqual(out.map((p) => p[0]), ["a", "日", "😀", "b"]);
  assert.match(out[1][1], /^color:red;display:inline-block;width:2ch/);
  assert.equal(out[0][1], "color:red");
  // A slice of the pieces, for one row of a wrapped line.
  assert.deepEqual(L.fitted([["abc", "a"], ["def", "b"]], "abcdef", 2, 5), [["c", "a"], ["de", "b"]]);
  assert.deepEqual(L.fitted([["héllo ünïcode", ""]], "héllo ünïcode", 0, 99), [["héllo ünïcode", ""]], "accented Latin is the font's own");
});

test("indentation is read from the file", () => {
  assert.equal(L.detect_indent(["def f():", "    x = 1", "    if x:", "        y = 2"]), "    ");
  assert.equal(L.detect_indent(["a {", "  b {", "    c", "  }", "}"]), "  ");
  assert.equal(L.detect_indent(["a {", "\tb {", "\t\tc", "\t}", "}"]), "\t");
  assert.equal(L.detect_indent(["no", "indentation", "here"]), "");
  assert.equal(L.detect_indent([]), "");
  assert.equal(L.detect_indent(["/**", " * a comment", " */", "x {", "    y", "}"]), "    ", "one space of a comment is not a step");
});

test("Enter follows the language: Python's colon, brackets, and lines that end a block", () => {
  assert.deepEqual(L.enter_rule(PY, "def greet(name):", "", ""), [1, "", 0]);
  assert.deepEqual(L.enter_rule(PY, "    if x > 1:  ", "", ""), [1, "", 0]);
  assert.deepEqual(L.enter_rule(PY, "    return x", "", ""), [3, "", 0]);
  assert.deepEqual(L.enter_rule(PY, "x = 1", "", ""), [0, "", 0]);
  assert.deepEqual(L.enter_rule(PY, "items = [", "]", ""), [2, "", 0]);
  assert.deepEqual(L.enter_rule(PY, "call(", "", ""), [1, "", 0]);
  // No configuration at all: brackets still work.
  assert.deepEqual(L.enter_rule("", "fn main() {", "}", ""), [2, "", 0]);
  assert.deepEqual(L.enter_rule("", "plain", "", ""), [0, "", 0]);
  // A comment's continuation, as languages with /** */ ask for it.
  const C = JSON.stringify({ onEnterRules: [{ beforeText: { pattern: "^\\s*/\\*\\*(?!/)([^*]|\\*(?!/))*$" }, afterText: "^\\s*\\*/$", action: { indentAction: "indentOutdent", appendText: " * " } }] });
  assert.deepEqual(L.enter_rule(C, "/**", " */", ""), [2, " * ", 0]);
  // A broken pattern in someone's extension is passed over, not thrown.
  assert.deepEqual(L.enter_rule(JSON.stringify({ onEnterRules: [{ beforeText: "([", action: { indent: "indent" } }] }), "x", "", ""), [0, "", 0]);
  assert.deepEqual(L.enter_rule("{ not json", "x {", "", ""), [1, "", 0]);
});

test("a closing line is drawn back", () => {
  assert.ok(L.outdents("", "    }"));
  assert.ok(!L.outdents("", "    x }"));
  const rules = JSON.stringify({ indentationRules: { decreaseIndentPattern: "^\\s*(else|elif .*):\\s*$" } });
  assert.ok(L.outdents(rules, "        else:"));
  assert.ok(!L.outdents(rules, "        elsewhere"));
});

test("brackets are paired across lines, by nesting", () => {
  const lines = ["fn f(a, (b)) {", "  [1, 2]", "}"];
  assert.deepEqual(L.bracket_pair(lines, 0, 13, ""), [true, 0, 13, 2, 0]);
  assert.deepEqual(L.bracket_pair(lines, 2, 1, ""), [true, 0, 13, 2, 0], "just after the closing one");
  assert.deepEqual(L.bracket_pair(lines, 0, 4, ""), [true, 0, 4, 0, 11]);
  assert.deepEqual(L.bracket_pair(lines, 0, 8, ""), [true, 0, 8, 0, 10]);
  assert.equal(L.bracket_pair(lines, 1, 0, "")[0], false);
  assert.equal(L.bracket_pair(["(("], 0, 0, "")[0], false, "nothing closes it");
});

test("blocks are found by indentation, and blank lines do not end them", () => {
  const lines = ["def a():", "    x = 1", "", "    if x:", "        y", "", "def b():", "    pass", ""];
  const t = L.shape("k", 1, lines);
  assert.equal(L.fold_end(t, 0), 4);
  assert.equal(L.fold_end(t, 3), 4);
  assert.equal(L.fold_end(t, 1), -1);
  assert.equal(L.fold_end(t, 6), 7);
  assert.equal(L.depth_of(t, 2), 4, "a blank line inside a block is as deep as the block");
  assert.equal(L.depth_of(t, 5), 0);
  assert.equal(L.block_of(t, 4), 3);
  assert.equal(L.block_of(t, 1), 0);
  assert.equal(L.block_of(t, 6), 6, "a line that opens a block stands for that block");
  assert.equal(L.block_of(t, 8), -1);
  assert.deepEqual(L.all_blocks(t), [[0, 4], [6, 7]]);
  assert.equal(L.shape("k", 1, ["changed"]), t, "the same edit of the file is not measured twice");
});

test("folds keep their place when lines are added or removed around them", () => {
  const before = ["a", "b {", "  c", "}", "d {", "  e", "}"];
  const folds = [[1, 2], [4, 5]];
  assert.deepEqual(L.folds_after(folds, before, ["new", ...before]), [[2, 3], [5, 6]]);
  assert.deepEqual(L.folds_after(folds, before, before.filter((_, i) => i !== 3)), [[1, 2], [3, 4]]);
  // Typing inside a folded block opens it; the one below only moves.
  assert.deepEqual(L.folds_after(folds, before, ["a", "b {", "  changed", "}", "d {", "  e", "}"]), [[4, 5]]);
  // Typing on the opening line leaves it folded.
  assert.deepEqual(L.folds_after(folds, before, ["a", "b  {", "  c", "}", "d {", "  e", "}"]), folds);
  assert.deepEqual(L.folds_after([], before, ["x"]), []);
});

test("a layout with nothing folded or wrapped is the lines themselves", () => {
  const lines = ["one", "two\tx", "three"];
  const l = L.layout(1, "f", 1, lines, 0, []);
  assert.equal(L.layout_rows(l), 3);
  assert.deepEqual(L.spot(l, 1, 4), [1, 4]);
  assert.deepEqual(L.place(l, 2, 2), [2, 2, false]);
  assert.deepEqual(L.place(l, 2, 9), [2, 5, true]);
  assert.deepEqual(L.rows_from(l, 1, 5), [[1, 1, 0, 5, 0, 1], [2, 2, 0, 5, 0, 1]]);
  assert.deepEqual(L.vertical(l, 0, 3, -1, 1), [1, 3, 3]);
  assert.deepEqual(L.vertical(l, 0, 3, -1, 99), [2, 3, 3]);
  assert.equal(L.layout(1, "f", 1, ["other"], 0, []), l, "kept until something changes");
  assert.notEqual(L.layout(1, "f", 2, lines, 0, []), l);
});

test("folded lines take no rows, and the cursor steps over them", () => {
  const lines = ["a {", "  b", "  c", "}", "e"];
  const l = L.layout(2, "f", 1, lines, 0, [[0, 2]]);
  assert.equal(L.layout_rows(l), 3);
  assert.deepEqual(L.rows_from(l, 0, 9).map((r) => r[1]), [0, 3, 4]);
  assert.ok(L.is_hidden(l, 1) && L.is_hidden(l, 2) && !L.is_hidden(l, 3));
  assert.equal(L.row_of(l, 3), 1);
  assert.deepEqual(L.vertical(l, 0, 1, -1, 1), [3, 1, 1], "down from the fold goes to the line after it");
  assert.deepEqual(L.vertical(l, 3, 0, -1, -1), [0, 0, 0]);
  assert.deepEqual(L.place(l, 2, 0), [4, 0, false]);
  assert.deepEqual(L.spans(l, 1, 0, 3), [], "nothing is drawn for a hidden line");
});

test("long lines wrap at spaces when they can, and every place has one row", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  assert.deepEqual(L.wrap_points(text, 16), [0, 16, 31]);
  assert.equal(L.wrap_points("short", 16), null);
  assert.deepEqual(L.wrap_points("x".repeat(25), 10), [0, 10, 20], "a word longer than the row is cut");
  assert.deepEqual(L.wrap_points("日本語日本語日本語", 8), [0, 4, 8], "wide characters fill a row in half as many");
  const lines = ["first", text, "last"];
  const l = L.layout(3, "f", 1, lines, 16, []);
  assert.equal(L.layout_rows(l), 5);
  assert.deepEqual(L.rows_from(l, 0, 9).map((r) => [r[0], r[1], r[2], r[3]]), [[0, 0, 0, 5], [1, 1, 0, 16], [2, 1, 16, 31], [3, 1, 31, 43], [4, 2, 0, 4]]);
  assert.deepEqual(L.spot(l, 1, 20), [2, 4]);
  assert.deepEqual(L.spot(l, 2, 1), [4, 1]);
  // Down a row inside the one line, keeping the column; then on to the next line.
  assert.deepEqual(L.vertical(l, 1, 3, -1, 1), [1, 19, 3]);
  assert.deepEqual(L.vertical(l, 1, 19, 3, 1), [1, 34, 3]);
  assert.deepEqual(L.vertical(l, 1, 34, 3, 1), [2, 3, 3]);
  assert.deepEqual(L.vertical(l, 2, 3, 3, -1), [1, 34, 3]);
  // A selection across the wrap is one box per row.
  assert.deepEqual(L.spans(l, 1, 10, 34), [[1, 10, 6], [2, 0, 15], [3, 0, 3]]);
  // Clicking past the end of a wrapped row stays on that row.
  const [line, col] = L.place(l, 1, 99);
  assert.deepEqual([line, col], [1, 15]);
  assert.deepEqual(L.spot(l, line, col)[0], 1);
  // Every column of every line maps to a row and back.
  for (let n = 0; n < lines.length; n++) for (let c = 0; c <= lines[n].length; c++) {
    const [row, left] = L.spot(l, n, c);
    const [bl, bc] = L.place(l, row, left);
    assert.ok(bl === n && bc === c, `${n}:${c} came back as ${bl}:${bc}`);
  }
});

test("wrapping and folding together", () => {
  const lines = ["a {", "  " + "word ".repeat(10), "}", "tail " + "x".repeat(30)];
  const l = L.layout(4, "f", 1, lines, 20, [[0, 1]]);
  assert.deepEqual(L.rows_from(l, 0, 9).map((r) => r[1]), [0, 2, 3, 3, 3]);
  assert.equal(L.layout_rows(l), 5);
});

test("merge conflicts are found by git's markers, and settled either way or both", () => {
  const lines = ["a", "<<<<<<< HEAD", "ours 1", "ours 2", "=======", "theirs", ">>>>>>> feature/x", "b", "<<<<<<< HEAD", "x", "||||||| base", "was", "=======", "y", ">>>>>>> other", "======="];
  const t = L.conflicts("c", 1, lines);
  assert.equal(L.conflict_count(t), 2);
  assert.deepEqual(L.conflict_list(t), [[1, 6, "HEAD", "feature/x"], [8, 14, "HEAD", "other"]]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => L.conflict_kind(t, n)), [0, 1, 2, 2, 1, 3, 1, 0]);
  assert.deepEqual([9, 10, 11, 12, 13].map((n) => L.conflict_kind(t, n)), [2, 1, 4, 1, 3], "what both began from is its own part");
  assert.equal(L.conflict_kind(t, 15), 0, "a row of equals signs alone is not a conflict");
  assert.deepEqual(L.conflict_taken(t, lines, 0, "ours"), [1, 6, ["ours 1", "ours 2"]]);
  assert.deepEqual(L.conflict_taken(t, lines, 0, "theirs"), [1, 6, ["theirs"]]);
  assert.deepEqual(L.conflict_taken(t, lines, 0, "both"), [1, 6, ["ours 1", "ours 2", "theirs"]]);
  assert.deepEqual(L.conflict_taken(t, lines, 1, "ours"), [8, 14, ["x"]], "the common ancestor is never kept");
  assert.equal(L.conflict_taken(t, lines, 5, "ours"), null);
  assert.equal(L.conflict_at(t, 3, false), 0);
  assert.equal(L.conflict_at(t, 7, false), -1);
  assert.equal(L.conflict_at(t, 3, true), 1);
  assert.equal(L.conflict_at(t, 20, true), 0, "after the last, the next is the first again");
  assert.equal(L.conflict_count(L.conflicts("d", 1, ["<<<<<<< HEAD", "never closed", "======="])), 0);
  assert.equal(L.conflict_count(L.conflicts("e", 1, ["<<<<<<<HEAD", "=======", ">>>>>>>x"])), 0, "markers are seven signs and then a space or nothing");
});

test("rules an extension gives as it runs come before the language's own", () => {
  const own = JSON.stringify({ brackets: [["{", "}"]], onEnterRules: [{ beforeText: ":$", action: { indent: "indent" } }] });
  const more = JSON.stringify({ onEnterRules: [{ beforeText: { pattern: "^\\s*pass$", flags: "" }, action: { indent: "outdent" } }] });
  const merged = L.merge_rules(own, more);
  assert.deepEqual(L.enter_rule(merged, "    pass", "", ""), [3, "", 0]);
  assert.deepEqual(L.enter_rule(merged, "if x:", "", ""), [1, "", 0]);
  assert.deepEqual(L.enter_rule(merged, "x = {", "}", ""), [2, "", 0], "the language's brackets are kept");
  assert.equal(L.merge_rules(own, "{ broken"), own);
  assert.deepEqual(L.enter_rule(L.merge_rules("", more), "    pass", "", ""), [3, "", 0]);
});

test("what the cursor is inside is named from the indentation, outermost first", () => {
  const py = ["import os", "", "class Shop:", "    def total(self, items):", "        for item in items:", "            yield item", "", "    limit = 3", "", "def main():", "    pass", "x = 1"];
  const names = (lines, line, key = "k" + Math.random()) => L.scopes_at(key, 1, lines, line).map((s) => s[0]);
  assert.deepEqual(names(py, 5), ["Shop", "total"]);
  assert.deepEqual(names(py, 3), ["Shop", "total"], "the line that starts a definition is inside it");
  assert.deepEqual(names(py, 7), ["Shop"]);
  assert.deepEqual(names(py, 6), ["Shop", "total"], "an empty line belongs with what is above it");
  assert.deepEqual(names(py, 10), ["main"]);
  assert.deepEqual(names(py, 11), []);
  assert.deepEqual(names(py, 0), []);
  assert.deepEqual(L.scopes_at("where", 1, py, 5), [["Shop", 2], ["total", 3]], "each with the line it starts on");
  const js = ["export async function load(path) {", "  const inner = (x) => {", "    return x;", "  };", "}", "const top = () => 1;", "class A extends B {", "  static make() {}", "}"];
  assert.deepEqual(names(js, 2), ["load", "inner"]);
  assert.deepEqual(names(js, 5), ["top"]);
  assert.deepEqual(names(js, 7), ["A"]);
  const more = ["pub def area(Circle(r)) {", "  r", "}", "impl Shape for Circle {", "    fn area(&self) -> f64 {", "        1.0", "    }", "}", "pub(crate) struct Point {", "    x: i32,", "}", "func (s *Server) Run() {", "\treturn", "}"];
  assert.deepEqual(names(more, 1), ["area"]);
  assert.deepEqual(names(more, 5), ["Shape", "area"]);
  assert.deepEqual(names(more, 9), ["Point"]);
  assert.deepEqual(names(more, 12), ["Run"]);
  assert.deepEqual(names([], 0), []);
  assert.deepEqual(names(["x"], 99), []);
});
