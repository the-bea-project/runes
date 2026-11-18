// Tables as data (CSV text and XLSX workbooks read into rows), and what a terminal may be named after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseCsv, delimiterOf, parseXlsx, columnOf, columnName, dateOf, widthOf, sortedOrder, MOST_ROWS } from "../src/runes_tables.mjs";
import { nameFor, looksSecret, printed, wasShown } from "../src/runes_secrets.mjs";
import "../src/runes_viewers.mjs";

test("CSV: quoted values hold separators, quotes and line breaks", () => {
  const { rows, mark, cut } = parseCsv('name,note\n"Smith, John","said ""hi"""\nAda,\n"two\nlines",x\n');
  assert.equal(mark, ",");
  assert.equal(cut, false);
  assert.deepEqual(rows, [["name", "note"], ["Smith, John", 'said "hi"'], ["Ada", ""], ["two\nlines", "x"]]);
});

test("CSV: line endings of every kind, a last line with no ending, a byte order mark, empty lines", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r3,4").rows, [["a", "b"], ["1", "2"], ["3", "4"]]);
  assert.deepEqual(parseCsv("﻿a,b\n").rows, [["a", "b"]]);
  assert.deepEqual(parseCsv("a\n\nb\n").rows, [["a"], [""], ["b"]]);
  assert.deepEqual(parseCsv("").rows, []);
  assert.deepEqual(parseCsv("a,b,").rows, [["a", "b", ""]]);
  assert.deepEqual(parseCsv('"unclosed,x\ny').rows, [["unclosed,x\ny"]], "a quote never closed takes the rest, and nothing is lost");
});

test("CSV: the separator is worked out, and a comma inside quotes does not vote", () => {
  assert.equal(delimiterOf("a;b;c\n1;2;3\n"), ";");
  assert.equal(delimiterOf("a\tb\n1\t2\n"), "\t");
  assert.equal(delimiterOf("a|b|c\n1|2|3"), "|");
  assert.equal(delimiterOf('"x, y";2\n"p, q";4\n'), ";");
  assert.equal(delimiterOf("one column\nonly\n"), ",");
  assert.deepEqual(parseCsv("a;b\n1,5;2\n").rows, [["a", "b"], ["1,5", "2"]]);
});

test("CSV: more rows than can be shown are cut, and it says so", () => {
  const { rows, cut } = parseCsv("x\n".repeat(MOST_ROWS + 50));
  assert.equal(rows.length, MOST_ROWS);
  assert.equal(cut, true);
});

const sheet = (rows) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
function workbook(parts = {}) {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8('<workbook><workbookPr/><sheets><sheet name="Orders &amp; more" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId9" Target="../../outside.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8('<sst><si><t>id</t></si><si><t xml:space="preserve">a &lt;b&gt; &amp; c</t></si><si><r><t>rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh><t>ignored</t></rPh></si><si/></sst>'),
    "xl/styles.xml": strToU8('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.00 &quot;days&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>'),
    "xl/worksheets/sheet1.xml": strToU8(sheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>'
      + '<row r="2"><c r="A2"><v>7</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="inlineStr"><is><t>inline</t></is></c><c r="D2" s="1"><v>45000</v></c></row>'
      + '<row r="4"><c r="A4"><v>0.1</v></c><c r="B4" t="str"><f>A2&amp;"x"</f><v>7x</v></c><c r="C4" s="2"><v>45000.5</v></c><c r="D4" s="3"><v>1.5</v></c><c r="E4"><v>0.30000000000000004</v></c></row>'
      + '<row r="5"><c r="A5" t="s"><v>3</v></c></row>')),
    "xl/worksheets/sheet2.xml": strToU8(sheet('<row><c><v>1</v></c><c><v>2</v></c></row><row><c t="e"><v>#DIV/0!</v></c></row>')),
    ...parts,
  });
}

test("XLSX: sheets, shared and inline text, numbers, truth values, dates and the gaps between cells", () => {
  const sheets = parseXlsx(workbook());
  assert.deepEqual(sheets.map((s) => s.name), ["Orders & more", "Second"]);
  assert.deepEqual(sheets[0].rows, [
    ["id", "a <b> & c", "", "rich text"],
    ["7", "TRUE", "inline", "2023-03-15"],
    [],
    ["0.1", "7x", "2023-03-15 12:00:00", "1.5", "0.3"],
  ], "a row left out is an empty row; empty rows at the end are not kept");
  assert.deepEqual(sheets[1].rows, [["1", "2"], ["#DIV/0!"]]);
});

