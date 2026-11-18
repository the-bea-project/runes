// How a problem an extension reports is shown. No Electron or vscode in here, so it can be
// tested with plain Node.
"use strict";

// A name that cannot be found: a module, a package, a crate, an import. Servers disagree on
// how bad that is (some call it a warning, some a note, some only a hint), but code that
// leans on something that is not there does not run: Runes shows it as an error.
const MISSING = new RegExp([
  "\\b(unknown|unresolved|missing|undefined) (module|import|package|crate|dependency)\\b",
  "\\b(cannot|can't|can not|could not|couldn't|unable to|failed to) (find|resolve|locate|import|load) (the |a |any )?(module|import|package|crate|type declarations?|declaration file|name)\\b",
  "\\bno (such )?(module|package|crate) (named|has been found|found|called)\\b",
  "\\b(module|import|package|crate) .{0,120}?(could not be (resolved|found)|cannot be (resolved|found)|is not (installed|found)|not found|does not exist)",
  "\\bfailed to resolve: (use of )?(undeclared|unresolved)",
  "\\bfile not found for module\\b",
].join("|"), "i");

/**
 * The level a problem is shown at: 1 an error, 2 a warning, 3 a note, and three kinds of
 * hint, which are not underlined at all: 4 a plain one (a few dots), 5 code that is not
 * needed (it is faded), 6 code that is out of date (it is struck through).
 * `severity` and `tags` are vscode's: 0 to 3, and 1 for unnecessary, 2 for deprecated.
 */
function level(severity, message, tags) {
  const given = Number.isInteger(severity) && severity >= 0 && severity <= 3 ? severity + 1 : 1;
  if (given > 1 && MISSING.test(String(message ?? "").slice(0, 600))) return 1;
  if (given < 4) return given;
  const marks = Array.isArray(tags) ? tags : [];
  return marks.includes(2) ? 6 : marks.includes(1) ? 5 : 4;
}

module.exports = { level, MISSING };
