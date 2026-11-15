// Run by git and ssh when they need a password, a passphrase, or a yes or no. The question
// is the first argument; the answer goes to standard output. See ../ask.cjs.
"use strict";
const { put } = require("../ask.cjs");

put("", process.argv.slice(2).join(" ")).then((answer) => {
  if (answer === null) process.exit(1);
  process.stdout.write(answer + "\n", () => process.exit(0));
});