test("XLSX: what is not a workbook says so in words, and nothing outside the workbook is followed", () => {
  assert.throws(() => parseXlsx(new Uint8Array([1, 2, 3, 4])), /not a workbook Runes can read/);
  assert.throws(() => parseXlsx(zipSync({ "hello.txt": strToU8("hi") })), /no sheets/);
  const odd = parseXlsx(workbook({ "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Out" r:id="rId9"/><sheet name="In" r:id="rId1"/></sheets></workbook>') }));
  assert.deepEqual(odd.map((s) => s.name), ["In"]);
});

test("XLSX: cell names, column names and day numbers", () => {
  assert.equal(columnOf("A1"), 0); assert.equal(columnOf("Z9"), 25); assert.equal(columnOf("AA10"), 26); assert.equal(columnOf("BC2"), 54);
  assert.equal(columnName(0), "A"); assert.equal(columnName(25), "Z"); assert.equal(columnName(26), "AA"); assert.equal(columnName(701), "ZZ"); assert.equal(columnName(702), "AAA");
  assert.equal(dateOf(1), "1900-01-01");
  assert.equal(dateOf(59), "1900-02-28");
  assert.equal(dateOf(61), "1900-03-01", "the count has a 29th of February 1900 that never was");
  assert.equal(dateOf(45000), "2023-03-15");
  assert.equal(dateOf(0.75), "18:00:00");
  assert.equal(dateOf(45000.25), "2023-03-15 06:00:00");
  assert.equal(dateOf(0, true), "1904-01-01");
  assert.equal(dateOf(NaN), "");
});

test("a table is as wide as its widest row, and sorts numbers as numbers", () => {
  assert.equal(widthOf([["a"], ["a", "b", "c"], []]), 3);
  const rows = [["10"], ["9"], [""], ["apple"], ["1,000"], ["Banana"], ["2.5"]];
  const sorted = (down) => sortedOrder(rows, 0, down).map((i) => rows[i][0]);
  assert.deepEqual(sorted(false), ["2.5", "9", "10", "1,000", "apple", "Banana", ""]);
  assert.deepEqual(sorted(true), ["Banana", "apple", "1,000", "10", "9", "2.5", ""], "empty cells stay last whichever way it goes");
  assert.deepEqual(sortedOrder([["b", "1"], ["a", "1"]], 1), [0, 1], "what is equal keeps its order");
});

// --- What a terminal may be named after -------------------------------------------------------------

test("a command names a terminal; a token or a key never does", () => {
  for (const line of ["npm run dev", "git push origin main", "ls -la", "cd /home/me/projects/some-long-folder-name-2026", "python3 manage.py runserver 0.0.0.0:8000", "make test_everything_in_this_module_now", "cat 2026-11-18T12:00:00-report-final.txt"]) assert.equal(nameFor(line), line, line);
  for (const secret of ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz", "glpat-AbCdEfGhIjKlMnOpQrSt", "xoxb-1234567890-abcdefghij", "AKIAIOSFODNN7EXAMPLE", "sk-proj-abcdefghijklmnopqrstuv", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc", "aB3dE5fG7hI9jK1lM3nO5pQ7"]) {
    assert.equal(nameFor(secret), "", secret);
    assert.equal(looksSecret(secret), true, secret);
  }
  assert.equal(nameFor(""), ""); assert.equal(nameFor("   "), "");
});

test("a command with a secret in it is named after its program alone", () => {
  assert.equal(nameFor("mysql -uroot -phunter2 shop"), "mysql");
  assert.equal(nameFor("export API_KEY=abc123"), "export");
  assert.equal(nameFor("curl -H 'Authorization: Bearer abc.def' https://example.com"), "curl");
  assert.equal(nameFor("git clone https://user:pw@github.com/a/b.git"), "git");
  assert.equal(nameFor("gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "gh");
  assert.equal(nameFor("docker login -u me --password hunter2"), "docker");
  assert.equal(nameFor("echo ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "echo");
  assert.equal(nameFor("git clone https://github.com/a/b.git"), "git clone https://github.com/a/b.git", "an address with no password in it is only an address");
});

test("what a terminal printed is read without the codes that colour and move it", () => {
  assert.equal(printed("\x1b[1;32mgit\x1b[0m push\r\n"), "git push\n");
  assert.equal(printed("\x1b]0;title\x07$ ls\x1b[K"), "$ ls");
  assert.equal(printed("a\x08b\x7f"), "ab");
});

test("a line counts as typed at a prompt only if the terminal showed it", () => {
  assert.equal(wasShown("git push", "git push\r\n"), true);
  assert.equal(wasShown("git push", printed("\x1b[32mg\x1b[0m\x1b[32mgi\x1b[0mt \x1b[1mpush\x1b[0m")), true, "a shell that colours the line prints it in pieces");
  assert.equal(wasShown("hunter2", ""), false, "a password is typed and not shown");
  assert.equal(wasShown("hunter2", "*******"), false);
  assert.equal(wasShown("ls -la", "ls"), false);
  assert.equal(wasShown("", "anything"), false);
  assert.equal(wasShown("   ", "anything"), false);
});
