// Builds the installers and archives people download.
//
//   npm run release                 everything this machine can build for its own system
//   npm run release -- --linux      .tar.gz (with install.sh), .deb and .AppImage
//   npm run release -- --win        the Windows installer (.exe) and a .zip
//   npm run release -- --mac        .dmg and .zip (only on a Mac)
//   npm run release -- --arch arm64 for another processor (default: this machine's)
//   npm run release -- --dir        the unpacked app only, to try it: release/<os>-unpacked/
//   npm run release -- --skip-build use dist/ as it is (CI builds it once, then packages on each system)
//
// The results land in release/, with SHA256SUMS.txt beside them.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, list, options = {}) => {
  const done = spawnSync(command, list, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...options });
  if (done.status !== 0) { console.error(`\n${command} ${list.join(" ")} failed.`); process.exit(done.status ?? 1); }
};

const own = { linux: "--linux", win32: "--win", darwin: "--mac" }[process.platform];
let systems = ["--linux", "--win", "--mac"].filter(has);
if (!systems.length) systems = [own];
if (systems.includes("--mac") && process.platform !== "darwin") {
  console.error("macOS builds can only be made on a Mac (Apple's tools are needed for the disk image). Use the release workflow, or run this on a Mac.");
  process.exit(1);
}
const arch = value("--arch", process.arch);
if (!["x64", "arm64"].includes(arch)) { console.error("--arch must be x64 or arm64"); process.exit(1); }

// 1. The editor itself: Bea to JavaScript, then the bundle in dist/.
if (!has("--skip-build")) {
  for (const tool of ["bea", "gleam"]) {
    if (spawnSync(tool, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status !== 0) {
      console.error(`'${tool}' is not on the PATH. It is needed to build Runes (see the README). To package a dist/ built elsewhere, pass --skip-build.`);
      process.exit(1);
    }
  }
  run(npm, ["run", "build"]);
} else if (!existsSync(join(root, "dist/app.js"))) {
  console.error("--skip-build was given but there is no dist/app.js. Run `npm run build` first.");
  process.exit(1);
}

// 2. The terminal needs a small native part, one per system and processor. npm installs
//    only the one for this machine, so a build for another system fetches its own.
const pty = (system) => `@lydell/node-pty-${{ "--linux": "linux", "--win": "win32", "--mac": "darwin" }[system]}-${arch}`;
for (const system of systems) {
  if (existsSync(join(root, "node_modules", pty(system)))) continue;
  const version = require(join(root, "node_modules/@lydell/node-pty/package.json")).optionalDependencies?.[pty(system)];
  if (!version) { console.error(`There is no prebuilt terminal for ${pty(system)}; that system and processor cannot be built.`); process.exit(1); }
  console.log(`Fetching ${pty(system)}@${version} for the terminal…`);
  run(npm, ["install", "--no-save", "--force", "--no-audit", "--no-fund", `${pty(system)}@${version}`]);
}

// 3. The installers.
const builder = [join(root, "node_modules/electron-builder/cli.js"), ...systems, `--${arch}`, "--publish", "never"];
if (has("--dir")) builder.push("--dir");
// A Windows installer made on another system needs Wine: the installer builder runs a small
// Windows program to write the uninstaller, and the .exe's icon is set by another. Without
// Wine a portable .zip can still be made; the installer comes from a Windows machine or CI.
if (systems.includes("--win") && process.platform !== "win32" && spawnSync("wine", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.log("Note: Wine is not installed, so only the portable Windows .zip is built here, with Electron's own icon on Runes.exe.\n"
    + "      The installer (.exe) is built on Windows, by the release workflow, or here once Wine is installed.");
  builder.push("-c.win.signAndEditExecutable=false", "-c.win.target=zip");
}
run(process.execPath, builder);

// 4. What was made, and a checksum for each.
const out = join(root, "release");
const made = readdirSync(out).filter((name) => /\.(exe|zip|dmg|deb|rpm|AppImage|tar\.gz)$/.test(name)).sort();
if (made.length) {
  const sums = made.map((name) => `${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`);
  writeFileSync(join(out, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  console.log("\nIn release/:");
  for (const name of made) console.log(`  ${name.padEnd(44)} ${(statSync(join(out, name)).size / 1048576).toFixed(1)} MB`);
  console.log("  SHA256SUMS.txt");
} else if (has("--dir")) {
  console.log("\nThe unpacked app is in release/. Run the `runes` program inside it.");
}
