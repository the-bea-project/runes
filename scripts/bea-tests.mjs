// `bea test` (0.5.0) runs tests written in Gleam only. The tests here are written in Bea, so
// this turns test/runes_test.bea into Gleam with Bea's own compiler, then runs the result.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const staged = join(root, "src/runes_test.bea");
const run = (args) => execFileSync("bea", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const generated = join(root, ".beabuild/src/runes_test.gleam");
try {
  rmSync(generated, { force: true });
  copyFileSync(join(root, "test/runes_test.bea"), staged);
  // Bea translates the file, then Gleam refuses it because a source module may not import
  // gleeunit. The translation is all that is wanted here, so that refusal is expected.
  try { run(["build"]); } catch (e) { if (!existsSync(generated)) throw e; }
  copyFileSync(generated, join(root, "test/runes_test.gleam"));
} catch (e) {
  process.stderr.write(String(e.stderr ?? e));
  process.exitCode = 1;
} finally {
  rmSync(staged, { force: true });
  rmSync(generated, { force: true });
}
if (!process.exitCode) {
  // gleeunit on the JavaScript target reads gleam.toml from the working directory, and
  // `bea test` runs it from the project root where there is none. So run Gleam's own test
  // command inside .beabuild, where Bea keeps the generated project.
  try {
    mkdirSync(join(root, ".beabuild/test"), { recursive: true });
    copyFileSync(join(root, "test/runes_test.gleam"), join(root, ".beabuild/test/runes_test.gleam"));
    execFileSync("gleam", ["test"], { cwd: join(root, ".beabuild"), stdio: "inherit" });
  } catch { process.exitCode = 1; }
}
