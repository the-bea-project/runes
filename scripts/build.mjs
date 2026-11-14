// Assemble dist/: the editor as one script, the page, fonts, and the bundled extensions.
// Run `bea build` first (npm run build does both).
import { build } from "esbuild";
import { zipSync } from "fflate";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "extensions"), { recursive: true });

const entry = join(dist, "entry.mjs");
writeFileSync(entry, `import { main } from ${JSON.stringify(join(root, ".beabuild/build/dev/javascript/runes/runes.mjs"))};\nmain();\n`);
await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  minify: process.argv.includes("--minify"),
  outfile: join(dist, "app.js"),
  nodePaths: [join(root, "node_modules")],
  logLevel: "warning",
});
rmSync(entry);

for (const file of ["index.html", "style.css", "logo.svg", "logo.png"]) cpSync(join(root, "web", file), join(dist, file));
cpSync(join(root, "web/fonts"), join(dist, "fonts"), { recursive: true });
cpSync(join(root, "node_modules/vscode-oniguruma/release/onig.wasm"), join(dist, "onig.wasm"));
cpSync(join(root, "node_modules/@xterm/xterm/css/xterm.css"), join(dist, "xterm.css"));

// Runes ships small: the folders named in extensions/bundled.json each become a .vsix, laid
// out as `vsce package` would. They are syntax, themes and icons only; nothing with code.
// Everything else in extensions/ (and extensions/prebuilt/, used by the tests) stays out.
const names = [];
for (const name of JSON.parse(readFileSync(join(root, "extensions/bundled.json"), "utf8"))) {
  const dir = join(root, "extensions", name);
  const files = {};
  const walk = (at) => {
    for (const child of readdirSync(at)) {
      const path = join(at, child);
      if (statSync(path).isDirectory()) walk(path);
      else files["extension/" + relative(dir, path).split("\\").join("/")] = readFileSync(path);
    }
  };
  walk(dir);
  writeFileSync(join(dist, "extensions", name + ".vsix"), zipSync(files, { level: 6 }));
  names.push(name + ".vsix");
}
writeFileSync(join(dist, "extensions/index.json"), JSON.stringify(names));
console.log(`dist/ ready, with ${names.length} extensions`);
