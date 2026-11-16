// The drawing as data: what is read from a file, what is written to one, and the geometry between.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, serialize, cleanElement, cleanLink, freshId, box, around, hits, elementAt, edgeToward, retie, simplify, fit, rng, outline, strokeLine, wrap, VERSION, COLOURS } from "../src/runes_canvas.mjs";
import { nodes, traced, middles, middle, bendAdded, bendMoved, bendRemoved, bendIsStraight, shifted, strokeCurve, approach, MOST_BENDS } from "../src/runes_canvas.mjs";

const file = (elements, more = {}) => JSON.stringify({ rune: "canvas", version: 1, elements, ...more });
const rect = (more = {}) => ({ id: "a", type: "rect", x: 0, y: 0, w: 100, h: 60, ...more });

test("an empty file is an empty board, and saving one says what it is", () => {
  assert.deepEqual(parse(""), { elements: [], problem: "" });
  assert.deepEqual(parse("  \n"), { elements: [], problem: "" });
  const out = JSON.parse(serialize([]));
  assert.equal(out.rune, "canvas");
  assert.equal(out.version, VERSION);
  assert.deepEqual(out.elements, []);
});

test("what is written is read back the same, one element to a line, with the usual values left out", () => {
  const made = parse(file([rect({ text: "Shop", fill: "green", link: "src/shop.bea:3" }), { id: "b", type: "ellipse", x: 300, y: 0, w: 80, h: 80 },
    { id: "c", type: "arrow", x: 100, y: 30, w: 200, h: 0, from: "a", to: "b", text: "asks" }, { id: "d", type: "text", x: 0, y: 200, text: "two\nlines", size: 28 },
    { id: "e", type: "draw", x: 5, y: 5, points: [[0, 0], [10, 4], [20, 0]] }])).elements;
  assert.equal(made.length, 5);
  const text = serialize(made);
  assert.equal(text.trim().split("\n").length, 5 + 6);
  assert.ok(text.endsWith("\n"));
  assert.ok(!/"stroke":"ink"|"fill":"none"|"width":2|"dash":"solid"|"sketch":true/.test(text), "usual values are written out:\n" + text);
  assert.deepEqual(parse(text).elements, made);
  // Writing it again changes nothing: a saved drawing makes no noise in a diff.
  assert.equal(serialize(parse(text).elements), text);
});

test("files that are not drawings are refused, with the reason", () => {
  assert.match(parse("{ nope").problem, /not valid JSON/);
  assert.match(parse("[]").problem, /not a Rune Canvas/);
  assert.match(parse('{"rune":"other","elements":[]}').problem, /not a Rune Canvas/);
  assert.match(parse('{"rune":"canvas","elements":{}}').problem, /not a Rune Canvas/);
  assert.match(parse(file([], { version: VERSION + 1 })).problem, /newer Runes/);
  assert.equal(parse(file([], { version: "9" })).problem, "");
});

test("nothing in a file is trusted: types, numbers, colours, ids and text are all checked", () => {
  const got = parse(file([
    rect({ id: "ok" }), rect({ id: "ok" }), rect({ id: "<b>" }), { type: "script", x: 0, y: 0 }, null, 7, "x", [],
    rect({ id: "n", x: "12", y: null, w: 1e308 * 10, h: -40 }), rect({ id: "c", stroke: "url(#x)", fill: "red;background:url(x)", width: 900, dash: "wavy" }),
    { id: "t", type: "text", x: 0, y: 0, text: 42 }, { id: "long", type: "text", x: 0, y: 0, text: "x".repeat(50000) },
    { id: "dr", type: "draw", x: 0, y: 0, points: [[0, 0], ["a", 1], [1], [3, 4, 5], null, [1e999, 2]] },
  ])).elements;
  const ids = got.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids repeat: " + ids);
  assert.ok(ids.every((id) => /^[\w-]{1,40}$/.test(id)), "an id is not plain: " + ids);
  assert.ok(got.every((e) => ["rect", "text", "draw"].includes(e.type)));
  for (const e of got) for (const key of ["x", "y", "w", "h"]) if (key in e) assert.ok(Number.isFinite(e[key]) && Math.abs(e[key]) <= 1e7, key + " of " + e.id + " is " + e[key]);
  const c = got.find((e) => e.id === "c");
  assert.ok(COLOURS.includes(c.stroke) && (c.fill === "none" || COLOURS.includes(c.fill)));
  assert.ok([1, 2, 4].includes(c.width) && c.dash === "solid");
  assert.ok(got.find((e) => e.id === "long").text.length <= 20000);
  const dr = got.find((e) => e.id === "dr");
  if (dr) assert.ok(dr.points.every((p) => p.length === 2 && p.every(Number.isFinite)));
});

test("a file cannot reach into objects it does not own", () => {
  const got = parse('{"rune":"canvas","version":1,"elements":[{"id":"a","type":"rect","x":0,"y":0,"w":9,"h":9,"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}]}');
  assert.equal(got.elements.length, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(got.elements[0].polluted, undefined);
  assert.ok(!serialize(got.elements).includes("polluted"));
});

test("there is a limit to how much one file may hold", () => {
  const many = Array.from({ length: 6000 }, (_, i) => rect({ id: "r" + i }));
  assert.equal(parse(file(many)).elements.length, 5000);
});

test("links stay inside the project", () => {
  assert.equal(cleanLink("src/shop.bea"), "src/shop.bea");
  assert.equal(cleanLink("src/shop.bea:12"), "src/shop.bea:12");
  assert.equal(cleanLink("src\\win\\a.bea"), "src/win/a.bea");
  for (const bad of ["../secret", "a/../../b", "/etc/passwd", "javascript:alert(1)", "https://evil.example", "file:///etc/passwd", "C:/Windows", "a//b", "", 7, null, {}]) assert.equal(cleanLink(bad), "", String(bad));
  assert.equal(cleanElement(rect({ link: "javascript:alert(1)" })).link, "");
});

test("arrows tied to things that are gone are let go", () => {
  const got = parse(file([rect(), { id: "c", type: "arrow", x: 0, y: 0, w: 50, h: 50, from: "a", to: "ghost" }])).elements;
  assert.equal(got[1].from, "a");
  assert.equal(got[1].to, "");
});

test("a tied arrow runs from edge to edge, and follows when a shape moves", () => {
  const a = cleanElement(rect()), b = cleanElement({ id: "b", type: "rect", x: 300, y: 0, w: 100, h: 60 });
  const arrow = cleanElement({ id: "c", type: "arrow", x: 0, y: 0, w: 10, h: 10, from: "a", to: "b" });
  const [, , tied] = retie([a, b, arrow]);
  assert.ok(tied.x >= 100 && tied.x <= 112 && Math.abs(tied.y - 30) < 1, "starts at the right edge of a: " + JSON.stringify(tied));
  assert.ok(tied.x + tied.w <= 300 && tied.x + tied.w >= 288, "ends at the left edge of b");
  const moved = retie([a, { ...b, y: 400 }, tied])[2];
  assert.ok(moved.y + moved.h > 300, "the end went down with b");
  // Nothing tied: nothing changes, and the very same objects come back.
  const loose = cleanElement({ id: "l", type: "line", x: 1, y: 2, w: 3, h: 4 });
  assert.equal(retie([a, loose])[1], loose);
});

test("an edge is found for every shape", () => {
  for (const type of ["rect", "ellipse", "diamond"]) {
    const el = cleanElement({ id: "s", type, x: 0, y: 0, w: 100, h: 100 });
    const [x, y] = edgeToward(el, 500, 50, 0);
    assert.ok(Math.abs(x - 100) < 1.5 && Math.abs(y - 50) < 1.5, type + " edge at " + x + "," + y);
  }
});

test("pointing at things: outlines of empty shapes, all of filled ones, near lines", () => {
  const empty = cleanElement(rect()), full = cleanElement(rect({ fill: "blue" }));
  assert.ok(hits(empty, 0, 30) && hits(empty, 100, 30) && !hits(empty, 50, 30), "an empty rectangle is held by its outline");
  assert.ok(hits(full, 50, 30) && !hits(full, 150, 30));
  const oval = cleanElement({ id: "o", type: "ellipse", x: 0, y: 0, w: 100, h: 60 });
  assert.ok(hits(oval, 0, 30) && !hits(oval, 2, 2) && !hits(oval, 50, 30));
  const dia = cleanElement({ id: "d", type: "diamond", x: 0, y: 0, w: 100, h: 60, fill: "red" });
  assert.ok(hits(dia, 50, 30) && !hits(dia, 3, 3));
  const line = cleanElement({ id: "l", type: "line", x: 0, y: 0, w: 100, h: 100 });
  assert.ok(hits(line, 50, 52) && !hits(line, 80, 20));
  assert.equal(elementAt([full, line], 50, 50).id, "l", "the one on top is found first");
  assert.equal(elementAt([full, line], 500, 500), null);
});

test("boxes: of lines drawn backwards, and of many things at once", () => {
  const back = cleanElement({ id: "l", type: "line", x: 100, y: 100, w: -40, h: -60 });
  assert.deepEqual(box(back), { x: 60, y: 40, w: 40, h: 60 });
  assert.deepEqual(around([cleanElement(rect()), back]), { x: 0, y: 0, w: 100, h: 100 });
});

test("resizing a group keeps each thing's place in it", () => {
  const el = cleanElement(rect({ x: 50, y: 0, w: 50, h: 60 }));
  const out = fit(el, { x: 0, y: 0, w: 100, h: 60 }, { x: 0, y: 0, w: 200, h: 120 });
  assert.deepEqual([out.x, out.y, out.w, out.h], [100, 0, 100, 120]);
});

test("the hand that draws is the same every time: a seed gives one wobble", () => {
  const el = cleanElement(rect({ seed: 7 }));
  assert.equal(outline(el, rng(7)), outline(el, rng(7)));
  assert.notEqual(outline(el, rng(7)), outline(el, rng(8)));
  assert.ok(!/NaN|Infinity/.test(outline(el, rng(7)) + strokeLine(0, 0, 0, 0, rng(1), true) + outline(cleanElement(rect({ w: 0, h: 0 })), rng(1))));
});

test("pen strokes are thinned without losing their shape", () => {
  const wiggle = Array.from({ length: 200 }, (_, i) => [i, Math.sin(i / 20) * 30]);
  const thin = simplify(wiggle, 1);
  assert.ok(thin.length < 60 && thin.length > 5, "kept " + thin.length);
  assert.deepEqual(thin[0], wiggle[0]);
  assert.deepEqual(thin.at(-1), wiggle.at(-1));
  assert.deepEqual(simplify([[0, 0]], 1), [[0, 0]]);
});

test("labels wrap to the width they have", () => {
  const wide = (s) => s.length * 10;
  assert.deepEqual(wrap("one two three", 70, wide), ["one two", "three"]);
  assert.deepEqual(wrap("a\nb", 500, wide), ["a", "b"]);
  assert.ok(wrap("unbreakableword", 50, wide).join("").length === 15);
});

test("new ids do not collide with ones in use", () => {
  const taken = new Set();
  for (let i = 0; i < 2000; i++) { const id = freshId(taken); assert.ok(!taken.has(id)); taken.add(id); }
});

// --- Lines that bend ---

const arrow = (more = {}) => cleanElement({ id: "ar", type: "arrow", x: 0, y: 0, w: 200, h: 0, ...more });

test("a line bends where a point is pulled out of it, and passes through every bend", () => {
  const straight = arrow();
  assert.deepEqual(middles(straight), [[100, 0]]);
  const bent = bendAdded(straight, 0, 100, 80);
  assert.deepEqual(bent.bends, [[100, 80]]);
  assert.deepEqual(nodes(bent), [[0, 0], [100, 80], [200, 0]]);
  const path = traced(bent);
  assert.ok(path.some(([x, y]) => Math.abs(x - 100) < 0.01 && Math.abs(y - 80) < 0.01), "the curve goes through the bend");
  assert.deepEqual(path[0], [0, 0]);
  assert.deepEqual(path.at(-1), [200, 0]);
  // Two new middles, one each side of the bend: pulling one adds a bend in the right place.
  const mids = middles(bent);
  assert.equal(mids.length, 2);
  assert.ok(mids[0][0] < 100 && mids[1][0] > 100);
  const twice = bendAdded(bent, 1, 160, -40);
  assert.deepEqual(twice.bends, [[100, 80], [160, -40]]);
  const first = bendAdded(bent, 0, 40, 10);
  assert.deepEqual(first.bends, [[40, 10], [100, 80]]);
  assert.deepEqual(bendMoved(twice, 1, 150, -60).bends, [[100, 80], [150, -60]]);
  assert.deepEqual(bendRemoved(twice, 0).bends, [[160, -40]]);
  assert.equal(bendRemoved(twice, 9), twice);
  assert.equal(straight.bends.length, 0, "the line it was made from is not changed");
});

test("a bend on the straight way between its neighbours is no bend", () => {
  assert.ok(bendIsStraight(arrow({ bends: [[100, 2]] }), 0));
  assert.ok(!bendIsStraight(arrow({ bends: [[100, 40]] }), 0));
  assert.ok(bendIsStraight(arrow({ bends: [[50, 50], [100, 51], [150, 50]] }), 1));
});

test("a bent line is touched along its curve, takes the room of its curve, and is labelled at its middle", () => {
  const bent = arrow({ bends: [[100, 80]] });
  assert.ok(hits(bent, 100, 80), "on the bend");
  assert.ok(!hits(bent, 100, 0), "the straight way it no longer takes");
  assert.ok(hits(bent, 0, 0) && hits(bent, 200, 0));
  const b = box(bent);
  assert.ok(b.y <= 0.5 && b.h >= 79 && b.w >= 199, JSON.stringify(b));
  const [mx, my] = middle(bent);
  assert.ok(Math.abs(mx - 100) < 2 && my > 70, "the label sits at the bend of a line bent in the middle");
  assert.deepEqual(middle(arrow()), [100, 0]);
});

test("bends are kept in the file, and nothing odd in them is believed", () => {
  const made = parse(file([{ id: "a", type: "arrow", x: 0, y: 0, w: 200, h: 0, bends: [[100, 80], ["x", null], [1e999, 5], "no", [7]] }, { id: "r", type: "rect", x: 0, y: 0, w: 5, h: 5, bends: [[1, 2]] }])).elements;
  assert.equal(made[0].bends.length, 3);
  assert.ok(made[0].bends.every((p) => p.length === 2 && p.every(Number.isFinite)));
  assert.equal(made[1].bends, undefined, "only lines bend");
  const text = serialize(made);
  assert.match(text, /"bends":\[\[100,80\]/);
  assert.deepEqual(parse(text).elements, made);
  assert.ok(!serialize([arrow()]).includes("bends"), "a straight line says nothing about bends");
  const many = parse(file([{ id: "a", type: "line", x: 0, y: 0, w: 9, h: 9, bends: Array.from({ length: 500 }, (_, i) => [i, i]) }])).elements[0];
  assert.equal(many.bends.length, MOST_BENDS);
  assert.equal(bendAdded(many, 0, 1, 1), many, "no more than that are added by hand either");
});

test("a bent line moves and scales with its bends, and its tied ends leave towards the nearest bend", () => {
  const bent = arrow({ bends: [[100, 80]] });
  assert.deepEqual(shifted(bent, 10, -5).bends, [[110, 75]]);
  assert.deepEqual([shifted(bent, 10, -5).x, shifted(bent, 10, -5).y], [10, -5]);
  assert.equal(shifted(cleanElement(rect()), 3, 4).bends, undefined);
  const scaled = fit(bent, { x: 0, y: 0, w: 200, h: 80 }, { x: 0, y: 0, w: 400, h: 160 });
  assert.deepEqual(scaled.bends, [[200, 160]]);
  // Two boxes side by side, the arrow between them bent far below: each end leaves its box downwards.
  const a = cleanElement(rect()), b = cleanElement({ id: "b", type: "rect", x: 300, y: 0, w: 100, h: 60 });
  const tied = retie([a, b, cleanElement({ id: "c", type: "arrow", x: 0, y: 0, w: 10, h: 10, from: "a", to: "b", bends: [[200, 400]] })])[2];
  assert.ok(tied.y > 60 && tied.y + tied.h > 60, "both ends are on the lower edges: " + JSON.stringify(tied));
  assert.deepEqual(tied.bends, [[200, 400]], "tying moves the ends, never the bends");
});

test("a bent line is drawn as one curve, the same every time, and its arrowhead follows the curve in", () => {
  const bent = arrow({ bends: [[100, 80]], seed: 3 });
  const clean = strokeCurve(bent, rng(3), false);
  assert.match(clean, /^M0 0C/);
  assert.equal((clean.match(/C/g) ?? []).length, 2, "one piece for each stretch");
  assert.equal(strokeCurve(bent, rng(3), true), strokeCurve(bent, rng(3), true));
  assert.ok(!/NaN|Infinity/.test(strokeCurve(arrow({ w: 0, h: 0, bends: [[0, 0]] }), rng(1), true)));
  assert.equal(strokeCurve(arrow(), rng(3), false), strokeLine(0, 0, 200, 0, rng(3), false), "a line without bends is the straight line it always was");
  const [fx, fy] = approach(bent, true);
  assert.ok(fx < 200 && fy > 0, "it arrives from below and to the left");
  assert.deepEqual(approach(arrow(), true), [0, 0]);
});
