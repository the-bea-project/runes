// End-to-end checks of the desktop app, driven through Playwright's Electron support.
//   xvfb-run -a node e2e/app.test.cjs      (needs `bea` and `gleam` on the PATH for the language checks)
// The app runs against a throwaway profile and project.
"use strict";
const { _electron } = require("playwright");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "runes-e2e-"));
const project = path.join(work, "shop");
const shots = process.env.RUNES_SHOTS || "";
const source = 'import gleam/int\n\npub def double(n: Int) -> Int {\n  n * 2\n}\n\npub def label(n: Int) -> String {\n  int.to_string(double(n))\n}\n';

fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "bea.toml"), 'name = "shop"\nversion = "0.1.0"\n\n[dependencies]\ngleam_stdlib = ">= 0.44.0 and < 2.0.0"\n');
fs.writeFileSync(path.join(project, "src/shop.bea"), source);
fs.writeFileSync(path.join(project, "src/notes.md"), "# Notes\n\ndouble the fun\n");
fs.writeFileSync(path.join(project, "README.md"), "# Shop\n\nA sample project.\n");
fs.writeFileSync(path.join(project, "src/long.txt"), Array.from({ length: 400 }, (_, i) => "line number " + (i + 1)).join("\n") + "\n");
fs.writeFileSync(path.join(project, "src/many.txt"), "foo bar foo\nx foo y\nfood\n");
fs.writeFileSync(path.join(project, ".gitignore"), ".beabuild/\nbuild/\n");

// A small history with a branch and a merge, for the source control checks.
const { execFileSync } = require("node:child_process");
const { zipSync, strToU8 } = require(path.join(root, "node_modules/fflate"));
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com", GIT_AUTHOR_DATE: "2026-11-02T10:00:00", GIT_COMMITTER_DATE: "2026-11-02T10:00:00" } });
// Fetch the project's packages before the editor starts, so the language checks do not wait on the network.
try { execFileSync("bea", ["build"], { cwd: project, stdio: "pipe", timeout: 180000 }); } catch (e) { console.log("note: `bea build` of the sample project failed; the language checks may time out"); }
git("init", "-q", "-b", "main");
git("config", "user.name", "Ada"); git("config", "user.email", "ada@example.com");
git("add", "-A"); git("commit", "-qm", "Start the shop");
git("checkout", "-qb", "feature/notes");
fs.appendFileSync(path.join(project, "src/notes.md"), "\nmore\n"); git("commit", "-qam", "More notes");
git("checkout", "-q", "main");
fs.appendFileSync(path.join(project, "README.md"), "\nmain line\n"); git("commit", "-qam", "Describe the main line");
git("merge", "-q", "--no-ff", "feature/notes", "-m", "Merge the notes"); git("tag", "v0.1.0");

let passed = 0, failed = 0, page = null;
const results = [];
// RUNES_ONLY=<pattern> runs just the checks whose names match, for working on one of them.
const only = process.env.RUNES_ONLY ? new RegExp(process.env.RUNES_ONLY, "i") : null;
async function check(name, run) {
  if (only && !only.test(name)) return;
  try { await run(); passed++; results.push("ok    " + name); console.log("ok    " + name); }
  catch (e) {
    // RUNES_DIAG=1: what the machine was busy with when a check failed, for telling a slow machine from a stuck app.
    if (process.env.RUNES_DIAG && page) { try { console.log("page: " + JSON.stringify(await Promise.race([page.evaluate(() => new Promise((done) => { const facts = { hidden: document.hidden, focus: document.hasFocus(), frames: 0 }; const tick = () => { facts.frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => done(facts), 500); })), new Promise((r) => setTimeout(() => r("no answer in 5s"), 5000))]))); } catch (e) { console.log("page: " + e.message); } }
    if (process.env.RUNES_DIAG) { try { console.log(require("node:child_process").execSync("ps -eo pcpu,etimes,args --sort=-pcpu | head -6 | cut -c1-150").toString()); } catch {} }
    failed++; if (shots && page) await page.screenshot({ path: path.join(shots, "fail-" + failed + ".png") }).catch(() => {}); results.push("FAIL  " + name); console.log("FAIL  " + name + "\n      " + String(e.message).split("\n").slice(0, 6).join("\n      "));
  }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
  // A stand-in for the Open VSX registry, with one theme extension in it.
  const themeVsix = Buffer.from(zipSync({
    "extension/package.json": strToU8(JSON.stringify({ name: "sunset", displayName: "Sunset Theme", publisher: "demo", version: "2.0.0", contributes: { themes: [{ label: "Demo Sunset", uiTheme: "vs-dark", path: "./t.json" }] } })),
    "extension/t.json": strToU8(JSON.stringify({ colors: { "editor.background": "#201010", "editor.foreground": "#ffeedd" }, tokenColors: [] })),
  }));
  // A small picture and an extension with code: it offers a quick fix for Markdown and adds a command.
  const zlib = require("node:zlib");
  const png = (() => {
    const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
    const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
    const head = Buffer.alloc(13); head.writeUInt32BE(8, 0); head.writeUInt32BE(8, 4); head[8] = 8; head[9] = 2;
    const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0xc8)])));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  })();
  const fixerVsix = path.join(work, "demo.fixer.vsix");
  fs.writeFileSync(fixerVsix, Buffer.from(zipSync({
    "extension/package.json": strToU8(JSON.stringify({
      name: "fixer", displayName: "Demo Fixer", publisher: "demo", version: "1.0.0", icon: "images/icon.png", main: "./main.js",
      engines: { vscode: "^1.80.0" }, activationEvents: ["*"],
      contributes: { commands: [{ command: "demo.stamp", title: "Stamp the Notes", category: "Demo" }] },
    })),
    "extension/images/icon.png": new Uint8Array(png),
    "extension/main.js": strToU8(`
      const vscode = require("vscode");
      exports.activate = (context) => {
        context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: "markdown" }, {
          provideCodeActions(document, range) {
            const first = document.lineAt(0).text;
            if (range.start.line !== 0 || first === first.toUpperCase()) return [];
            const action = new vscode.CodeAction("Shout the heading", vscode.CodeActionKind.QuickFix);
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, new vscode.Range(0, 0, 0, first.length), first.toUpperCase());
            // A refactoring whose edit is only worked out when it is chosen, as real servers do.
            const whisper = new vscode.CodeAction("Whisper the heading", vscode.CodeActionKind.Refactor);
            return [whisper, action];
          },
          resolveCodeAction(action) {
            const document = vscode.workspace.textDocuments.find((d) => d.fileName.endsWith("notes.md"));
            const first = document.lineAt(0).text;
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, new vscode.Range(0, 0, 0, first.length), first.toLowerCase());
            return action;
          },
        }));
        // People to mention, after an @: the way a language server offers things. Each item says
        // what it replaces, is matched by its own filter text, and comes with a line to add at
        // the top of the file: at once for one of them, only when asked again for the other.
        context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: "markdown" }, {
          provideCompletionItems(document, position, token, context) {
            const before = document.lineAt(position.line).text.slice(0, position.character);
            const at = before.lastIndexOf("@");
            if (at === -1) return [];
            globalThis.__asked = (globalThis.__asked ?? 0) + 1;
            const range = new vscode.Range(position.line, at, position.line, position.character);
            const person = (label, name, about) => {
              const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Constant);
              item.range = range; item.insertText = "@" + name; item.filterText = label; item.detail = name; item.sortText = label;
              if (about) item.documentation = new vscode.MarkdownString(about);
              return item;
            };
            const ada = person("@ada", "ada-lovelace", "**Ada** wrote the first program.\\n\\n## Example\\n\\n\`\`\`js\\nconst engine = 1\\n\`\`\`\\n\\n[More](https://example.com/ada) <script>window.__doc = true</script>");
            ada.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), "<!-- mentions ada -->\\n")];
            const list = [ada, person("@grace", "grace-hopper", ""), person("@alan", "alan-turing", "Asked " + globalThis.__asked + " times, trigger " + context.triggerCharacter)];
            return new vscode.CompletionList(list, false);
          },
          resolveCompletionItem(item) {
            if (item.label !== "@grace") return item;
            item.documentation = new vscode.MarkdownString("**Grace** found the first bug.");
            item.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), "<!-- mentions grace -->\\n")];
            return item;
          },
        }, "@"));
        context.subscriptions.push(vscode.commands.registerCommand("demo.stamp", async () => {
          const notes = vscode.workspace.textDocuments.find((d) => d.fileName.endsWith("notes.md"));
          const edit = new vscode.WorkspaceEdit();
          edit.insert(notes.uri, new vscode.Position(0, 0), "<!-- stamped -->\\n");
          await vscode.workspace.applyEdit(edit);
        }));
      };
    `),
  })));

  const registry = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const origin = `http://127.0.0.1:${registry.address().port}`;
    if (url.pathname === "/api/-/search") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ extensions: [{ namespace: "demo", name: "sunset", displayName: "Sunset Theme", description: "Warm colours " + url.searchParams.get("query"), version: "2.0.0", downloadCount: 1234567, files: { icon: origin + "/files/sunset.png" } }] }));
    } else if (url.pathname === "/api/demo/sunset") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ files: { download: origin + "/files/sunset.vsix", readme: origin + "/files/sunset.md" } }));
    } else if (url.pathname === "/files/sunset.vsix") response.end(themeVsix);
    else if (url.pathname === "/files/sunset.md") response.end("# Sunset\n\nWarm colours for the *evening*.\n\n<script>window.__readme = true</script>\n\n- [Home](https://example.com/sunset)\n");
    // As the real registry's file store does for many icons: the bytes of a picture, called a download.
    else if (url.pathname === "/files/sunset.png") { response.setHeader("content-type", "application/octet-stream"); response.end(png); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));

  const profile = path.join(work, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "settings.json"), `{\n  // test profile\n  "editor.fontSize": 14,\n  "runes.update.check": false,\n}\n`);

  // Git's settings for "all repositories" go to a file of the test's own, and gpg gets a home
  // of its own with one key in it that needs a passphrase (when there is a gpg at all).
  const gnupg = fs.mkdtempSync(path.join(os.tmpdir(), "g-"));
  fs.chmodSync(gnupg, 0o700);
  const gitEnv = { GIT_CONFIG_GLOBAL: path.join(work, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GNUPGHOME: gnupg };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
  let signing = true;
  try {
    fs.writeFileSync(path.join(gnupg, "gpg-agent.conf"), "default-cache-ttl 0\nmax-cache-ttl 0\n");
    execFileSync("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "open sesame", "--quick-gen-key", "Ada <ada@example.com>", "ed25519", "sign", "never"], { stdio: "pipe", env: { ...process.env, GNUPGHOME: gnupg } });
  } catch { signing = false; }

  const app = await _electron.launch({
    executablePath: process.env.RUNES_ELECTRON || path.join(root, "node_modules/electron/dist/electron"),
    args: ["--no-sandbox", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--user-data-dir=" + profile, ...(process.env.RUNES_ELECTRON ? [] : [root]), project],
    cwd: root,
    env: { ...process.env, RUNES_MARKETPLACE: `http://127.0.0.1:${registry.address().port}`, ...gitEnv },
  });
  const p = await app.firstWindow();
  page = p;
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  if (process.env.RUNES_CONSOLE) p.on("console", (m) => console.log("PAGE " + m.text().slice(0, 400)));
  const K = (k) => p.keyboard.press(k);
  // Lustre draws on the next frame, so everything read from the page waits for two.
  const settle = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const status = async () => { await settle(); return (await p.locator(".status").textContent()) ?? ""; };
  const lines = async () => (await settle(), p.evaluate(() => [...document.querySelectorAll(".group.focused .row")].sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top)).map((r) => r.querySelector(".code").textContent)));
  // Rows are keyed, so their order in the page is not their order in the file: go by number.
  // Opens a folder of the explorer if it is shut, going by what the tree itself says once it is drawn.
  const unfold = async (name) => {
    const folder = p.locator(".tree.files .node.folder", { has: p.locator(".name", { hasText: new RegExp("^" + name + "$") }) });
    await folder.waitFor();
    if (!(await folder.evaluate((e) => e.classList.contains("open")))) await folder.click();
    await until("the folder open", async () => folder.evaluate((e) => e.classList.contains("open")), 4000);
  };
  // Moves down the list of suggestions to one of them, a step at a time, seeing each step land.
  const choose = async (label) => {
    const on = () => p.locator(".suggest .option.on b").textContent();
    for (let steps = 0; (await on()) !== label; steps++) {
      if (steps > 40) throw new Error("no suggestion called " + label);
      const before = await on();
      await K("ArrowDown");
      await until("the choice to move", async () => (await on()) !== before, 2000);
    }
  };
  const line = (n) => p.locator(".group.focused .row", { has: p.locator(".ln", { hasText: new RegExp("^" + n + "$") }) }).locator(".code");
  const css = (name) => p.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")); } catch { return {}; } };
  const shot = async (name) => { if (shots) await p.screenshot({ path: path.join(shots, name + ".png") }); };
  // Typing must wait until the palette has the keyboard, or the first letters land in the file.
  const typing = () => p.waitForFunction(() => document.activeElement?.id === "runes-palette", null, { timeout: 5000 });
  const commands = async () => { await K("Control+Shift+p"); await typing(); };
  const open = async (name) => { await K("Control+p"); await typing(); await p.keyboard.type(name); await p.waitForTimeout(120); await K("Enter"); await p.waitForTimeout(500); };
  const until = async (what, test, ms = 60000, nudge = null) => {
    const start = Date.now();
    let nudged = start;
    while (Date.now() - start < ms) {
      if (await test()) return;
      await p.waitForTimeout(200);
      // A language server that was still starting misses the first request; ask again.
      if (nudge && Date.now() - nudged > 8000) { nudged = Date.now(); await nudge(); }
    }
    throw new Error("Timed out waiting for " + what);
  };

  await check("starts, opens the folder and its README", async () => {
    await p.waitForSelector(".tab", { timeout: 20000 });
    expect((await p.locator(".node").allTextContents()).join().includes("bea.toml"), "the tree does not list bea.toml");
    expect((await status()).includes("Runes Void"), "the Void theme is not active: " + (await status()));
    expect((await css("--bg")) === "#000000", "theme colours were not applied");
    await until("the git branch in the status bar", async () => (await p.locator(".seg.branch").textContent().catch(() => "")) === "main", 5000);
    expect(!(await status()).startsWith("Runes"), "the status bar should not repeat the app's name");
  });

  await check("the bundled font is EnvyCodeR Nerd Font", async () => {
    expect(await p.evaluate(() => document.fonts.check('14px "EnvyCodeR Nerd Font"')), "the font did not load");
    expect((await css("--mono")).includes("EnvyCodeR"), "the editor is not set in EnvyCodeR");
  });

  await check("quick open finds a file, and its grammar colours it", async () => {
    await open("shop.bea");
    expect((await status()).includes("Bea"), "language is not Bea: " + (await status()));
    await until("coloured tokens", async () => (await p.locator(".group.focused .code span[style]").count()) > 5, 8000);
    expect((await p.locator(".node .file-icon").count()) > 0, "no file icons from the icon theme");
  });

  await check("ships with syntax only: nothing built in runs code", async () => {
    await K("Control+Shift+x");
    await p.waitForSelector(".ext-tabs");
    const tabs = await p.locator(".ext-tab").allTextContents();
    expect(tabs.length === 3 && tabs[0].startsWith("Installed") && tabs[1].startsWith("Marketplace") && tabs[2].startsWith("Built in"), "tabs: " + tabs.join(" | "));
    expect((await p.locator(".ext").count()) === 0, "nothing should be installed yet");
    await p.locator(".ext-tab", { hasText: "Built in" }).click();
    await p.waitForSelector(".ext-list.compact .ext");
    const names = await p.locator(".ext-list.compact .ext b").allTextContents();
    expect(names.includes("Bea Syntax") && names.includes("Gleam Syntax") && names.includes("Runes Themes"), "built-in list: " + names.join());
    expect((await p.locator(".ext.runs").count()) === 0, "a built-in extension runs code");
    await shot("extensions");
    await p.locator(".ext-tab", { hasText: "Installed" }).click();
  });

  await check("the Bea extension installs from a VSIX once the user agrees", async () => {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".side header .button", { hasText: "Install" }).click()]);
    await chooser.setFiles(path.join(root, "extensions/prebuilt/adimj11.bea-vscode.vsix"));
    await until("the install", async () => (await p.locator(".ext.runs b").allTextContents()).includes("Bea Programming Toolkit"), 10000);
    expect(fs.readdirSync(path.join(profile, "extensions")).length === 1, "the VSIX was not stored");
    await K("Control+Shift+e");
    await line(1).click({ position: { x: 4, y: 8 } });
  });

  await check("typing, auto-closing brackets, undo and redo", async () => {
    await K("Control+End");
    await p.keyboard.type("pub def hi() {");
    await K("Enter");
    await p.keyboard.type('"x');
    let text = (await lines()).join("\n");
    expect(text.includes('pub def hi() {\n  "x"\n}'), "unexpected text:\n" + text);
    for (let i = 0; i < 8; i++) await K("Control+z");
    text = (await lines()).join("\n");
    expect(!text.includes("pub def hi"), "undo did not remove the edit");
    await K("Control+s");
    await until("the tab to lose its unsaved mark", async () => (await p.locator(".tab.dirty").count()) === 0, 5000);
  });

  await check("language server: a type error becomes a squiggle and a problem", async () => {
    await line(4).click({ position: { x: 4, y: 8 } });
    await K("End");
    await p.keyboard.type(' + "two"');
    await K("Control+s");
    await until("the type error", async () => ((await p.locator(".group.focused runes-minimap").getAttribute("marks")) ?? "").includes("3:1"), 120000, () => K("Control+s"));
    expect((await p.locator(".squiggle.sev-1").count()) > 0, "no error squiggle");
    await K("Control+Shift+m");
    await p.waitForSelector(".problem");
    expect((await p.locator(".problem").first().textContent()).includes("shop.bea"), "the problem list does not name the file");
    const marks = await p.locator(".group.focused runes-minimap").getAttribute("marks");
    expect(marks.includes("3:1"), "the minimap has no error mark on line 4: " + JSON.stringify(marks) + " / " + (await p.locator(".problem").allTextContents()).join(" | "));
    await shot("problems");
  });

  await check("clicking a problem jumps to it; fixing the code clears it", async () => {
    await K("Control+Home");
    await p.locator(".problem").first().click();
    expect((await status()).includes("Ln 4"), "did not jump to line 4: " + (await status()));
    await K("Control+z");
    await K("Control+s");
    await until("problems to clear", async () => (await p.locator(".squiggle").count()) === 0, 120000, () => K("Control+s"));
    await K("Control+j");
  });

  await check("language server: go to definition (F12)", async () => {
    await line(8).click({ position: { x: 150, y: 8 } });
    expect((await status()).includes("Ln 8"), "click did not land on line 8");
    await K("F12");
    await until("the cursor to move to the definition", async () => (await status()).includes("Ln 3"), 20000);
  });

  await check("language server: completion fits what is typed, takes types and modules, and brings the import", async () => {
    const options = () => p.locator(".suggest .option b").allTextContents();
    const back = async () => { await K("Escape"); for (let i = 0; i < 60 && (await lines()).join("\n") !== source; i++) await K("Control+z"); expect((await lines()).join("\n") === source, "could not get back to the file as it was"); };
    // A function of a module that is imported: only what fits is listed, the best first, and taking it writes it once.
    await K("Control+End");
    await p.keyboard.type("pub def n() -> String {");
    await K("Enter");
    await p.keyboard.type("int.");
    await until("everything the module has, in a list that scrolls", async () => { const all = await options(); return all.length > 12 && all.includes("int.parse") && all.every((t) => t.startsWith("int.")); }, 30000, async () => { await K("Backspace"); await p.keyboard.type("."); });
    const box = await p.locator(".suggest").evaluate((e) => [e.scrollHeight > e.clientHeight, e.clientHeight]);
    expect(box[0] && box[1] < 320, "the list should scroll in a box of its own: " + box.join());
    await p.keyboard.type("to_s");
    await until("the list narrowed to what fits", async () => { const all = await options(); return all[0] === "int.to_string" && all.every((t) => /to.*s/i.test(t)); }, 8000);
    await until("what the chosen one is for, beside the list", async () => ((await p.locator(".suggest-doc").textContent().catch(() => "")) ?? "").length > 10, 8000);
    await shot("completion");
    // Taking a letter back keeps the list; going down it keeps the choice in sight.
    await K("Backspace");
    expect((await options()).includes("int.to_string"), "the list closed on Backspace");
    await p.keyboard.type("s");
    await K("Enter");
    await until("the function written once", async () => (await lines()).some((l) => l.trim().startsWith("int.to_string")) && !(await lines()).join("\n").includes("int.int."), 4000);
    await back();

    // A type, where a type goes.
    await K("Control+End");
    await p.keyboard.type("pub def t(a: Int, b: Stri");
    await until("the type", async () => (await options()).includes("String"), 20000);
    expect((await options())[0] === "String", "String should come first: " + (await options()).slice(0, 4).join());
    await K("Enter");
    await until("the type written", async () => (await lines()).some((l) => l.includes("b: String")), 4000);
    await back();

    // A function of a module that is not imported yet: taking it adds the import, and the cursor stays on its line.
    await K("Control+End");
    await p.keyboard.type("pub def say() {");
    await K("Enter");
    await p.keyboard.type("io.prin");
    await until("functions of a module not yet imported", async () => (await options()).some((t) => t === "io.println"), 20000);
    expect((await options()).every((t) => /p.*r.*i.*n/i.test(t)), "the list holds what does not fit: " + (await options()).slice(0, 6).join());
    await choose("io.println");
    await K("Enter");
    const said = async () => (await lines()).filter((l) => l.includes("io.println"));
    await until("the call written", async () => (await said()).length === 1, 4000);
    expect((await said())[0].trim() === "io.println()", "the call was not written cleanly: " + JSON.stringify(await said()));
    await p.keyboard.type('"hi"');
    expect((await said())[0].trim() === 'io.println("hi")', "the cursor was not left between the brackets: " + JSON.stringify(await said()));
    // By its bare name: what is written is what the server says, module and all, with the cursor between the brackets.
    await K("End"); await K("Enter");
    await p.keyboard.type("percent_enc");
    await until("a function by its bare name", async () => (await options()).includes("percent_encode"), 20000);
    await choose("percent_encode");
    await K("Enter");
    await p.keyboard.type('"a b"');
    const encoded = (await lines()).filter((l) => l.includes("percent_encode"));
    expect(encoded.length === 1 && encoded[0].trim() === 'uri.percent_encode("a b")', "the server's own text was not what was written: " + JSON.stringify(encoded));
    await back();

    // A module's path: the list stays through the slash, and narrows after it.
    await K("Control+Home"); await K("End"); await K("Enter");
    await p.keyboard.type("import glea");
    await until("modules", async () => (await options()).includes("gleam/string"), 20000);
    await p.keyboard.type("m/");
    await p.waitForTimeout(400);
    expect((await options()).includes("gleam/string"), "the list went away at the slash: " + (await options()).slice(0, 5).join());
    await p.keyboard.type("str");
    await until("only what fits after the slash", async () => { const all = await options(); return all.length > 0 && all[0].startsWith("gleam/str") && all.includes("gleam/string") && all.every((t) => /^gleam\/.*s.*t.*r/.test(t)); }, 8000);
    await choose("gleam/string");
    await K("Enter");
    await until("the path written once", async () => (await lines())[1] === "import gleam/string", 4000);
    await back();

    // The same snippet from two extensions (the one that ships and the one installed) is offered once.
    await K("Control+End");
    await p.keyboard.type("defc");
    await until("the snippet", async () => (await options()).includes("defc"), 8000);
    await p.waitForTimeout(500);
    const twice = await p.locator(".suggest .option").evaluateAll((all) => all.map((o) => o.textContent).filter((t, i, list) => list.indexOf(t) !== i));
    expect(twice.length === 0, "offered twice: " + twice.join(" | "));
    await back();
    await K("Control+s");
  });

  await check("language server: a hover is drawn as the document it is", async () => {
    await p.locator(".group.focused .content").hover({ position: { x: 5, y: 300 } });
    const at = await line(8).evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2 }; });
    const ch = await p.evaluate(() => { const probe = document.createElement("span"); probe.textContent = "0".repeat(20); probe.style.cssText = "position:absolute;visibility:hidden;font:inherit"; document.querySelector(".group.focused .content").append(probe); const w = probe.getBoundingClientRect().width / 20; probe.remove(); return w; });
    const gutter = await p.locator(".group.focused .content").evaluate((e) => parseFloat(getComputedStyle(e).getPropertyValue("--gutter")) || 0);
    const text = (await lines())[7];
    const col = text.indexOf("to_string") + 3;
    const x = await line(8).evaluate((e, col) => { const range = document.createRange(); const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let left = col, node; while ((node = walker.nextNode())) { if (left <= node.length) { range.setStart(node, left); range.setEnd(node, left); return range.getBoundingClientRect().left; } left -= node.length; } return 0; }, col);
    await p.mouse.move(x || at.x + gutter + ch * col, at.y);
    await p.mouse.move((x || at.x + gutter + ch * col) + 2, at.y);
    await until("the hover", async () => (await p.locator(".hover .hover-doc").count()) === 1, 20000, async () => { await p.mouse.move(x + 6, at.y + 1); await p.mouse.move(x + 2, at.y); });
    const drawn = await p.locator(".hover .hover-doc").evaluate((e) => ({ text: e.textContent, code: e.querySelectorAll("pre.md-code").length, coloured: e.querySelectorAll("pre.md-code span[style]").length, heads: e.querySelectorAll("h1,h2,h3,h4").length, links: e.querySelectorAll("a[data-href]").length, script: e.querySelectorAll("script,iframe,img").length }));
    expect(/String|Int/.test(drawn.text), "the hover says nothing of the code: " + drawn.text.slice(0, 80));
    expect(drawn.code >= 1 && !drawn.text.includes("```") && !/^#+ /m.test(drawn.text) && !/\]\(https?:/.test(drawn.text), "Markdown was left as written: " + JSON.stringify(drawn).slice(0, 300));
    expect(drawn.coloured > 0, "the code in it is not coloured");
    expect(drawn.script === 0, "the hover holds what it should not");
    await shot("hover");
    await p.locator(".group.focused .content").hover({ position: { x: 5, y: 400 } });
    await K("Escape");
  });

  await check("language server: format document", async () => {
    await line(4).click({ position: { x: 4, y: 8 } });
    await K("Home"); await K("Home");
    await p.keyboard.type("      ");
    await K("Shift+Alt+f");
    await until("the formatter", async () => (await lines())[3] === "  n * 2", 40000, () => K("Shift+Alt+f"));
  });

  await check("minimap draws blocks and shows the viewport", async () => {
    const box = await p.locator(".group.focused runes-minimap .minimap-slider").boundingBox();
    expect(box && box.height > 10, "no viewport overlay");
    const inked = await p.evaluate(() => { const c = document.querySelector(".group.focused runes-minimap canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, 40).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
    expect(inked > 20, "the minimap is empty");
  });

  await check("find and replace in the file", async () => {
    await K("Control+h");
    await p.waitForSelector("#runes-find");
    await p.keyboard.type("double");
    await p.waitForTimeout(200);
    expect((await p.locator(".find .count").textContent()).includes("of 2"), "expected 2 matches: " + (await p.locator(".find .count").textContent()));
    await p.locator('.find input[placeholder="Replace"]').fill("twice");
    await p.locator(".find .button", { hasText: "All" }).click();
    expect((await lines()).join("\n").includes("pub def twice(n: Int)"), "replace all did nothing");
    await p.locator(".find .mini[title^=Close]").click();
    await K("Control+z");
    expect((await lines()).join("\n").includes("pub def double(n: Int)"), "undo of replace all failed");
  });

  await check("search across the folder", async () => {
    await K("Control+Shift+f");
    await p.waitForSelector("#runes-search");
    await p.locator("#runes-search").fill("double");
    await K("Enter");
    await until("results", async () => (await p.locator(".hit").count()) >= 3, 8000);
    expect((await p.locator(".hit-file").allTextContents()).join().includes("notes.md"), "notes.md is missing from the results");
    await shot("search");
    await p.locator(".hit", { hasText: "the fun" }).click();
    await p.waitForTimeout(400);
    expect((await status()).includes("Markdown"), "clicking a result did not open it");
  });

  await check("tiling: split right, split down, maximise, close", async () => {
    await K("Control+\\");
    await p.waitForTimeout(350);
    expect((await p.locator(".group").count()) === 2, "expected two groups");
    await K("Control+Alt+\\");
    await p.waitForTimeout(350);
    expect((await p.locator(".group").count()) === 3 && (await p.locator(".split.stacked").count()) === 1, "expected a third group below");
    await shot("tiles");
    await K("Control+Alt+m");
    await until("one maximised group", async () => (await p.locator(".group").count()) === 1, 3000);
    await K("Control+Alt+m");
    await until("the tiles to come back", async () => (await p.locator(".group").count()) === 3, 3000);
    const sizes = await p.evaluate(() => [...document.querySelectorAll(".group")].map((g) => g.getBoundingClientRect().height));
    expect(sizes.every((h) => h > 200), "a group has collapsed: " + sizes.join());
    await K("Control+w"); await p.waitForTimeout(200); await K("Control+w"); await p.waitForTimeout(300);
    expect((await p.locator(".group").count()) === 1, "closing the tabs should remove the groups");
  });

  await check("tiling: dragging a tab to an edge makes a new group", async () => {
    await open("shop.bea");
    const tab = p.locator(".tab", { hasText: "shop.bea" });
    const area = await p.locator(".group").boundingBox();
    await tab.hover();
    await p.mouse.down();
    await p.mouse.move(area.x + area.width - 40, area.y + area.height / 2, { steps: 12 });
    await p.waitForTimeout(150);
    await p.mouse.up();
    await p.waitForTimeout(400);
    expect((await p.locator(".group").count()) === 2, "the drop did not split the group");
    await K("Control+w"); await p.waitForTimeout(300);
  });

  await check("terminal runs the shell", async () => {
    await K("Control+`");
    await p.waitForSelector("runes-terminal .xterm", { timeout: 10000 });
    await p.waitForTimeout(900);
    await p.keyboard.type("echo runes-$((6*7))");
    await K("Enter");
    await until("the command's output", async () => ((await p.locator("runes-terminal.shown .xterm-rows").textContent()) ?? "").includes("runes-42"), 10000);
    await shot("terminal");
    await K("Control+`");
  });

  await check("pie menu opens, and a slice runs its command", async () => {
    await p.locator(".group.focused .content").click({ position: { x: 300, y: 200 } });
    await K("Control+Shift+Space");
    await p.waitForSelector(".pie-hub");
    expect((await p.locator(".slice").count()) === 8, "expected 8 slices");
    await p.waitForTimeout(350);
    // On pitch black the pie must not sink into it: its own ground, and slices lifted clear of that.
    const stands = await p.evaluate(() => {
      const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const slice = getComputedStyle(document.querySelector(".slice:not(.on):not(:hover)"));
      const ground = getComputedStyle(document.querySelector(".pie"), "::before");
      return { slice: lum(slice.backgroundColor), text: lum(slice.color), border: slice.borderTopColor, ground: ground.width };
    });
    expect(stands.ground === "380px", "the pie has no ground of its own: " + stands.ground);
    expect((stands.slice + 0.05) / 0.05 >= 1.4, "a slice is as dark as the black behind it: " + stands.slice);
    expect((stands.text + 0.05) / (stands.slice + 0.05) >= 7, "slice text contrast: " + ((stands.text + 0.05) / (stands.slice + 0.05)).toFixed(1));
    await shot("pie");
    await p.locator(".slice", { hasText: "Problems" }).click();
    expect((await p.locator(".panel.open .ptab.on").textContent()).includes("Problems"), "the Problems slice did not open the panel");
    await K("Control+j");
  });

  await check("holding the right button opens the pie; releasing over a slice picks it", async () => {
    const box = await p.locator(".group.focused .content").boundingBox();
    const x = box.x + 400, y = box.y + 300;
    await p.mouse.move(x, y);
    await p.mouse.down({ button: "right" });
    await p.waitForSelector(".pie-hub", { timeout: 3000 });
    await p.mouse.move(x + 110, y, { steps: 6 });
    await p.waitForTimeout(120);
    expect((await p.locator(".slice.on").textContent()) === "Terminal", "the slice to the right should be Terminal, got " + (await p.locator(".slice.on").textContent().catch(() => "none")));
    await p.mouse.up({ button: "right" });
    await p.waitForSelector(".panel.open runes-terminal.shown");
    await K("Control+`");
  });

  await check("settings view: fields apply at once and are written to settings.json", async () => {
    await p.locator('.act[title^="Settings"]').click();
    await p.waitForSelector(".settings-page");
    const size = p.locator('.settings-page input[aria-label="editor.fontSize"]');
    await size.fill("17");
    await size.blur();
    await until("the new size", async () => (await css("--size")) === "17px", 5000);
    await until("the file on disk", async () => fs.readFileSync(path.join(profile, "settings.json"), "utf8").includes('"editor.fontSize": 17'), 5000);
    await p.locator('.settings-page input[aria-label="editor.minimap.enabled"]').click();
    await until("the minimap to go", async () => saved()["editor.minimap.enabled"] === false, 5000);
    await p.locator('.settings-page input[aria-label="editor.minimap.enabled"]').click();
    await shot("settings");
  });

  await check("settings view: the pie menu is edited there, as a tree", async () => {
    const rows = await p.locator(".pie-row").count();
    expect(rows === 16, "eight slices and the eight items inside two of them should be listed, got " + rows);
    await p.locator(".settings-page .button", { hasText: "Add a slice" }).click();
    await until("a ninth slice", async () => (await p.locator(".pie-row").count()) === 17, 3000);
    await p.locator('.pie-row input[aria-label="Label of slice 9"]').fill("Graph");
    await p.locator('.pie-row input[aria-label="Label of slice 9"]').blur();
    await p.locator('.pie-row select[aria-label="Command of slice 9"]').selectOption("runes.gitGraph");
    await until("the file on disk", async () => { const pie = saved()["runes.pie.items"]; return pie?.length === 9 && pie[8].label === "Graph" && pie[8].command === "runes.gitGraph"; }, 5000);
    // An item inside a plain slice makes it a submenu; items can be renamed, moved and removed.
    await p.locator('.pie-row .mini[title="Add an item inside slice 9"]').click();
    await until("the new item", async () => (await p.locator('.pie-row input[aria-label="Label of slice 9.1"]').count()) === 1, 3000);
    await p.locator('.pie-row input[aria-label="Label of slice 9.1"]').fill("Sessions");
    await p.locator('.pie-row input[aria-label="Label of slice 9.1"]').blur();
    await p.locator('.pie-row select[aria-label="Command of slice 9.1"]').selectOption("runes.sessions");
    await until("the nested item on disk", async () => { const s9 = saved()["runes.pie.items"]?.[8]; return s9?.items?.length === 1 && s9.items[0].label === "Sessions" && s9.items[0].command === "runes.sessions" && s9.command === "runes.gitGraph"; }, 5000);
    await p.locator('.pie-row .mini[title="Move slice 7.1 later"]').click();
    await until("the move", async () => saved()["runes.pie.items"][6].items.map((i) => i.label).join() === "Panel,Side Bar,Maximize,Settings", 5000);
    await p.locator('.pie-row .mini[title="Move slice 7.2 earlier"]').click();
    await p.locator('.pie-row .mini[title="Remove slice 9.1"]').click();
    await until("the removal", async () => { const pie = saved()["runes.pie.items"]; return pie[8].items === undefined && pie[8].command === "runes.gitGraph" && pie[6].items[0].label === "Side Bar"; }, 5000);
    await K("Control+Shift+Space");
    await p.waitForSelector(".pie-hub");
    expect((await p.locator(".slice").count()) === 9, "the pie did not gain a slice");
    await p.locator(".slice", { hasText: "Graph" }).click();
    await p.waitForSelector(".graph-page");
    await K("Control+w");
  });

  await check("pie: submenus open on a pick, and the centre steps back", async () => {
    await K("Control+Shift+Space");
    await p.waitForSelector(".pie-hub");
    expect((await p.locator(".slice.more").count()) === 2, "View and Git should be marked as holding more");
    await p.locator(".slice", { hasText: "Git" }).click();
    await until("the Git items", async () => (await p.locator(".slice").allTextContents()).join() === "Changes,Graph,Compare,Branch", 3000);
    expect((await p.locator(".pie-hub").textContent()).includes("Git"), "the hub does not say which submenu this is");
    expect((await p.locator(".pie-trail polyline").count()) === 1, "no line shows the way back");
    await shot("pie-submenu");
    await p.locator(".pie-hub").click();
    await until("the top level again", async () => (await p.locator(".slice").count()) === 9, 3000);
    await p.locator(".slice", { hasText: "Git" }).click();
    await until("the Git items again", async () => (await p.locator(".slice").count()) === 4, 3000);
    await p.locator(".slice", { hasText: "Changes" }).click();
    await until("Source Control", async () => (await p.locator('.side[data-side="git"]').count()) === 1 && (await p.locator(".pie").count()) === 0, 3000);
    await K("Control+Shift+e");
  });

  await check("pie: a pick counts however far out, and one stroke can go through a submenu", async () => {
    // Far outside the ring, in a slice's direction: a click still picks it (slice 1 points up).
    await K("Control+Shift+Space");
    await p.waitForSelector(".pie-hub");
    const hub = await p.locator(".pie-hub").boundingBox();
    const cx = hub.x + hub.width / 2, cy = hub.y + hub.height / 2;
    await p.mouse.move(cx + 6, cy - 260, { steps: 4 });
    expect((await p.locator(".slice.on").textContent()) === "Go to File", "the slice that way is not lit");
    await p.mouse.click(cx + 6, cy - 260);
    await typing();
    await K("Escape");
    // Hold the right button, drag out past View, on into its items, and let go on one.
    const box = await p.locator(".group.focused").boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await p.mouse.move(x, y);
    await p.mouse.down({ button: "right" });
    await p.waitForSelector(".pie-hub", { timeout: 3000 });
    const count = await p.locator(".slice").count();
    const view = (await p.locator(".slice").allTextContents()).indexOf("View");
    const turn = (view / count) * 2 * Math.PI;
    const far = { x: x + Math.sin(turn) * 200, y: y - Math.cos(turn) * 200 };
    await p.mouse.move(far.x, far.y, { steps: 10 });
    await until("the View items, under the pointer", async () => (await p.locator(".slice").allTextContents()).join() === "Side Bar,Panel,Maximize,Settings", 3000);
    const sub = await p.locator(".pie-hub").boundingBox();
    const sx = sub.x + sub.width / 2, sy = sub.y + sub.height / 2;
    expect(Math.hypot(sx - x, sy - y) > 165 && Math.hypot(sx - far.x, sy - far.y) < 40, "the submenu did not open under the pointer, out past the ring");
    // Settings is the fourth of four: it points left.
    await p.mouse.move(sx - 120, sy, { steps: 8 });
    expect((await p.locator(".slice.on").textContent()) === "Settings", "got " + (await p.locator(".slice.on").textContent().catch(() => "none")));
    await p.mouse.up({ button: "right" });
    await p.waitForSelector(".settings-page");
    await until("the pie to close", async () => (await p.locator(".pie").count()) === 0, 3000);
    expect((await p.locator(".settings-page").textContent()).toLowerCase().includes("opacity") === false, "the opacity setting is still offered");
    await K("Control+w");
  });

  await check("fonts are added to Runes itself, then chosen in settings", async () => {
    const mono = ["LiberationMono-Regular.ttf", "LiberationMono-Bold.ttf"].map((f) => path.join("/usr/share/fonts/truetype/liberation", f));
    if (!mono.every((f) => fs.existsSync(f))) { console.log("      (skipped: this machine has no Liberation Mono to add)"); return; }
    await K("Control+,");
    await p.waitForSelector('select[aria-label="editor.fontFamily"]');
    const offered = () => p.locator('select[aria-label="editor.fontFamily"] option').allTextContents();
    expect((await offered()).join() === "EnvyCodeR Nerd Font", "only the bundled font should be offered at first: " + (await offered()).join());
    const faces = () => p.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Liberation Mono" && f.status === "loaded").map((f) => f.weight).sort().join());
    expect((await faces()) === "", "the font is somehow already loaded");
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".font-list .button", { hasText: "Add font files" }).click()]);
    expect(chooser.isMultiple(), "several files should be addable at once");
    await chooser.setFiles(mono);
    await until("the family to be listed", async () => (await offered()).includes("Liberation Mono"), 6000);
    expect((await p.locator(".font-chip").count()) === 1, "two files of one family are one font");
    expect(fs.readdirSync(path.join(profile, "fonts")).sort().join() === "LiberationMono-Bold.ttf,LiberationMono-Regular.ttf", "the files were not kept in the profile");
    await p.locator('select[aria-label="editor.fontFamily"]').selectOption("Liberation Mono");
    await until("the editor to be set in it", async () => (await css("--mono")).startsWith('"Liberation Mono"') && saved()["editor.fontFamily"] === "Liberation Mono", 4000);
    expect((await faces()) === "400,700", "the regular and bold faces should both be loaded, got: " + (await faces()));
    const widths = await p.evaluate(() => { const c = document.createElement("canvas").getContext("2d"); return ['14px "Liberation Mono"', '14px "EnvyCodeR Nerd Font"'].map((f) => { c.font = f; return c.measureText("mmmmmmmmmm").width; }); });
    expect(widths[0] !== widths[1], "text in the added font measures the same as the bundled one, so it is not being used");
    await shot("fonts");
    // Something that is not a font is refused, and says so.
    const [again] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".font-list .button", { hasText: "Add font files" }).click()]);
    await again.setFiles({ name: "fake.ttf", mimeType: "font/ttf", buffer: Buffer.alloc(500, 65) });
    await until("the refusal", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("not a font file"), 5000);
    // Removing the font in use goes back to the bundled one.
    await p.locator('.font-chip .mini[title="Remove the font Liberation Mono"]').click();
    await until("the bundled font again", async () => (await css("--mono")).startsWith('"EnvyCodeR Nerd Font"') && (await offered()).join() === "EnvyCodeR Nerd Font" && (await faces()) === "", 4000);
    expect(fs.readdirSync(path.join(profile, "fonts")).length === 0, "the font's files are still in the profile");
    await K("Control+w");
  });

  await check("Ctrl+wheel zooms the text", async () => {
    await open("shop.bea");
    await p.mouse.move(700, 400);
    await p.keyboard.down("Control"); await p.mouse.wheel(0, -100); await p.keyboard.up("Control");
    await until("zoom", async () => (await css("--size")) === "18px", 3000);
    await K("Control+0");
  });

  await check("two themes ship: Runes Void, and the light Runes Glacier", async () => {
    await K("Control+k");
    await typing();
    const themes = await p.locator(".result span:first-child").allTextContents();
    expect(themes.join() === "Runes Void,Runes Glacier", "themes offered: " + themes.join());
    await p.keyboard.type("glacier"); await K("Enter");
    await until("the light theme", async () => (await css("--bg")) === "#e7eef1" && (await p.evaluate(() => document.documentElement.dataset.kind)) === "light", 4000);
    // Colours cross-fade when the theme changes; look once they have arrived.
    await until("the cyan accent", async () => (await p.evaluate(() => getComputedStyle(document.querySelector(".mark")).backgroundColor)) === "rgb(8, 122, 145)", 4000);
    // Light, but not white: every large surface is tinted, and text keeps its contrast.
    const facts = await p.evaluate(() => {
      const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const of = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      return {
        white: [".editor, .welcome", ".side", ".activity", ".status"].filter((sel) => document.querySelector(sel) && rgb(of(sel, "backgroundColor")).every((v) => v > 250)),
        text: ratio(of(".side", "color"), of(".side", "backgroundColor")),
        accent: of(".mark", "backgroundColor"),
      };
    });
    expect(facts.white.length === 0, "pure white surfaces: " + facts.white.join());
    // The side bar is a clear step darker than the editor, and the file icons are deepened to stand on it.
    const side = await p.evaluate(() => {
      const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      return { side: lum(getComputedStyle(document.querySelector(".side")).backgroundColor), editor: lum(getComputedStyle(document.documentElement).getPropertyValue("--bg") === "#e7eef1" ? "rgb(231, 238, 241)" : "rgb(0,0,0)"), icon: getComputedStyle(document.querySelector(".node .file-icon") ?? document.body).filter };
    });
    expect(side.editor - side.side > 0.12, "the side bar is not clearly darker than the editor: " + JSON.stringify(side));
    expect(side.icon.includes("brightness"), "file icons are not deepened on a light theme: " + side.icon);
    expect(facts.text >= 4.5, "side bar text contrast is " + facts.text.toFixed(2));
    expect(facts.accent === "rgb(8, 122, 145)", "the accent should be the cyan: " + facts.accent);
    await shot("glacier");
    await K("Control+k"); await typing(); await p.keyboard.type("void"); await K("Enter");
    await until("Void again", async () => (await css("--bg")) === "#000000", 4000);
    expect((await p.locator(".welcome .tagline, .welcome p").first().textContent().catch(() => "")) !== "A code editor written in Bea.", "the old tagline is still shown");
  });

  await check("the logo keeps its size, and a light traces the rune instead of a ring", async () => {
    const size = () => p.evaluate(() => { const r = document.querySelector(".mark").getBoundingClientRect(); return r.width + "x" + r.height; });
    const before = await size();
    await p.waitForTimeout(1600);
    expect(before === "30x30" && (await size()) === before, "the mark changed size: " + before + " then " + (await size()));
    const facts = await p.evaluate(() => ({
      light: getComputedStyle(document.querySelector(".mark .rune-light")).animationName,
      ring: getComputedStyle(document.querySelector(".mark"), "::after").content,
      box: getComputedStyle(document.querySelector(".mark")).animationName,
    }));
    expect(facts.light === "trace" && facts.ring === "none" && facts.box === "none", JSON.stringify(facts));
    const gear = await p.locator('.act[title^="Settings"] svg path').getAttribute("d");
    expect(gear.split("L").length === 32, "the settings icon should be a gear with eight teeth");
  });

  await check("Ctrl+A in a text field selects that field, not the file", async () => {
    await open("README.md");
    const before = (await lines()).join("\n");
    for (const [keys, field] of [["Control+Shift+x", "#runes-market"], ["Control+Shift+f", "#runes-search"]]) {
      await K(keys);
      await p.waitForSelector(field);
      await p.locator(field).fill("some words here");
      await p.locator(field).focus();
      await K("Control+a");
      expect((await p.evaluate((f) => { const e = document.querySelector(f); return e.value.slice(e.selectionStart, e.selectionEnd); }, field)) === "some words here", "the field's text was not selected in " + field);
      await p.keyboard.type("z");
      expect((await p.locator(field).inputValue()) === "z", "typing did not replace the field's text in " + field);
      await p.locator(field).fill("");
    }
    await K("Control+Shift+e");
    await line(1).click({ position: { x: 4, y: 8 } });
    expect((await lines()).join("\n") === before, "the file was changed");
    expect((await p.locator(".group.focused .sel").count()) === 0, "the file's text was selected");
  });

  await check("the theme is pitch black, with a colour for each kind of token", async () => {
    for (const part of [".editor", ".side", ".activity", ".tabbar", ".status"]) {
      const colour = await p.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, part);
      expect(colour === "rgb(0, 0, 0)", part + " is " + colour);
    }
    await open("shop.bea");
    await until("coloured tokens", async () => (await p.locator(".group.focused .code span[style]").count()) > 5, 8000);
    const colours = await p.evaluate(() => new Set([...document.querySelectorAll(".group.focused .code span[style]")].map((e) => e.style.color)).size);
    expect(colours >= 5, "only " + colours + " colours are used in a Bea file");
  });

  await check("the gutter marks lines added, changed and removed since the last commit", async () => {
    await open("README.md");
    await until("the committed version to arrive", async () => (await p.locator(".group.focused .gm").count()) === 0 && (await lines()).length > 3, 5000);
    await K("Control+End"); await p.keyboard.type("a new line"); await K("Enter");
    await until("an added mark", async () => (await p.locator(".group.focused .gm-add").count()) >= 1, 4000);
    await K("Control+Home"); await p.keyboard.type("x");
    await until("a changed mark", async () => (await p.locator(".group.focused .gm-mod").count()) === 1, 4000);
    await line(3).click({ position: { x: 4, y: 8 } }); await K("Home"); await K("Shift+ArrowDown"); await K("Backspace");
    await until("a removed mark", async () => (await p.locator(".group.focused .gm-del").count()) === 1, 4000);
    const colours = await p.evaluate(() => ["add", "mod"].map((k) => getComputedStyle(document.querySelector(".group.focused .gm-" + k), "::before").backgroundColor));
    expect(colours[0] === "rgb(63, 185, 80)" && colours[1] === "rgb(77, 159, 255)", "colours: " + colours.join());
    await shot("gutter");
    // Clicking a mark shows that change in place, with what was committed, and can put it back.
    await K("Control+Home");
    await p.locator(".group.focused .gm-mod").click({ position: { x: 3, y: 8 } });
    await p.waitForSelector(".peek");
    expect((await p.locator(".peek-line.gone").textContent()) === "−# Shop" && (await p.locator(".peek-line.new").textContent()) === "+x# Shop", "the change is not shown: " + (await p.locator(".peek-body").textContent()));
    expect((await p.locator(".peek-head b").textContent()) === "Change 1 of 3", "got " + (await p.locator(".peek-head b").textContent()));
    await shot("gutter-peek");
    await p.locator('.peek .mini[title^="Next change"]').click();
    await until("the next change", async () => (await p.locator(".peek-head b").textContent().catch(() => "")) === "Change 2 of 3", 3000);
    expect((await p.locator(".peek-head small").textContent()).includes("removed"), "the second change is the removed line");
    expect((await p.locator(".peek-line.gone").count()) === 1 && (await p.locator(".peek-line.new").count()) === 0, "a removal shows only what went");
    await p.locator(".peek .button", { hasText: "Revert" }).click();
    await until("the removed line to be back", async () => (await p.locator(".group.focused .gm-del").count()) === 0 && (await lines())[2] === "A sample project.", 3000);
    expect((await p.locator(".peek").count()) === 0, "the peek should close after reverting");
    await K("Control+z");
    await until("undo to take the revert back", async () => (await p.locator(".group.focused .gm-del").count()) === 1, 3000);
    await K("Alt+F3");
    await p.waitForSelector(".peek");
    await K("Escape");
    await until("Escape to close it", async () => (await p.locator(".peek").count()) === 0, 3000);
    for (let i = 0; i < 12; i++) await K("Control+z");
    await K("Control+s");
    await until("the marks to clear", async () => (await p.locator(".group.focused .gm").count()) === 0, 4000);
  });

  await check("several cursors: every occurrence, the next one, above and below, and by Alt+click", async () => {
    await open("many.txt");
    await until("the file", async () => (await lines())[0] === "foo bar foo", 4000);
    const carets = () => p.locator(".group.focused .caret").count();
    await line(1).click({ position: { x: 4, y: 8 } });
    await K("Control+Shift+l");
    await until("a cursor on every foo", async () => (await carets()) === 4 && (await status()).includes("4 cursors"), 3000);
    expect((await p.locator(".group.focused .sel").count()) === 4, "each occurrence should be selected");
    await shot("multi-cursor");
    await p.keyboard.type("quux");
    await until("the text at every cursor", async () => (await lines()).slice(0, 3).join("|") === "quux bar quux|x quux y|quuxd", 3000);
    await p.keyboard.type("!");
    expect((await lines()).slice(0, 3).join("|") === "quux! bar quux!|x quux! y|quux!d", "typing went astray: " + (await lines()).join("|"));
    await K("Backspace");
    expect((await lines())[0] === "quux bar quux", "backspace did not act at every cursor");
    // One undo takes back one keystroke everywhere, not one cursor's worth.
    await K("Control+z"); await K("Control+z"); await K("Control+z");
    await until("undo", async () => (await lines()).slice(0, 3).join("|") === "foo bar foo|x foo y|food", 3000);
    expect((await carets()) === 1, "undo should leave one cursor");
    // Ctrl+D: the word, then the next occurrence, one press at a time.
    await line(1).click({ position: { x: 4, y: 8 } });
    await K("Control+d");
    expect((await carets()) === 1 && (await p.locator(".group.focused .sel").count()) === 1, "the first Ctrl+D selects the word");
    await K("Control+d"); await K("Control+d");
    await until("three selections", async () => (await carets()) === 3, 3000);
    await K("Escape");
    await until("one cursor after Escape", async () => (await carets()) === 1, 3000);
    // A cursor on each line below, and one more by Alt+click; clicking plainly lets them go.
    await line(1).click({ position: { x: 4, y: 8 } });
    await K("Control+Alt+ArrowDown"); await K("Control+Alt+ArrowDown");
    await until("three cursors down the column", async () => (await carets()) === 3, 3000);
    await K("Home");
    await p.keyboard.type("> ");
    expect((await lines()).slice(0, 3).join("|") === "> foo bar foo|> x foo y|> food", "the column edit went astray: " + (await lines()).join("|"));
    await K("Control+z"); await K("Control+z");
    const box = await line(2).boundingBox();
    await line(1).click({ position: { x: 4, y: 8 } });
    await p.keyboard.down("Alt"); await p.mouse.click(box.x + 4, box.y + 8); await p.keyboard.up("Alt");
    await until("two cursors", async () => (await carets()) === 2, 3000);
    // Copy takes each cursor's line; paste of as many lines gives each cursor its own.
    await line(3).click({ position: { x: 4, y: 8 } });
    await until("a plain click to leave one cursor", async () => (await carets()) === 1, 3000);
    for (let i = 0; i < 12 && (await lines()).slice(0, 3).join("|") !== "foo bar foo|x foo y|food"; i++) await K("Control+z");
    await K("Control+s");
    await K("Control+w");
  });

  await check("splitting keeps every group where it was scrolled, and the groups slide", async () => {
    await open("long.txt");
    await until("the long file", async () => (await p.locator(".group.focused .row").count()) > 10, 4000);
    await p.evaluate(() => { document.querySelector(".group.focused .scroller").scrollTop = 3300; });
    await until("the scroll to be noticed", async () => (await lines()).some((l) => l === "line number 160"), 4000);
    // Every group must have text drawn across the whole of what it shows.
    const sound = () => p.evaluate(() => [...document.querySelectorAll(".group")].map((g) => {
      const s = g.querySelector(".scroller"); if (!s) return "no text";
      const tops = [...g.querySelectorAll(".row")].map((r) => parseInt(r.style.top));
      const row = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--row"));
      const end = parseInt(g.querySelector(".content").style.height) - 15 * row;
      const covered = tops.some((t) => t <= s.scrollTop) && tops.some((t) => t + row >= Math.min(s.scrollTop + s.clientHeight, end));
      return Math.round(s.scrollTop) + (covered ? " ok" : " BLANK");
    }));
    await K("Control+\\");
    const sliding = await p.evaluate(() => new Promise((done) => {
      let seen = 0;
      const began = performance.now();
      const look = () => {
        seen = Math.max(seen, document.getAnimations().filter((a) => a.effect?.target?.classList?.contains("group")).length);
        if (performance.now() - began > 350) done(seen); else requestAnimationFrame(look);
      };
      look();
    }));
    await until("two groups, both at the same place and fully drawn", async () => { const g = await sound(); return g.length === 2 && g.every((x) => x === "3300 ok"); }, 4000);
    expect(sliding >= 1, "the groups did not slide into place");
    await shot("split-kept");
    // Down as well, then close them again: the first group never loses its place.
    await K("Control+w");
    await until("one group, still in place", async () => { const g = await sound(); return g.length === 1 && g[0] === "3300 ok"; }, 4000);
    const tab = p.locator(".group.focused .tab.on");
    const from = await tab.boundingBox(), area = await p.locator(".group.focused").boundingBox();
    await open("many.txt");
    await p.mouse.move(from.x + 20, from.y + 10);
    const dragged = p.locator(".tab", { hasText: "many.txt" });
    const start = await dragged.boundingBox();
    await p.mouse.move(start.x + 20, start.y + 10); await p.mouse.down();
    await p.mouse.move(area.x + area.width / 2, area.y + area.height - 30, { steps: 12 });
    await p.waitForTimeout(150); await p.mouse.up();
    await until("a group below, and the long file above still in place", async () => { const g = await sound(); return g.length === 2 && g.some((x) => x === "3300 ok") && !g.some((x) => x.includes("BLANK")); }, 4000);
    await K("Control+w");
    await until("one group again", async () => (await p.locator(".group").count()) === 1, 3000);
    await until("the long file still in place and fully drawn", async () => (await sound())[0] === "3300 ok", 3000);
    await K("Control+w");
  });

  await check("maximise acts on the group whose button was pressed", async () => {
    await open("README.md");
    await K("Control+\\");
    await until("two groups", async () => (await p.locator(".group").count()) === 2, 3000);
    await open("notes.md");
    // The keyboard is in the right-hand group, showing notes.md. Press the left group's button.
    const other = p.locator(".group:not(.focused)");
    expect((await other.locator(".tab.on").textContent()).includes("README.md"), "the other group should show README.md");
    await other.locator('.tab-actions .mini[title^="Maximize"]').click();
    await until("only the group that was asked for", async () => (await p.locator(".group").count()) === 1 && (await p.locator(".group .tab.on").textContent()).includes("README.md"), 3000);
    await p.locator('.group .tab-actions .mini[title^="Maximize"]').click();
    await until("both again", async () => (await p.locator(".group").count()) === 2, 3000);
    await p.locator(".group", { has: p.locator(".tab.on", { hasText: "notes.md" }) }).locator(".content").click({ position: { x: 300, y: 200 } });
    await K("Control+w"); await K("Control+w");
    await until("one group", async () => (await p.locator(".group").count()) === 1, 3000);
    await K("Control+Shift+x");
    if (!(await p.locator(".ext-tabs").count())) await K("Control+Shift+x");
    await p.waitForSelector(".ext-tabs");
    expect((await p.evaluate(() => getComputedStyle(document.querySelector(".ext-tabs")).overflowX)) === "auto", "the extension tabs should scroll when they do not fit");
    await K("Control+Shift+e");
  });

  await check("SSH: a session is saved, connects with the questions asked in the window, and works on the other machine", async () => {
    const sshd = require("./sshd.cjs");
    const far = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runes-far-")));
    const site = path.join(far, "site");
    fs.mkdirSync(path.join(site, "pages"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.md"), "# The far site\n\nservedfromafar\n");
    fs.writeFileSync(path.join(site, "pages/about.md"), "# About\n");
    const farGit = (...args) => execFileSync("git", args, { cwd: site, stdio: "pipe" });
    farGit("init", "-q", "-b", "trunk"); farGit("config", "user.name", "Far"); farGit("config", "user.email", "far@example.com"); farGit("add", "-A"); farGit("commit", "-qm", "The far site");
    const server = await sshd.start({ dev: { password: "open-s3same" } }, far);
    try {
      await p.locator('.act[title="SSH Workbench"]').click();
      await p.waitForSelector(".ext-scroll.ssh");
      await p.locator(".side header .button", { hasText: "New session" }).click();
      await p.locator("#runes-ssh-name").fill("far box");
      await p.locator("#runes-ssh-host").fill("127.0.0.1");
      await p.locator("#runes-ssh-user").fill("dev");
      await p.locator("#runes-ssh-port").fill(String(server.port));
      await p.locator("#runes-ssh-folder").fill("~/site");
      // Signing in with a password only: no key is tried, so no key's passphrase is ever asked for.
      await p.locator("#runes-ssh-auth").selectOption("password");
      await until("the key field to go", async () => (await p.locator("#runes-ssh-key").count()) === 0, 2000);
      await p.locator(".ssh-form .button", { hasText: "Save" }).click();
      await until("the session to be listed", async () => (await p.locator(".ssh-session b").allTextContents()).includes("far box"), 4000);
      const kept = fs.readFileSync(path.join(profile, "ssh-sessions.json"), "utf8");
      expect(kept.includes("far box") && !kept.includes("open-s3same") && JSON.parse(kept)[0].auth === "password", "the session file is wrong");
      expect((await p.locator(".ssh-session small").textContent()).endsWith("· password"), "the list does not say how it signs in");
      await shot("ssh-sessions");
      // A bad session says why, and saves nothing.
      await p.locator(".side header .button", { hasText: "New session" }).click();
      await p.locator("#runes-ssh-host").fill("-oProxyCommand=evil"); await p.locator("#runes-ssh-user").fill("x");
      await p.locator(".ssh-form .button", { hasText: "Save" }).click();
      await until("the refusal", async () => ((await p.locator(".ssh-note").textContent().catch(() => "")) ?? "").includes("not a host name"), 3000);
      await p.locator(".ssh-form .button", { hasText: "Cancel" }).click();

      // Connecting: the machine's key is shown first, then the password is asked for, hidden.
      await p.locator('.ssh-session .button[aria-label="Connect to far box"]').click();
      await p.waitForSelector(".prompt");
      const print = require("../shell/ssh.cjs").fingerprint(server.hostKey());
      expect((await p.locator(".prompt b").textContent()).includes("for the first time") && (await p.locator(".prompt p").textContent()).includes(print), "the key's fingerprint is not shown: " + (await p.locator(".prompt").textContent()));
      await shot("ssh-first-time");
      await p.locator(".prompt .button", { hasText: "Trust and connect" }).click();
      await until("the password question", async () => ((await p.locator(".prompt b").textContent().catch(() => "")) ?? "") === "Password for dev@127.0.0.1", 6000);
      expect((await p.locator("#runes-prompt").getAttribute("type")) === "password", "the password is not hidden as it is typed");
      await p.locator("#runes-prompt").fill("wrong"); await K("Enter");
      await until("being asked again", async () => ((await p.locator(".prompt p").textContent().catch(() => "")) ?? "").includes("not accepted"), 6000);
      await p.locator("#runes-prompt").fill("open-s3same"); await K("Enter");
      await until("the session", async () => (await status()).includes("SSH: far box"), 10000);
      expect(!fs.readFileSync(path.join(profile, "ssh-sessions.json"), "utf8").includes("open-s3same") && !JSON.stringify(saved()).includes("open-s3same"), "the password was written down");
      expect(JSON.parse(fs.readFileSync(path.join(profile, "ssh-known-hosts.json"), "utf8"))["127.0.0.1:" + server.port] === print, "the key was not remembered");

      // The explorer is the other machine's folder.
      await K("Control+Shift+e");
      await until("the far folder's files", async () => { const names = await p.locator(".tree .node .name").allTextContents(); return names.includes("index.md") && names.includes("pages") && !names.includes("bea.toml"); }, 6000);
      await open("index.md");
      await until("the far file", async () => (await lines())[0] === "# The far site", 6000);
      await K("Control+End"); await p.keyboard.type("written from here"); await K("Control+s");
      await until("the save to land over there", async () => { try { return fs.readFileSync(path.join(site, "index.md"), "utf8").includes("written from here"); } catch { return false; } }, 6000);
      expect(fs.readdirSync(site).sort().join() === ".git,index.md,pages", "something was left behind: " + fs.readdirSync(site).join());
      expect(server.log.filter((l) => /^(key|password):/.test(l)).every((l) => l === "password:dev"), "something other than the password was tried");
      // Folders were listed ahead: with the machine now slow to answer, opening one does not wait for it.
      process.env.SSHD_LIST_DELAY = "1500";
      const before = Date.now();
      await p.locator(".tree .node.folder", { hasText: "pages" }).click();
      await until("the folder's files, at once", async () => (await p.locator(".tree .node .name").allTextContents()).includes("about.md"), 1200);
      expect(Date.now() - before < 1200, "opening a folder waited for the machine");
      process.env.SSHD_LIST_DELAY = "0";
      // A file made from the explorer is made over there, folders and all, and opened.
      await p.locator('.root-tools .mini[title="New file"]').click();
      await p.locator("#runes-naming").fill("drafts/note.md"); await K("Enter");
      await until("the new file over there, open here", async () => fs.existsSync(path.join(site, "pages/drafts/note.md")) && (await p.locator(".group.focused .tab.on").textContent()).includes("note.md"), 6000);
      // What another program does over there shows up by itself.
      fs.writeFileSync(path.join(site, "pages/arrived.md"), "x");
      await until("a file made on the machine itself", async () => (await p.locator(".tree .node .name").allTextContents()).includes("arrived.md"), 12000);
      // Deleting says there is no trash there, and waits for the answer.
      await p.locator(".tree .node", { hasText: "arrived.md" }).click({ button: "right" });
      await p.locator(".node-menu .result", { hasText: "Delete" }).click();
      await until("the question", async () => ((await p.locator(".prompt b").textContent().catch(() => "")) ?? "") === "Delete arrived.md for good?", 4000);
      expect((await p.locator(".prompt p").textContent()).includes("no trash"), "the question does not say it is for good");
      expect((await p.locator(".node-menu .result", { hasText: "File Manager" }).count()) === 0, "this machine's file manager cannot show a far file");
      await shot("ssh-delete");
      await p.locator(".prompt .button", { hasText: "Cancel" }).click();
      await p.waitForTimeout(300);
      expect(fs.existsSync(path.join(site, "pages/arrived.md")), "declined, yet deleted");
      await p.locator(".tree .node", { hasText: "arrived.md" }).click({ button: "right" });
      await p.locator(".node-menu .result", { hasText: "Delete" }).click();
      await p.locator(".prompt .button", { hasText: "Delete" }).click();
      await until("the file to be gone, there and here", async () => !fs.existsSync(path.join(site, "pages/arrived.md")) && !(await p.locator(".tree .node .name").allTextContents()).includes("arrived.md"), 6000);
      await p.locator(".tree .node.folder", { hasText: "drafts" }).click({ button: "right" });
      await p.locator(".node-menu .result", { hasText: "Delete" }).click();
      await p.locator(".prompt .button", { hasText: "Delete" }).click();
      await until("the folder and its file to be gone", async () => !fs.existsSync(path.join(site, "pages/drafts")) && (await p.locator(".tab", { hasText: "note.md" }).count()) === 0, 6000);
      await p.locator(".tree .node.folder", { hasText: "pages" }).click();
      // Git is the other machine's git.
      await until("the far branch and the change", async () => (await status()).includes("trunk"), 6000);
      await K("Control+Shift+g");
      await until("the change in source control", async () => (await p.locator(".side .change .change-name").allTextContents()).some((t) => t.includes("index.md")), 6000);
      await until("a mark in the gutter for the new line", async () => (await p.locator(".group.focused .gm").count()) >= 1, 6000);
      // Search runs over there.
      await K("Control+Shift+f");
      await p.locator("#runes-search").fill("servedfromafar"); await K("Enter");
      await until("the hit", async () => ((await p.locator(".side").textContent()) ?? "").includes("index.md"), 8000);
      // A terminal is a shell on the other machine, in the folder.
      await K("Control+`");
      await p.waitForSelector(".terminals runes-terminal.shown .xterm");
      await p.waitForTimeout(600);
      await p.keyboard.type("echo here-$USER-$(basename $(pwd))"); await K("Enter");
      await until("the far shell", async () => ((await p.locator(".terminals runes-terminal.shown .xterm-rows").textContent()) ?? "").includes("here-dev-site"), 8000);
      await shot("ssh-connected");
      await p.keyboard.type("exit"); await K("Enter");
      await until("the shell to close", async () => (await p.locator(".term-list .term-tab").count()) === 0, 6000);

      // Another folder on the same machine, then home again.
      await p.locator('.act[title="SSH Workbench"]').click();
      expect((await p.locator(".ssh-live b").textContent()) === "far box" && (await p.locator(".ssh-session.on .pill").textContent()) === "Connected", "the workbench does not show the connection");
      await p.locator('.ssh-live input[aria-label="Folder on the connected machine"]').fill(path.join(site, "pages")); await K("Enter");
      await K("Control+Shift+e");
      await until("the other folder", async () => { const names = await p.locator(".tree .node .name").allTextContents(); return names.join() === "about.md"; }, 6000);
      await p.locator('.act[title="SSH Workbench"]').click();
      await p.locator(".ssh-live .button", { hasText: "Disconnect" }).click();
      await until("this machine again", async () => !(await status()).includes("SSH:") && (await status()).includes("main"), 8000);
      await K("Control+Shift+e");
      await until("the local folder's files", async () => (await p.locator(".tree .node .name").allTextContents()).includes("bea.toml"), 6000);

      // Known now: no question about the key. And when the machine's key changes, it is refused before any password.
      await server.rekey();
      await p.locator('.act[title="SSH Workbench"]').click();
      await p.locator('.ssh-session .button[aria-label="Connect to far box"]').click();
      await until("the refusal", async () => ((await p.locator(".ssh-note").textContent().catch(() => "")) ?? "").includes("has changed since you first connected"), 8000);
      expect((await p.locator(".prompt").count()) === 0 && !(await status()).includes("SSH:"), "a changed key must not lead to a password question");
      // Forgetting the key is a deliberate act, after which the new one is shown to accept.
      await p.locator('.ssh-session .mini[title^="Forget the key"]').click();
      await p.locator('.ssh-session .button[aria-label="Connect to far box"]').click();
      await p.waitForSelector(".prompt");
      expect((await p.locator(".prompt p").textContent()).includes(require("../shell/ssh.cjs").fingerprint(server.hostKey())), "the new key is not shown");
      await p.locator(".prompt .button", { hasText: "Cancel" }).click();
      await until("nothing connected", async () => ((await p.locator(".ssh-note").textContent().catch(() => "")) ?? "").includes("was not accepted"), 6000);
      await p.locator('.ssh-session .mini[title="Remove far box"]').click();
      await until("the session to be removed", async () => (await p.locator(".ssh-session").count()) === 0, 3000);
      await K("Control+Shift+e");
    } finally { await server.close(); }
  });

  await check("source control: a change is staged and committed", async () => {
    fs.writeFileSync(path.join(project, "CHANGES.md"), "# Changes\n");
    await K("Control+Shift+g");
    await p.waitForSelector(".branch-line");
    expect((await p.locator(".branch-line b").textContent()) === "main", "wrong branch");
    await p.locator('.side .mini[title="Refresh"]').click();
    await until("the new file to be listed", async () => (await p.locator(".change").allTextContents()).some((t) => t.includes("CHANGES.md")), 5000);
    await p.locator('.mini[title="Stage CHANGES.md"]').click();
    await until("it to be staged", async () => (await p.locator('.mini[title="Unstage CHANGES.md"]').count()) === 1, 5000);
    await p.locator("#runes-commit").fill("Add a change log");
    await shot("source-control");
    await p.locator(".commit-form .button").click();
    await until("the commit", async () => execFileSync("git", ["log", "-1", "--format=%s"], { cwd: project }).toString().trim() === "Add a change log", 8000);
    await until("the change to leave the list", async () => !(await p.locator(".change").allTextContents()).some((t) => t.includes("CHANGES.md")), 5000);
  });

  await check("git graph: commits as nodes, branches in lanes, a merge, a legend", async () => {
    await p.locator(".side .button", { hasText: "Graph" }).click();
    await p.waitForSelector(".graph-page .commit");
    await until("five commits", async () => (await p.locator(".commit").count()) === 5, 5000);
    const subjects = await p.locator(".commit .subject").allTextContents();
    expect(subjects[0].includes("Add a change log") && subjects[4].includes("Start the shop"), "order: " + subjects.join(" | "));
    const legend = await p.locator(".legend-item").allTextContents();
    expect(legend.includes("main") && legend.includes("feature/notes"), "legend: " + legend.join());
    expect((await p.locator(".node.hollow").count()) === 1, "the merge commit should be drawn hollow");
    const lanes = await p.evaluate(() => [...document.querySelectorAll(".commit")].map((c) => c.querySelector(".node").getAttribute("class")));
    expect(new Set(lanes.map((l) => /l\d/.exec(l)[0])).size === 2, "expected two lanes, got " + lanes.join());
    expect((await p.locator(".ref.tag").textContent()) === "v0.1.0", "the tag is missing");
    await p.locator(".commit", { hasText: "More notes" }).click();
    await until("the files the commit changed", async () => (await p.locator(".detail-files .change").allTextContents()).some((t) => t.includes("notes.md")), 5000);
    expect((await p.locator(".commit-detail pre").count()) === 0, "the raw stat text is still shown");
    expect((await p.locator(".detail-subject").textContent()) === "More notes", "the commit's subject is missing");
    await shot("graph");
  });

  await check("sessions: a commit opens in its own tab, steps through history, and is listed", async () => {
    await p.locator(".detail-actions .button", { hasText: "Open as a session" }).click();
    await p.waitForSelector(".diff-page .drow");
    expect((await p.locator(".diff-commit b").textContent()) === "More notes", "the session does not say which commit it shows");
    // One clean text by default: the added line among the others, marked as added.
    expect((await p.locator(".diff-rows.one .drow.unew .right").allTextContents()).includes("more"), "the added line is not shown as added");
    expect((await p.locator(".diff-rows .dt.left").count()) === 0 && (await p.locator(".drow.unew .ds").first().textContent()) === "+", "an added line should stand alone, with its sign");
    const inline = await p.locator(".diff-rows .drow.usame .dt").first().evaluate((e) => e.getBoundingClientRect().width / e.closest(".diff-rows").getBoundingClientRect().width);
    expect(inline > 0.75, "one text should have the width to itself: " + inline);
    await shot("session-inline");
    // Two sides, only when asked for; and back.
    await p.locator(".diff-bar .split-toggle").click();
    await until("old and new side by side", async () => (await p.locator(".diff-rows.one").count()) === 0 && (await p.locator(".drow.knew .right").allTextContents()).includes("more") && (await p.locator(".drow.knew .left").count()) > 0, 3000);
    expect((await p.locator(".diff-bar .split-toggle").getAttribute("aria-pressed")) === "true", "the toggle does not say it is on");
    await shot("session-split");
    await p.locator(".diff-bar .split-toggle").click();
    await until("one text again", async () => (await p.locator(".diff-rows.one").count()) === 1, 3000);
    expect((await p.locator(".diff-files .change").allTextContents()).some((t) => t.includes("notes.md")), "the changed file is not listed");
    expect((await p.locator(".group.focused .tab.on").textContent()).includes("More notes"), "the tab is not named after the commit");
    await shot("session");
    // Time travel: the file as it was at that commit, in the editor, to read but not to change.
    await p.locator(".diff-head .open-file", { hasText: "Open as it was" }).click();
    await p.waitForSelector(".time-bar");
    await until("the file as it was then", async () => (await lines()).join("|") === "# Notes||double the fun||more|", 5000);
    expect(/notes\.md @ [0-9a-f]{7}/.test(await p.locator(".group.focused .tab.on").textContent()), "the tab does not say when: " + (await p.locator(".group.focused .tab.on").textContent()));
    expect((await p.locator(".time-about b").textContent()) === "More notes" && (await p.locator(".time-about small").textContent()).includes("version 2 of 2"), "the bar does not say which version: " + (await p.locator(".time-about").textContent()));
    await line(1).click({ position: { x: 4, y: 8 } });
    await p.keyboard.type("changed?"); await K("Backspace"); await K("Enter");
    expect((await lines()).join("|") === "# Notes||double the fun||more|", "the past was edited: " + (await lines()).join("|"));
    await shot("time-travel");
    await p.locator(".time-bar .button", { hasText: "Older" }).click();
    await until("the version before", async () => (await lines()).join("|") === "# Notes||double the fun|" && (await p.locator(".time-about small").textContent()).includes("version 1 of 2"), 5000);
    expect(await p.locator(".time-bar .button", { hasText: "Older" }).isDisabled(), "there is nothing older than the first version");
    await p.locator(".time-bar .button", { hasText: "Newer" }).click();
    await until("the newer one again", async () => (await lines()).includes("more"), 5000);
    await p.locator(".time-bar .button", { hasText: "Open current" }).click();
    await until("the file on disk", async () => (await p.locator(".group.focused .time-bar").count()) === 0 && (await p.locator(".group.focused .tab.on").textContent()).trim().endsWith("notes.md"), 4000);
    await K("Control+w");
    await p.locator(".tab", { hasText: /notes\.md @/ }).locator(".tab-close").click();
    // Every file there was at that commit, not only what it changed.
    await p.locator(".seg-pick.browse button", { hasText: "All files" }).click();
    await until("the whole tree at that commit", async () => { const all = await p.locator(".diff-files .change").allTextContents(); return all.some((t) => t.includes("bea.toml")) && all.some((t) => t.includes("src/shop.bea")); }, 5000);
    await p.locator(".tree-filter").fill("readme");
    await until("the filter", async () => (await p.locator(".diff-files .change").count()) === 1, 3000);
    await p.locator(".diff-files .change .change-name").click();
    await until("README as it was before the main line was written", async () => (await p.locator(".group.focused .time-bar").count()) === 1 && (await lines()).join("|") === "# Shop||A sample project.|", 5000);
    await K("Control+w");
    await p.locator(".tree-filter").fill("");
    await p.locator(".seg-pick.browse button", { hasText: "Changed" }).click();
    // Older and newer walk the history inside the same session.
    await p.locator(".diff-bar .button", { hasText: "Older" }).click();
    await until("the commit before", async () => (await p.locator(".diff-commit b").textContent()) !== "More notes", 5000);
    const older = await p.locator(".diff-commit b").textContent();
    await p.locator(".diff-bar .button", { hasText: "Newer" }).click();
    await until("the way back", async () => (await p.locator(".diff-commit b").textContent()) === "More notes", 5000);
    expect(older !== "More notes", "Older did not move");
    // The two fields say "the commit before it" and "the commit", in short names that fit.
    const refs = await p.locator(".diff-bar .diff-ref").evaluateAll((all) => all.map((e) => [e.value, e.title]));
    expect(/^[0-9a-f]{7}\^$/.test(refs[0][0]) && /^[0-9a-f]{7}$/.test(refs[1][0]) && refs[0][0] === refs[1][0] + "^", "the fields read " + refs.map((r) => r[0]).join(" and "));
    expect(/^[0-9a-f]{40}\^$/.test(refs[0][1]) && /^[0-9a-f]{40}$/.test(refs[1][1]), "the full names are not kept for a hover");
    // Comparing again from the short names still knows which commit it is.
    await p.locator(".diff-bar .button", { hasText: "Compare" }).click();
    await until("the same commit, compared again", async () => (await p.locator(".diff-commit b").textContent().catch(() => "")) === "More notes" && (await p.locator(".diff-rows .drow").count()) > 0, 5000);
    await p.locator(".diff-bar .button", { hasText: "Older" }).click();
    await until("older, from the short names", async () => (await p.locator(".diff-commit b").textContent()) === older, 5000);
    await p.locator(".diff-bar .button", { hasText: "Newer" }).click();
    await until("and back", async () => (await p.locator(".diff-commit b").textContent()) === "More notes", 5000);
    // A second session, from the graph, by marking one commit and comparing another with it.
    await commands(); await p.keyboard.type("Git: Open Graph"); await K("Enter");
    await p.waitForSelector(".graph-page .commit");
    await p.locator(".commit", { hasText: "Start the shop" }).click();
    await p.locator(".detail-actions .button", { hasText: "Mark to compare" }).click();
    await p.locator(".commit", { hasText: "Merge the notes" }).click();
    await p.locator(".detail-actions .button", { hasText: /Compare with [0-9a-f]{7}/ }).click();
    await until("both files of the comparison", async () => (await p.locator(".diff-files .change").count()) === 2, 5000);
    await K("Control+Shift+g");
    await until("two sessions in the list", async () => (await p.locator(".sessions .session").count()) === 2, 3000);
    await p.locator(".sessions .session", { hasText: "More notes" }).locator(".change-name").click();
    await until("the first session again", async () => (await p.locator(".group.focused .diff-commit b").textContent().catch(() => "")) === "More notes", 3000);
    await p.locator(".sessions .session", { hasText: "More notes" }).locator(".mini").click();
    await until("one session left", async () => (await p.locator(".sessions .session").count()) === 1, 3000);
  });

  await check("compare: branches by name, the working tree, and two files", async () => {
    await p.locator(".sessions .session .change-name").click();
    await p.locator('.diff-ref[aria-label="Compare from"]').fill("feature/notes");
    await p.locator('.diff-ref[aria-label="Compare to"]').fill("main");
    await K("Enter");
    await until("what main has that the branch does not", async () => (await p.locator(".diff-files .change").allTextContents()).some((t) => t.includes("README.md")), 5000);
    await until("the line added on main", async () => (await p.locator(".drow.unew .right").allTextContents()).includes("main line"), 5000);
    await p.locator('.diff-ref[aria-label="Compare from"]').fill("no-such-branch");
    await K("Enter");
    await until("git's own explanation", async () => /no-such-branch|unknown revision|bad revision/i.test((await p.locator(".diff-main .hint").textContent().catch(() => "")) ?? ""), 5000);
    // A file changed on disk, opened from Source Control: the last commit against my files.
    fs.appendFileSync(path.join(project, "src/notes.md"), "local edit\n");
    await p.locator('.side .mini[title="Refresh"]').click();
    await until("the change to be listed", async () => (await p.locator(".side .change .change-name").allTextContents()).some((t) => t.includes("notes.md")), 5000);
    await p.locator(".side .change", { hasText: "src/notes.md" }).locator(".change-name").click();
    await until("the local edit as an added line", async () => (await p.locator(".drow.unew .right").allTextContents()).includes("local edit"), 5000);
    expect((await p.locator(".diff-head").textContent()).includes("my files"), "the right side should be the working tree");
    await shot("diff");
    execFileSync("git", ["checkout", "--", "src/notes.md"], { cwd: project });
    // Two files that have nothing to do with git.
    await p.locator(".seg-pick button", { hasText: "Two files" }).click();
    await p.locator('.diff-ref[aria-label="Compare from"]').fill("README.md");
    await p.locator('.diff-ref[aria-label="Compare to"]').fill("src/notes.md");
    await K("Enter");
    await until("the two files, one taken away and one put in", async () => (await p.locator(".drow .left").allTextContents()).includes("# Shop") && (await p.locator(".drow .right").allTextContents()).includes("# Notes"), 5000);
    await K("Control+w");
    await p.locator('.side .mini[title="Refresh"]').click();
  });

  await check("branches: switching from the status bar reloads the open files", async () => {
    await open("README.md");
    await until("main's text", async () => (await lines()).includes("main line"), 4000);
    await p.locator(".status .branch").click();
    await typing();
    const offered = await p.locator(".result span:first-child").allTextContents();
    expect(offered.includes("main") && offered.includes("feature/notes") && !offered.includes("v0.1.0"), "branches offered: " + offered.join());
    await p.keyboard.type("feature"); await K("Enter");
    await until("the status bar to name the branch", async () => (await status()).includes("feature/notes"), 6000);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: project }).toString().trim() === "feature/notes", "git is not on the branch");
    await until("the open file to be the branch's version", async () => !(await lines()).includes("main line"), 5000);
    // And back, from the graph's own switcher.
    await commands(); await p.keyboard.type("Git: Open Graph"); await K("Enter");
    await p.locator(".graph-page .branch-switch").click();
    await typing();
    await p.keyboard.type("main"); await K("Enter");
    await until("main again", async () => (await status()).includes(" main") || (await p.locator(".status .branch").textContent()) === "main", 6000);
    // Git's refusal is passed on rather than forced through.
    fs.appendFileSync(path.join(project, "README.md"), "unsaved work\n");
    await p.locator(".graph-page .branch-switch").click();
    await typing();
    await p.keyboard.type("feature"); await K("Enter");
    await until("the refusal", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("Could not switch"), 6000);
    execFileSync("git", ["checkout", "--", "README.md"], { cwd: project });
  });

  await check("the calendar steps out to months and years", async () => {
    const year = new Date().getFullYear(), month = new Date().toLocaleString("en", { month: "long" });
    await commands(); await p.keyboard.type("Git: Open Graph"); await K("Enter");
    await p.waitForSelector(".calendar .cal-title");
    // A year is stepped with one sign, not two arrows laid over each other.
    const signs = await p.evaluate(() => ["Previous year", "Next year"].map((t) => document.querySelector(`.cal-head .mini[title="${t}"]`)?.querySelectorAll("svg").length));
    expect(signs.join() === "1,1", "year buttons hold " + signs.join() + " drawings");
    expect((await p.locator(".cal-title").textContent()) === month + " " + year, "got " + (await p.locator(".cal-title").textContent()));
    await p.locator(".cal-title").click();
    await until("the months of the year", async () => (await p.locator(".cal-month").count()) === 12 && (await p.locator(".cal-title").textContent()) === String(year), 3000);
    const lit = await p.locator(".cal-month.some").allTextContents();
    expect(lit.some((m) => m.startsWith(month.slice(0, 3)) && /\d+$/.test(m)), "the month with the commits should be lit, with its count: " + lit.join());
    await p.locator('.cal-head .mini[title="Previous year"]').click();
    await until("the year before", async () => (await p.locator(".cal-title").textContent()) === String(year - 1) && (await p.locator(".cal-month.some").count()) === 0, 3000);
    await p.locator(".cal-title").click();
    await until("the years", async () => (await p.locator(".cal-month").count()) === 12 && (await p.locator(".cal-month.some").allTextContents()).some((t) => t.startsWith(String(year))), 3000);
    await shot("calendar-years");
    await p.locator(".cal-month", { hasText: String(year) }).click();
    await until("that year's months", async () => (await p.locator(".cal-title").textContent()) === String(year), 3000);
    await p.locator(".cal-month.some", { hasText: month.slice(0, 3) }).click();
    await until("the month's days", async () => (await p.locator(".cal-title").textContent()) === month + " " + year && (await p.locator(".cal-day.some").count()) >= 1, 3000);
  });

  await check("git graph: the calendar jumps to a day's commits", async () => {
    // The history was written on 2 November 2026; the newest commit is today.
    for (let i = 0; i < 24 && !(await p.locator(".cal-title").textContent()).includes("November 2026"); i++) await p.locator('.mini[title="Previous month"]').click();
    const day = p.locator('.cal-day.some[title^="2026-11-02"]');
    expect((await day.getAttribute("title")).includes("4 commits"), "the day's count is wrong: " + (await day.getAttribute("title")));
    await day.click();
    await until("a commit of that day to be selected", async () => ((await p.locator(".commit.picked .subject").textContent().catch(() => "")) ?? "").includes("Merge the notes"), 3000);
    await K("Control+w");
  });

  await check("marketplace: search Open VSX and install from it", async () => {
    await K("Control+Shift+x");
    await p.locator("#runes-market").fill("sunset");
    await K("Enter");
    await until("a result", async () => (await p.locator(".ext", { hasText: "Sunset Theme" }).count()) === 1, 5000);
    expect((await p.locator(".ext", { hasText: "Sunset Theme" }).textContent()).includes("1.2M installs"), "the install count is not shown");
    expect((await p.locator(".ext-tab.on").textContent()).startsWith("Marketplace"), "searching should show the marketplace tab");
    expect((await p.locator(".side .ext .button").count()) === 0, "install and uninstall belong on the extension's page now");
    await shot("marketplace");
    // Its page: what it is, its readme, and the install button.
    await p.locator(".ext", { hasText: "Sunset Theme" }).click();
    await p.waitForSelector(".ext-page");
    expect((await p.locator(".ext-about h1").textContent()) === "Sunset Theme", "the page is not titled");
    await until("the readme", async () => ((await p.locator(".ext-page .markdown").textContent().catch(() => "")) ?? "").includes("Warm colours for the evening."), 6000);
    expect((await p.locator(".ext-page .markdown em").textContent()) === "evening", "the readme is not drawn as Markdown");
    expect((await p.evaluate(() => window.__readme)) !== true && (await p.locator(".ext-page .markdown script").count()) === 0, "a script in a readme must not run");
    expect((await p.locator(".ext-page .markdown a").getAttribute("href")) === null, "links must not navigate the window");
    await shot("extension-page");
    await p.locator(".ext-page .button", { hasText: "Install" }).click();
    await until("the install", async () => fs.existsSync(path.join(profile, "extensions/demo.sunset.vsix")), 8000);
    await until("the page to offer Uninstall", async () => (await p.locator(".ext-page .button", { hasText: "Uninstall" }).count()) === 1, 5000);
    await K("Control+k"); await typing();
    expect((await p.locator(".result").allTextContents()).some((t) => t.includes("Demo Sunset")), "the installed theme is not offered");
    await K("Escape");
    await K("Control+w");
  });

  await check("extensions show their own pictures", async () => {
    await K("Control+Shift+x");
    await p.locator("#runes-market").fill("sunset"); await K("Enter");
    await until("the marketplace picture", async () => p.evaluate(() => { const i = document.querySelector(".side .ext-list:not(.compact) .badge.pictured img"); return !!i && i.src.startsWith("data:image/png") && i.naturalWidth === 8; }), 6000);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".side header .button", { hasText: "Install" }).click()]);
    await chooser.setFiles(fixerVsix);
    await p.locator(".ext-tab", { hasText: "Installed" }).click();
    await until("the install", async () => (await p.locator(".ext.runs b").allTextContents()).includes("Demo Fixer"), 10000);
    await until("the installed extension's picture", async () => p.evaluate(() => { const i = [...document.querySelectorAll(".ext")].find((e) => e.textContent.includes("Demo Fixer"))?.querySelector(".badge.pictured img"); return !!i && i.src.startsWith("blob:") && i.naturalWidth === 8; }), 5000);
    await shot("extension-pictures");
    // An installed extension's page: what it adds, and Uninstall, which is no longer in the list.
    await p.locator(".side .ext", { hasText: "Sunset Theme" }).click();
    await p.waitForSelector(".ext-page");
    expect((await p.locator(".ext-page .chip").allTextContents()).some((t) => t.includes("theme: Demo Sunset")), "the page does not say what the extension adds");
    await p.locator(".ext-page .button", { hasText: "Uninstall" }).click();
    await until("the removal", async () => !fs.existsSync(path.join(profile, "extensions/demo.sunset.vsix")) && (await p.locator(".side .ext", { hasText: "Sunset Theme" }).count()) === 0, 6000);
    await until("the page to offer Install again", async () => (await p.locator(".ext-page .button", { hasText: "Install" }).count()) === 1, 4000);
    await K("Control+w");
  });

  await check("quick fixes from extensions: in the right-click menu and under Ctrl+.", async () => {
    await open("notes.md");
    await until("the file", async () => (await lines())[0] === "# Notes", 4000);
    const box = await p.locator(".group.focused .content").boundingBox();
    const offered = async () => {
      await K("Escape");
      await p.mouse.click(box.x + 120, box.y + 10, { button: "right" });
      await p.waitForSelector(".menu");
      await p.waitForTimeout(700);
      return (await p.locator(".menu .result.fix").count()) > 0;
    };
    await until("the fix in the menu", offered, 30000);
    await shot("quick-fix");
    expect((await p.locator(".menu .result.fix").first().textContent()).includes("Shout the heading"), "the fix is not named");
    expect((await p.locator(".menu .result").count()) > 3, "the usual menu entries are gone");
    await p.locator(".menu .result.fix").first().click();
    await until("the edit", async () => (await lines())[0] === "# NOTES", 5000);
    await K("Control+z");
    await until("undo to bring it back", async () => (await lines())[0] === "# Notes", 3000);
    await K("Control+.");
    await typing();
    await until("the fix under Ctrl+.", async () => (await p.locator(".result").allTextContents()).some((t) => t.includes("Shout the heading")), 5000);
    await K("Enter");
    await until("the edit again", async () => (await lines())[0] === "# NOTES", 5000);
  });

  await check("the light bulb: whatever an extension offers for the line, fixes and refactorings alike", async () => {
    await K("Control+z");
    await until("the heading as it was", async () => (await lines())[0] === "# Notes", 3000);
    await K("Control+Home");
    await until("the bulb on the line that has something on offer", async () => (await p.locator(".group.focused .bulb").count()) === 1, 8000);
    const where = await p.evaluate(() => { const b = document.querySelector(".group.focused .bulb").getBoundingClientRect(), l = [...document.querySelectorAll(".group.focused .row")].find((r) => r.querySelector(".ln")?.textContent === "1").getBoundingClientRect(); return Math.abs(b.top - l.top); });
    expect(where < 3, "the bulb is not on the cursor's line: " + where);
    await shot("bulb");
    await K("Control+End");
    await until("no bulb where nothing is offered", async () => (await p.locator(".group.focused .bulb").count()) === 0, 6000);
    await K("Control+Home");
    await p.waitForSelector(".group.focused .bulb");
    await p.locator(".group.focused .bulb").click();
    await typing();
    await until("both, the fix first, each named for what it is", async () => (await p.locator(".result").allTextContents()).join(" | ") === "Shout the headingquick fix | Whisper the headingrefactor", 6000);
    await K("ArrowDown"); await K("Enter");
    // The refactoring had no edit until it was chosen: it is asked for then.
    await until("the refactoring's edit", async () => (await lines())[0] === "# notes", 6000);
    await K("Control+z");
    await until("undo", async () => (await lines())[0] === "# Notes", 3000);
  });

  await check("completion from an extension: its own range and filter, a trigger character, and edits that come with an item", async () => {
    const options = () => p.locator(".suggest .option b").allTextContents();
    const original = (await lines()).join("\n");
    const back = async () => { await K("Escape"); for (let i = 0; i < 60 && (await lines()).join("\n") !== original; i++) await K("Control+z"); expect((await lines()).join("\n") === original, "could not get back to the file as it was"); };
    await K("Control+End");
    // "@" is not part of a word: the list opens because the extension named it as a trigger.
    await p.keyboard.type("see @");
    await until("the people", async () => (await options()).join() === "@ada,@alan,@grace", 8000);
    expect((await p.locator(".suggest-doc").textContent()).includes("trigger @") || (await p.locator(".suggest .option.on b").textContent()) === "@ada", "the trigger character was not passed on");
    // The first one's documentation is Markdown, drawn; what could run or load is not there.
    await until("its documentation", async () => ((await p.locator(".suggest-doc").textContent().catch(() => "")) ?? "").includes("wrote the first program"), 4000);
    const doc = await p.locator(".suggest-doc").evaluate((e) => ({ strong: e.querySelector("strong")?.textContent, code: e.querySelectorAll("pre.md-code").length, head: e.querySelectorAll("h1,h2,h3").length, link: e.querySelector("a[data-href]")?.dataset.href, script: e.querySelectorAll("script").length, raw: e.textContent.includes("**") || e.textContent.includes("```") }));
    expect(doc.strong === "Ada" && doc.code === 1 && doc.head === 1 && doc.link === "https://example.com/ada" && doc.script === 0 && !doc.raw && !(await p.evaluate(() => window.__doc)), "documentation: " + JSON.stringify(doc));
    await shot("completion-doc");
    // Typing narrows by the item's own filter text, without asking again.
    await p.keyboard.type("gr");
    await until("one left", async () => (await options()).join() === "@grace", 4000);
    // Its documentation, and the line it adds, come only when the server is asked about it again.
    await until("what was left for later", async () => ((await p.locator(".suggest-doc").textContent().catch(() => "")) ?? "").includes("found the first bug"), 5000);
    await K("Enter");
    await until("the mention, in place of what was typed from the @ on", async () => (await lines()).some((l) => l.endsWith("see @grace-hopper")), 4000);
    await until("the line that comes with it, at the top", async () => (await lines())[0] === "<!-- mentions grace -->", 6000);
    await p.keyboard.type("!");
    expect((await lines()).some((l) => l.endsWith("see @grace-hopper!")), "the cursor did not stay after the mention: " + JSON.stringify(await lines()));
    await back();
    // An item that brings its edit with it: made at once.
    await K("Control+End");
    await p.keyboard.type("@ad");
    await until("ada", async () => (await options())[0] === "@ada", 8000);
    await K("Tab");
    await until("both changes", async () => { const all = await lines(); return all[0] === "<!-- mentions ada -->" && all.some((l) => l.endsWith("@ada-lovelace")); }, 5000);
    await back();
    // Nothing fits: the list closes rather than showing what does not match.
    await K("Control+End");
    await p.keyboard.type("@zz");
    await p.waitForTimeout(600);
    expect((await p.locator(".suggest").count()) === 0, "a list of things that do not fit: " + (await options()).join());
    await back();
    await K("Control+s");
  });

  await check("commands from extensions are in the command palette", async () => {
    await K("Control+Shift+p");
    await typing();
    await p.keyboard.type("stamp the");
    await until("the command, named by its extension", async () => (await p.locator(".result.on").textContent().catch(() => "")).includes("Demo: Stamp the Notes"), 3000);
    expect((await p.locator(".result.on small").textContent()) === "Demo Fixer", "the extension is not named");
    await K("Enter");
    await until("the command's edit", async () => (await lines())[0] === "<!-- stamped -->", 5000);
    for (let i = 0; i < 4; i++) await K("Control+z");
    await K("Control+s");
  });

  await check("the explorer colours files by how they stand with git", async () => {
    fs.appendFileSync(path.join(project, "src/notes.md"), "changed on disk\n");
    fs.writeFileSync(path.join(project, "src/fresh.md"), "# Fresh\n");
    await K("Control+Shift+e");
    await p.waitForTimeout(1600);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    const node = (name) => p.locator(".tree .node", { has: p.locator(".name", { hasText: new RegExp("^" + name.replace(".", "\\.") + "$") }) });
    await unfold("src");
    await until("the modified file", async () => ((await node("notes.md").getAttribute("class").catch(() => "")) ?? "").includes("git-M"), 6000);
    await until("the new file", async () => ((await node("fresh.md").getAttribute("class").catch(() => "")) ?? "").includes("git-U"), 6000);
    expect((await node("src").getAttribute("class")).includes("git-in"), "the folder does not show that it holds changes");
    expect((await node("notes.md").locator(".git-mark").textContent()) === "M" && (await node("fresh.md").locator(".git-mark").textContent()) === "U", "the letters are missing");
    expect(!(await node("bea.toml").getAttribute("class")).includes("git"), "an unchanged file is marked");
    const colours = await p.evaluate(() => ["git-M", "git-U"].map((c) => getComputedStyle(document.querySelector(".tree .node." + c)).color));
    expect(colours[0] === "rgb(226, 192, 141)" && colours[1] === "rgb(115, 201, 145)", "colours: " + colours.join());
    await shot("explorer-git");
  });

  await check("comparisons are syntax coloured, and open the file on disk", async () => {
    fs.appendFileSync(path.join(project, "src/shop.bea"), "\npub def triple(n: Int) -> Int {\n  n * 3\n}\n");
    await K("Control+Shift+g");
    await p.locator('.side .mini[title="Refresh"]').click();
    await until("the change", async () => (await p.locator(".side .change .change-name").allTextContents()).some((t) => t.includes("shop.bea")), 5000);
    await p.locator(".side .change", { hasText: "src/shop.bea" }).locator(".change-name").click();
    await until("coloured rows, unchanged and added", async () => (await p.locator(".diff-rows .usame .right span[style]").count()) > 3 && (await p.locator(".diff-rows .unew .right span[style]").count()) > 3, 8000);
    const colours = await p.evaluate(() => {
      const colour = (word) => [...document.querySelectorAll(".diff-rows .right span[style]")].find((e) => e.textContent === word)?.style.color;
      return [colour("pub"), colour("triple"), colour("Int")];
    });
    expect(colours.every(Boolean) && new Set(colours).size === 3, "keyword, function and type colours: " + colours.join(" | "));
    await shot("diff-coloured");
    // The file was changed by another program while it was open; opening it reads it again.
    await p.locator(".diff-head .open-file", { hasText: "Open file" }).click();
    await until("the file itself, as it is on disk now", async () => (await p.locator(".group.focused .tab.on").textContent()).includes("shop.bea") && (await lines()).includes("pub def triple(n: Int) -> Int {"), 5000);
    execFileSync("git", ["checkout", "--", "src/shop.bea", "src/notes.md"], { cwd: project });
    fs.rmSync(path.join(project, "src/fresh.md"));
    await p.waitForTimeout(1600);
    await p.waitForTimeout(1600);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until("the reverted file to be read again", async () => !(await lines()).includes("pub def triple(n: Int) -> Int {"), 5000);
    await K("Control+w");
  });

  await check("Markdown preview: drawn beside the file, and it follows the typing", async () => {
    await open("README.md");
    await p.locator('.group.focused .tab-actions .mini[title="Open Preview to the Side"]').click();
    await p.waitForSelector(".markdown-page .markdown h1");
    expect((await p.locator(".markdown-page .markdown h1").textContent()) === "Shop", "the heading is not drawn");
    expect((await p.locator(".group").count()) >= 2 && (await p.locator(".group.focused .tab").count()) === 1, "the preview should be alone in a group of its own");
    await shot("markdown-preview");
    await p.locator(".group:not(.focused) .content").first().click({ position: { x: 300, y: 300 } });
    await K("Control+End");
    await p.keyboard.type("Now with **strong words** and a [link](https://example.com/x).");
    await until("the preview to follow", async () => ((await p.locator(".markdown-page strong").textContent().catch(() => "")) ?? "") === "strong words", 4000);
    expect((await p.locator(".markdown-page a").getAttribute("data-href")) === "https://example.com/x", "the link is not kept as data");
    // A link asks before it leaves the editor, and the window itself goes nowhere.
    const question = app.evaluate(({ dialog }) => new Promise((done) => { dialog.showMessageBox = async (_, options) => { done(options.detail); return { response: 1 }; }; setTimeout(() => done("no question"), 4000); }));
    await p.waitForTimeout(100);
    await p.locator(".markdown-page a").click();
    expect((await question) === "https://example.com/x", "the link did not ask first: " + (await question));
    expect(p.url().startsWith("runes://app/"), "the window navigated");
    await p.locator(".group .content").first().click({ position: { x: 300, y: 300 } });
    for (let i = 0; i < 80 && (await lines()).some((l) => l.includes("strong words")); i++) await K("Control+z");
    await K("Control+s");
    await K("Control+Shift+v");
    await until("the preview in this group", async () => (await p.locator(".group.focused .markdown-page").count()) === 1, 3000);
    await K("Control+w");
    await p.waitForTimeout(500);
    for (let i = 0; i < 3 && (await p.locator(".tab", { hasText: "Preview" }).count()); i++) await p.locator(".tab", { hasText: "Preview" }).first().locator(".tab-close").click({ timeout: 2000 }).catch(() => {});
    await until("one group again", async () => (await p.locator(".group").count()) === 1, 3000);
  });

  await check("terminals: a scrolling list, and any of them can be tiled among the editors", async () => {
    await K("Control+`");
    await p.waitForSelector(".term-list .term-tab");
    for (let i = 0; i < 23; i++) await p.locator('.panel-head .mini[title="New Terminal"]').click();
    await until("twenty-four shells", async () => (await p.locator(".term-list .term-tab").count()) === 24, 20000);
    const list = await p.evaluate(() => {
      const l = document.querySelector(".term-list"), tabs = [...l.querySelectorAll(".term-tab")].map((t) => t.getBoundingClientRect());
      return { scrolls: l.scrollHeight > l.clientHeight, column: tabs.every((r, i) => i === 0 || (r.top > tabs[i - 1].top && r.left === tabs[0].left)), head: document.querySelector(".panel-head").scrollWidth <= document.querySelector(".panel-head").clientWidth };
    });
    expect(list.scrolls && list.column && list.head, "the list is not one scrolling column: " + JSON.stringify(list));
    await shot("terminals");
    // The first shell, far up the list, is still reachable.
    const first = p.locator(".term-list .term-tab").first();
    await first.scrollIntoViewIfNeeded();
    await first.locator(".term-name").click();
    await p.waitForTimeout(500);
    await p.keyboard.type("export MARK=kept-$((6*7))"); await K("Enter");
    // Into the editor area it goes, still the same running shell.
    await first.hover();
    await first.locator('.mini[title*="into the editor area"]').click();
    await p.waitForSelector(".group .term-tile runes-terminal .xterm");
    expect((await p.locator(".term-list .term-tab").count()) === 23, "the moved terminal is still in the panel's list");
    await p.locator(".term-tile").click();
    await p.keyboard.type("echo $MARK"); await K("Enter");
    await until("the same shell, with its variable", async () => ((await p.locator(".term-tile .xterm-rows").textContent()) ?? "").includes("kept-42"), 8000);
    // As a tab it tiles like any editor: drag it to the right edge.
    const groups = await p.locator(".group").count();
    const tab = p.locator(".group.focused .tab.on");
    expect((await tab.textContent()).includes("echo $MARK"), "the tab is not named after the last command: " + (await tab.textContent()));
    const from = await tab.boundingBox(), area = await p.locator(".group.focused").boundingBox();
    await p.mouse.move(from.x + 20, from.y + 10); await p.mouse.down();
    await p.mouse.move(area.x + area.width - 30, area.y + area.height / 2, { steps: 12 });
    await p.waitForTimeout(150); await p.mouse.up();
    await until("a group of its own", async () => (await p.locator(".group").count()) === groups + 1, 5000);
    await until("the terminal in the new group", async () => ((await p.locator(".group.focused .term-tile .xterm-rows").textContent().catch(() => "")) ?? "").includes("kept-42"), 5000);
    await shot("terminal-tiled");
    // A shell among the editors is renamed where it is.
    await p.locator(".group.focused .tab.on .tab-name").dblclick();
    await p.waitForSelector(".term-tile #runes-rename");
    await K("Control+a"); await p.keyboard.type("tiled shell"); await K("Enter");
    await until("the tab to take the name", async () => (await p.locator(".group.focused .tab.on").textContent()).includes("tiled shell"), 3000);
    await p.locator(".group.focused .term-tile").hover();
    await p.locator('.group.focused .term-tools .mini[title="Rename this terminal"]').click();
    await p.waitForSelector(".term-tile #runes-rename");
    await K("Control+a"); await K("Backspace"); await K("Enter");
    await until("the name to follow the last command again", async () => (await p.locator(".group.focused .tab.on").textContent()).includes("echo $MARK"), 3000);
    // And back to the panel.
    await p.locator(".group.focused .term-tile").hover();
    await p.locator('.group.focused .term-tools .mini[title^="Move this terminal back"]').click();
    await until("the panel's list to have it again", async () => (await p.locator(".term-list .term-tab").count()) === 24, 5000);
    expect((await p.locator(".group .term-tile").count()) === 0, "the tile is still there");
    // Names: the last command by default, a name of your own when you give one, and a filter over both.
    const mine = p.locator(".term-list .term-tab", { hasText: "echo $MARK" });
    expect((await mine.count()) === 1, "the shell is not named after its last command: " + (await p.locator(".term-list .term-tab").first().textContent()));
    await mine.locator(".term-name").dblclick();
    await p.waitForSelector("#runes-rename");
    await K("Control+a"); await p.keyboard.type("build server"); await K("Enter");
    await until("the new name", async () => (await p.locator(".term-list .term-tab", { hasText: "build server" }).count()) === 1, 3000);
    await p.keyboard.type("echo again"); await K("Enter");
    await p.waitForTimeout(400);
    expect((await p.locator(".term-list .term-tab", { hasText: "build server" }).count()) === 1, "a name given by hand was replaced by a command");
    await p.locator("#runes-term-filter").fill("BUILD");
    await until("only the named shell", async () => (await p.locator(".term-list .term-tab").count()) === 1, 3000);
    await shot("terminal-names");
    await p.locator("#runes-term-filter").fill("no such shell");
    await until("nothing", async () => (await p.locator(".term-list .term-tab").count()) === 0 && (await p.locator(".term-list .hint").count()) === 1, 3000);
    await p.locator("#runes-term-filter").fill("");
    await commands();
    await p.keyboard.type("Go to Terminal"); await K("Enter");
    await until("the list of terminals", async () => (await p.locator("#runes-palette").getAttribute("placeholder")) === "Go to a terminal", 3000);
    await p.keyboard.type("build");
    await until("the named shell in the palette", async () => ((await p.locator(".result.on").textContent().catch(() => "")) ?? "").startsWith("build server"), 3000);
    await K("Enter");
    await until("that shell to be the one shown", async () => ((await p.locator(".term-list .term-tab.on").textContent().catch(() => "")) ?? "").includes("build server"), 3000);
    // A shell that ends takes its terminal with it.
    await p.locator(".term-list .term-tab.on .term-name").click();
    await p.waitForTimeout(300);
    await p.keyboard.type("exit"); await K("Enter");
    await until("the ended shell to be gone", async () => (await p.locator(".term-list .term-tab").count()) === 23 && (await p.locator(".term-list .term-tab", { hasText: "build server" }).count()) === 0, 6000);
    expect(!((await p.locator(".panel-body").textContent()) ?? "").includes("the shell has ended"), "a dead shell is still shown");
    for (let i = 0; i < 23; i++) { const t = p.locator(".term-list .term-tab").first(); await t.hover(); await t.locator('.mini[title^="Kill"]').click(); }
    await until("every shell to be gone", async () => (await p.locator(".term-list .term-tab").count()) === 0, 8000);
  });

  await check("the explorer makes, renames and deletes files and folders", async () => {
    await K("Control+Shift+e");
    const node = (name) => p.locator(".tree .node", { has: p.locator(".name", { hasText: new RegExp("^" + name.replace(/\./g, "\\.") + "$") }) });
    const names = () => p.locator(".tree .node .name").allTextContents();
    const at = (name) => path.join(project, name);
    // Deleting asks; here the trash may not exist (a bare test machine), and then it asks once more.
    const agree = async () => {
      await p.locator(".prompt .button", { hasText: /Move to trash|Delete/ }).click();
      await p.waitForTimeout(500);
      if (await p.locator(".prompt").count()) await p.locator(".prompt .button", { hasText: "Delete" }).click();
    };
    await unfold("src"); await node("src").click();
    await until("the folder shut", async () => (await node("shop.bea").count()) === 0, 4000);
    await p.locator(".root-name").click();

    // A new file, from the buttons over the tree: named in place, made empty, opened.
    await p.locator('.root-tools .mini[title="New file"]').click();
    await p.waitForSelector("#runes-naming");
    await shot("explorer-naming");
    await p.keyboard.type("made.txt"); await K("Enter");
    await until("the file on disk, listed and open", async () => fs.existsSync(at("made.txt")) && (await names()).includes("made.txt") && (await p.locator(".group.focused .tab.on").textContent()).includes("made.txt"), 5000);
    expect(fs.readFileSync(at("made.txt"), "utf8") === "", "a new file should be empty");
    // Escape makes nothing; a name that would climb out of the folder is refused; a taken name is not overwritten.
    await p.locator('.root-tools .mini[title="New file"]').click();
    await p.locator("#runes-naming").fill("nope.txt"); await K("Escape");
    await p.locator('.root-tools .mini[title="New file"]').click();
    await p.locator("#runes-naming").fill("../escaped.txt"); await K("Enter");
    await until("the refusal", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("cannot be used"), 3000);
    await K("Escape");
    fs.writeFileSync(at("README.md"), fs.readFileSync(at("README.md"), "utf8"));
    const readme = fs.readFileSync(at("README.md"), "utf8");
    await p.locator('.root-tools .mini[title="New file"]').click();
    await p.locator("#runes-naming").fill("README.md"); await K("Enter");
    await until("being told it exists", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("already exists"), 3000);
    expect(!fs.existsSync(at("nope.txt")) && !fs.existsSync(path.join(work, "escaped.txt")) && fs.readFileSync(at("README.md"), "utf8") === readme, "something was made or overwritten that should not have been");

    // A right click on a folder: a new folder inside it, with folders in between made on the way.
    await node("src").click({ button: "right" });
    await p.waitForSelector(".node-menu");
    const items = await p.locator(".node-menu .result span:first-child").allTextContents();
    expect(items.join() === "New File…,New Folder…,New Drawing…,Rename…,Delete,Copy Path,Copy Relative Path,Show in the File Manager", "menu: " + items.join());
    await shot("explorer-menu");
    await p.locator(".node-menu .result", { hasText: "New Folder" }).click();
    await p.locator("#runes-naming").fill("deep/inner"); await K("Enter");
    await until("both folders, open in the tree", async () => fs.statSync(at("src/deep/inner"), { throwIfNoEntry: false })?.isDirectory() && (await names()).includes("deep") && (await names()).includes("inner"), 5000);

    // Renaming an open file with unsaved text: the tab, the text and the edits move with it.
    await node("made.txt").click();
    await until("the file to have the keyboard", async () => (await p.locator(".group.focused .tab.on").textContent()).includes("made.txt"), 3000);
    await p.locator(".group.focused .content").click({ position: { x: 200, y: 100 } });
    await p.keyboard.type("kept through the rename");
    await node("made.txt").click({ button: "right" });
    await p.locator(".node-menu .result", { hasText: "Rename" }).click();
    await p.waitForSelector("#runes-naming");
    await until("the name selected, but not its ending", async () => (await p.evaluate(() => { const e = document.getElementById("runes-naming"); return e.value.slice(e.selectionStart, e.selectionEnd); })) === "made", 2000);
    await p.keyboard.type("renamed"); await K("Enter");
    await until("the new name on disk and on the tab", async () => fs.existsSync(at("renamed.txt")) && !fs.existsSync(at("made.txt")) && (await p.locator(".group.focused .tab.on").textContent()).includes("renamed.txt"), 5000);
    expect((await lines())[0] === "kept through the rename", "the unsaved text was lost: " + (await lines()).join("|"));
    await p.locator(".group.focused .content").click({ position: { x: 200, y: 100 } });
    await K("Control+s");
    await until("the save to go to the new name", async () => fs.readFileSync(at("renamed.txt"), "utf8").includes("kept through the rename"), 4000);
    expect(!fs.existsSync(at("made.txt")), "saving brought the old name back");

    // Deleting asks first. No means no.
    await node("renamed.txt").click({ button: "right" });
    await p.locator(".node-menu .result", { hasText: "Delete" }).click();
    await until("the question", async () => /renamed\.txt/.test((await p.locator(".prompt b").textContent().catch(() => "")) ?? ""), 4000);
    await shot("explorer-delete");
    await p.locator(".prompt .button", { hasText: "Cancel" }).click();
    await p.waitForTimeout(300);
    expect(fs.existsSync(at("renamed.txt")), "declined, yet deleted");
    await node("renamed.txt").click({ button: "right" });
    await p.locator(".node-menu .result", { hasText: "Delete" }).click();
    await p.waitForSelector(".prompt");
    await agree();
    await until("the file gone, its tab closed", async () => !fs.existsSync(at("renamed.txt")) && !(await names()).includes("renamed.txt") && (await p.locator(".tab", { hasText: "renamed.txt" }).count()) === 0, 6000);
    await node("deep").click({ button: "right" });
    await p.locator(".node-menu .result", { hasText: "Delete" }).click();
    await p.waitForSelector(".prompt");
    await agree();
    await until("the folder gone with what was in it", async () => !fs.existsSync(at("src/deep")) && !(await names()).includes("deep") && !(await names()).includes("inner"), 6000);
    // The open folder itself can be added to, but not renamed or deleted from here.
    await p.locator(".tree.files").click({ button: "right", position: { x: 60, y: (await p.locator(".tree.files").boundingBox()).height - 12 } });
    await p.waitForSelector(".node-menu");
    const top = await p.locator(".node-menu .result span:first-child").allTextContents();
    const fits = await p.locator(".node-menu").evaluate((e) => e.getBoundingClientRect().bottom <= window.innerHeight);
    expect(fits, "a menu opened low in the tree runs off the window");
    expect(top.includes("New File…") && !top.includes("Delete") && !top.includes("Rename…"), "menu of the open folder: " + top.join());
    await K("Escape");
    // What the window asks the shell for is checked there too.
    const refused = await p.evaluate(async (outside) => {
      const out = [];
      for (const ask of [() => window.runesHost.fileCreate(outside, false), () => window.runesHost.fileRemove(outside), () => window.runesHost.fileRename(outside, outside + "2"), () => window.runesHost.fileRemove(outside.replace(/\/[^/]+$/, "") + "/shop")]) {
        try { await ask(); out.push("allowed"); } catch (e) { out.push(String(e.message)); }
      }
      return out;
    }, path.join(work, "outside.txt"));
    expect(refused.every((r) => r.includes("outside the open folder")), "the shell let the window out of the folder: " + refused.join(" | "));
    expect(!fs.existsSync(path.join(work, "outside.txt")) && fs.existsSync(project), "something outside the folder was touched");
  });

  await check("the explorer follows the disk: files made, changed and removed by other programs", async () => {
    await K("Control+Shift+e");
    const names = () => p.locator(".tree .node .name").allTextContents();
    const node = (name) => p.locator(".tree .node", { has: p.locator(".name", { hasText: new RegExp("^" + name.replace(/\./g, "\\.") + "$") }) });
    await unfold("src");
    await until("the folder open", async () => (await names()).includes("shop.bea"), 3000);
    // Nothing here touches the window: no click, no focus, no refresh.
    fs.writeFileSync(path.join(project, "appeared.txt"), "one\n");
    fs.mkdirSync(path.join(project, "src/arrived"));
    await until("a new file and a new folder, by themselves", async () => (await names()).includes("appeared.txt") && (await names()).includes("arrived"), 5000);
    await open("appeared.txt");
    await until("the file open", async () => (await lines())[0] === "one", 4000);
    fs.writeFileSync(path.join(project, "appeared.txt"), "two\n");
    await until("its new text, read again", async () => (await lines())[0] === "two", 5000);
    await until("quick open to know it", async () => { await K("Control+p"); await typing(); await p.keyboard.type("appeared"); await p.waitForTimeout(150); const found = await p.locator(".result").allTextContents(); await K("Escape"); return found.some((t) => t.includes("appeared.txt")); }, 5000);
    fs.rmSync(path.join(project, "appeared.txt"));
    fs.rmdirSync(path.join(project, "src/arrived"));
    await until("both gone, by themselves", async () => !(await names()).includes("appeared.txt") && !(await names()).includes("arrived"), 5000);
    await K("Control+w");
    // A folder that is open in the tree and is removed takes its place in the tree with it.
    fs.mkdirSync(path.join(project, "temp/inner"), { recursive: true });
    await until("the folder", async () => (await names()).includes("temp"), 5000);
    await node("temp").click();
    await until("what is in it", async () => (await names()).includes("inner"), 3000);
    fs.rmSync(path.join(project, "temp"), { recursive: true });
    await until("all of it gone", async () => !(await names()).includes("temp") && !(await names()).includes("inner"), 5000);
  });

  await check("source control: changes are discarded, deleted files come back, new ones go — after asking", async () => {
    execFileSync("git", ["checkout", "--", "."], { cwd: project });
    execFileSync("git", ["clean", "-fdq"], { cwd: project });
    const original = fs.readFileSync(path.join(project, "src/notes.md"), "utf8");
    fs.appendFileSync(path.join(project, "src/notes.md"), "a change to throw away\n");
    fs.rmSync(path.join(project, "src/many.txt"));
    fs.writeFileSync(path.join(project, "scratch.txt"), "never committed\n");
    await K("Control+Shift+g");
    const listed = async () => (await p.locator(".side .change:not(.session) .change-name").allTextContents()).map((t) => t.split(" ")[0]).sort().join();
    await until("the three changes, with nothing clicked", async () => (await listed()) === "many.txt,notes.md,scratch.txt", 6000);
    const row = (name) => p.locator(".side .change:not(.session)", { hasText: name });
    expect((await row("many.txt").locator(".discard").getAttribute("title")) === "Bring back src/many.txt" && (await row("scratch.txt").locator(".discard").getAttribute("title")).startsWith("Delete scratch.txt"), "the buttons do not say what they will do");
    await shot("discard");
    // No means no.
    await row("notes.md").locator(".discard").click();
    await until("the question", async () => ((await p.locator(".prompt b").textContent().catch(() => "")) ?? "") === "Discard the changes to src/notes.md?", 4000);
    await p.locator(".prompt .button", { hasText: "Cancel" }).click();
    await p.waitForTimeout(300);
    expect(fs.readFileSync(path.join(project, "src/notes.md"), "utf8").includes("throw away"), "declined, yet discarded");
    // One file: a deleted one comes back.
    await row("many.txt").locator(".discard").click();
    await p.locator(".prompt .button", { hasText: "Discard" }).click();
    await until("the deleted file back", async () => fs.existsSync(path.join(project, "src/many.txt")) && (await listed()) === "notes.md,scratch.txt", 6000);
    // The rest at once.
    await p.locator(".side .section .link", { hasText: "Discard all" }).click();
    await until("the question for both", async () => ((await p.locator(".prompt b").textContent().catch(() => "")) ?? "") === "Discard the changes to 2 files?", 4000);
    await p.locator(".prompt .button", { hasText: "Discard" }).click();
    await until("a clean tree", async () => (await listed()) === "" && fs.readFileSync(path.join(project, "src/notes.md"), "utf8") === original && !fs.existsSync(path.join(project, "scratch.txt")), 6000);
    await K("Control+Shift+e");
  });

  await check("a language's own icon, from its extension, is used where the icon theme has none", async () => {
    await K("Control+Shift+e");
    const node = (name) => p.locator(".tree .node", { has: p.locator(".name", { hasText: new RegExp("^" + name.replace(/\./g, "\\.") + "$") }) });
    await unfold("src");
    await until("the Bea file to carry a picture", async () => (await node("shop.bea").locator("img.file-icon").count()) === 1, 4000);
    const drawn = await node("shop.bea").locator("img.file-icon").evaluate((i) => new Promise((done) => { const say = () => done([i.src.slice(0, 5), i.naturalWidth > 0]); if (i.complete) say(); else { i.onload = say; i.onerror = say; } }));
    expect(drawn[0] === "blob:" && drawn[1], "the icon did not draw: " + drawn.join());
    // The theme's own icons are untouched: a file it knows keeps its glyph.
    let markdown = [];
    await until("a Markdown file to keep the theme's own icon", async () => { markdown = await node("notes.md").locator(".file-icon").evaluateAll((all) => all.map((e) => e.tagName + ":" + (e.textContent || e.getAttribute("src") || "").slice(0, 12))); return markdown.length === 1 && markdown[0].startsWith("SPAN:"); }, 5000).catch(async () => { throw new Error("a Markdown file lost the theme's icon: " + JSON.stringify(markdown) + " among " + JSON.stringify(await p.locator(".tree .node").evaluateAll((all) => all.map((n) => n.textContent + "/" + n.innerHTML.slice(0, 160)).slice(0, 12)))); });
    expect((await p.locator(".tab", { hasText: "shop.bea" }).locator("img.file-icon").count()) <= 1, "tabs");
    await shot("language-icon");
  });

  await check("blame: who last changed the line under the cursor, in the status bar", async () => {
    execFileSync("git", ["checkout", "--", "."], { cwd: project });
    await open("notes.md");
    await p.locator(".group.focused .content").click({ position: { x: 300, y: 12 } });
    await until("the line's author and age", async () => /^Ada, .+ ago/.test((await p.locator(".status .seg.blame").textContent().catch(() => "")) ?? ""), 6000);
    const said = await p.locator(".status .seg.blame").getAttribute("title");
    expect(/\n[^\n]*Ada · .+ ago · [0-9a-f]{7}\n/.test(said), "the hover does not tell the commit: " + said);
    await shot("blame");
    // A line just typed is nobody's yet; the committed lines around it still are somebody's.
    await K("Control+End"); await K("Enter"); await p.keyboard.type("a new thought");
    await until("a new line to be nobody's", async () => ((await p.locator(".status .seg.blame").textContent().catch(() => "")) ?? "") === "Not committed yet", 6000);
    await K("Control+Home");
    await until("the first line to be Ada's still", async () => /^Ada, /.test((await p.locator(".status .seg.blame").textContent().catch(() => "")) ?? ""), 6000);
    // A click opens what that commit changed.
    const about = (await p.locator(".status .seg.blame .blame-what").textContent()).trim();
    await p.locator(".status .seg.blame").click();
    await until("the commit, as a session", async () => ((await p.locator(".diff-commit b").textContent().catch(() => "")) ?? "") === about, 6000);
    await K("Control+w");
    // It can be turned off.
    await open("notes.md");
    await K("Control+z"); await K("Control+z"); await K("Control+z");
    await commands(); await p.keyboard.type("Preferences: Open Settings"); await K("Enter");
    await p.locator('.settings-page [aria-label="git.blame.statusBarItem.enabled"]').click();
    await p.locator(".tab", { hasText: "notes.md" }).first().click();
    await p.locator(".group.focused .content").click({ position: { x: 300, y: 12 } });
    await p.waitForTimeout(700);
    expect((await p.locator(".status .seg.blame").count()) === 0, "blame is shown although it is turned off");
    await p.locator(".tab", { hasText: "Settings" }).first().click();
    await p.locator('.settings-page [aria-label="git.blame.statusBarItem.enabled"]').click();
    await p.locator(".tab", { hasText: "Settings" }).first().locator(".close, button").first().click().catch(() => {});
    await p.locator(".tab", { hasText: "notes.md" }).first().click();
    await p.locator(".group.focused .content").click({ position: { x: 300, y: 12 } });
    await until("blame to come back", async () => (await p.locator(".status .seg.blame").count()) === 1, 8000);
    execFileSync("git", ["checkout", "--", "."], { cwd: project });
  });

  await check("git settings: name, email and signing are read from git and written through it", async () => {
    await commands(); await p.keyboard.type("Preferences: Open Settings"); await K("Enter");
    const field = (key) => p.locator(`.settings-page [aria-label="${key}"]`);
    await until("git's name for this repository", async () => (await field("user.name").inputValue().catch(() => "")) === "Ada", 5000);
    const row = (key) => p.locator(".settings-page .setting", { has: p.locator(`[aria-label="${key}"]`) });
    expect((await row("user.name").locator("small").textContent()).includes("Set for this repository"), "it does not say where the name comes from");
    const read = (...args) => { try { return execFileSync("git", ["config", ...args], { cwd: project, env: { ...process.env, ...gitEnv } }).toString().trim(); } catch { return ""; } };
    // For all repositories: written to the user's file, not the repository's.
    await field("user.email").fill("ada@all.example"); await field("user.email").blur();
    await until("the email for all repositories", async () => read("--global", "user.email") === "ada@all.example", 4000);
    expect(read("--local", "user.email") === "ada@example.com", "the repository's own email was changed");
    // For this repository only.
    await p.locator('.settings-page [aria-label="Git settings scope"]').selectOption("local");
    await field("user.name").fill("Ada at work"); await field("user.name").blur();
    await until("the name for this repository", async () => read("--local", "user.name") === "Ada at work", 4000);
    await field("gpg.format").selectOption("ssh");
    await until("the format", async () => read("--local", "gpg.format") === "ssh", 4000);
    await until("the hint to speak of a public key", async () => (await field("user.signingkey").getAttribute("placeholder")) === "~/.ssh/id_ed25519.pub", 3000);
    await field("gpg.format").selectOption("openpgp");
    await shot("git-settings");
    // Emptying a field takes the setting away.
    await field("user.name").fill(""); await field("user.name").blur();
    await until("the setting to be gone", async () => read("--local", "user.name") === "", 4000);
    await until("the field to show that", async () => (await field("user.name").inputValue()) === "", 4000);
    await p.waitForTimeout(300);
    await field("user.name").fill("Ada"); await field("user.name").blur();
    await until("the name back", async () => read("--local", "user.name") === "Ada", 4000);
    // The window cannot set what names a program.
    const refused = await p.evaluate(async () => { try { await window.runesHost.gitConfigSet("gpg.program", "/tmp/evil", "local"); return "allowed"; } catch (e) { return e.message; } });
    expect(/Bad request/.test(refused) && read("--local", "gpg.program") === "", "the page could name a program for git to run: " + refused);
    await K("Control+w");
  });

  if (signing) await check("a signed commit: the key's passphrase is asked for in the window, and the commit is signed", async () => {
    const config = (...args) => execFileSync("git", ["config", ...args], { cwd: project, env: { ...process.env, ...gitEnv } });
    config("commit.gpgsign", "true"); config("user.signingkey", "ada@example.com"); config("gpg.format", "openpgp");
    try {
      fs.writeFileSync(path.join(project, "SIGNED.md"), "# Signed\n");
      await K("Control+Shift+g");
      await until("the new file", async () => (await p.locator(".change").allTextContents()).some((t) => t.includes("SIGNED.md")), 6000);
      await p.locator('.mini[title="Stage SIGNED.md"]').click();
      await until("it to be staged", async () => (await p.locator('.mini[title="Unstage SIGNED.md"]').count()) === 1, 5000);
      const head = () => execFileSync("git", ["log", "-1", "--format=%G?|%s"], { cwd: project, env: { ...process.env, ...gitEnv } }).toString().trim();
      // Giving up makes no commit, and says why.
      await p.locator("#runes-commit").fill("A signed commit");
      await p.locator(".commit-form .button").click();
      await until("the passphrase to be asked for", async () => ((await p.locator(".prompt b").textContent().catch(() => "")) ?? "").startsWith("Passphrase for the signing key"), 10000);
      expect((await p.locator("#runes-prompt").getAttribute("type")) === "password", "the passphrase is not hidden");
      await shot("signing");
      await p.locator(".prompt .button", { hasText: "Cancel" }).click();
      await until("being told it was not signed", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("could not be signed"), 8000);
      expect(!head().includes("A signed commit"), "a commit was made without its signature");
      // The passphrase signs it.
      await p.locator(".commit-form .button").click();
      await until("the question again", async () => (await p.locator("#runes-prompt").count()) === 1, 10000);
      await p.locator("#runes-prompt").fill("open sesame"); await K("Enter");
      await until("a commit with a good signature", async () => head() === "G|A signed commit", 12000);
      const page = await p.evaluate(() => document.documentElement.innerHTML);
      expect(!page.includes("open sesame"), "the passphrase is still in the page");
    } finally {
      config("--unset", "commit.gpgsign"); config("--unset", "user.signingkey");
      try { execFileSync("gpgconf", ["--kill", "gpg-agent"], { stdio: "pipe", env: { ...process.env, GNUPGHOME: gnupg } }); } catch {}
    }
    await K("Control+Shift+e");
  });

  await check("there is no AI in 1.0: no chat, no key, nothing sent anywhere", async () => {
    expect((await p.locator(".activity button").evaluateAll((all) => all.map((b) => b.title))).every((t) => !/chat|ai\b/i.test(t)), "a chat button is still in the activity bar");
    await commands(); await p.keyboard.type("chat"); await p.waitForTimeout(200);
    const found = await p.locator(".result").allTextContents();
    await K("Escape");
    expect(found.every((t) => !/chat|API key/i.test(t)), "commands: " + found.join(" | "));
    expect(await p.evaluate(() => !("ai" in window.runesHost)), "the shell still offers the page an AI bridge");
  });

  await check("installing a VSIX with code asks first; declining installs nothing", async () => {
    const before = fs.readdirSync(path.join(profile, "extensions")).length;
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await K("Control+Shift+x");
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".side header .button", { hasText: "Install" }).click()]);
    await chooser.setFiles(path.join(root, "extensions/prebuilt/gleam.gleam.vsix"));
    await until("the refusal to be reported", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("not installed"), 8000);
    expect(fs.readdirSync(path.join(profile, "extensions")).length === before, "a declined extension was written to disk");
  });

  // --- Rune Canvas: drawings kept as files of the project ---
  const rux = path.join(project, "how.rux");
  const drawing = () => JSON.parse(fs.readFileSync(rux, "utf8"));
  const board = async () => { const b = await p.locator(".group.focused runes-canvas .rc-board").boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const drag = async (x1, y1, x2, y2, keys = []) => {
    const c = await board();
    await p.mouse.move(c.x + x1, c.y + y1);
    await p.mouse.down();
    for (const k of keys) await p.keyboard.down(k);
    await p.mouse.move(c.x + (x1 + x2) / 2, c.y + (y1 + y2) / 2, { steps: 4 });
    await p.mouse.move(c.x + x2, c.y + y2, { steps: 4 });
    await p.mouse.up();
    for (const k of keys) await p.keyboard.up(k);
    await settle();
  };
  const drawn = async () => { await settle(); return p.locator(".group.focused runes-canvas .rc-el").count(); };
  const store = async () => { await K("Control+s"); await until("the drawing saved", async () => !(await p.locator(".group.focused .tab.on").evaluate((t) => t.classList.contains("dirty")).catch(() => true)), 4000); };

  await check("canvas: a new drawing is a .rux file that opens as an empty board", async () => {
    // The drawing goes where the explorer points: here, the open folder itself.
    if (!(await p.locator(".root-name").count())) await K("Control+Shift+e");
    await p.locator(".root-name").click();
    await commands();
    await p.keyboard.type("New Drawing");
    await p.waitForTimeout(150);
    await K("Enter");
    await p.waitForFunction(() => document.activeElement?.id === "runes-naming", null, { timeout: 5000 });
    expect((await p.locator("#runes-naming").inputValue()) === "drawing.rux", "the name offered: " + (await p.locator("#runes-naming").inputValue()));
    // Only the stem is selected, so typing keeps the ending.
    await p.keyboard.type("how");
    expect((await p.locator("#runes-naming").inputValue()) === "how.rux", "typing replaced the ending too");
    await K("Enter");
    await p.waitForSelector(".group.focused runes-canvas.empty", { timeout: 6000 });
    expect(fs.existsSync(rux), "no file was made");
    expect((await status()).includes("Rune Canvas"), "the status bar does not say Rune Canvas: " + (await status()));
    expect((await p.locator(".group.focused .row").count()) === 0, "the text of the file is on show as well");
    await until("the board to have the keyboard", async () => p.evaluate(() => document.activeElement?.tagName === "RUNES-CANVAS"), 3000);
    await shot("canvas-empty");
  });

  await check("canvas: shapes, a label, and an arrow tied to both ends are drawn and saved as readable JSON", async () => {
    await K("r");
    await drag(-200, -80, -60, 0);
    await K("o");
    await drag(120, 20, 260, 110);
    expect((await drawn()) === 2, "two shapes expected, got " + (await drawn()));
    // Double click in the rectangle to write in it.
    const c = await board();
    await p.mouse.dblclick(c.x - 130, c.y - 40);
    await p.waitForFunction(() => document.activeElement?.classList.contains("rc-write"), null, { timeout: 3000 });
    await p.keyboard.type("Shop");
    await K("Escape");
    await K("a");
    await drag(-100, -30, 180, 60);
    expect((await drawn()) === 3, "an arrow expected, got " + (await drawn()));
    await store();
    const text = fs.readFileSync(rux, "utf8");
    const file = drawing();
    expect(file.rune === "canvas" && file.version === 1, "the file does not say what it is");
    expect(text.trim().split("\n").length === file.elements.length + 6, "one element to a line is expected:\n" + text);
    const [rect, oval, arrow] = file.elements;
    expect(rect.type === "rect" && rect.text === "Shop" && oval.type === "ellipse" && arrow.type === "arrow", "what was drawn: " + text);
    expect(arrow.from === rect.id && arrow.to === oval.id, "the arrow is not tied to both shapes: " + JSON.stringify(arrow));
    expect((await p.locator(".group.focused runes-canvas .rc-text").first().textContent()).includes("Shop"), "the label is not drawn");
    await shot("canvas");
  });

  await check("canvas: a tied arrow follows its shape; undo and redo", async () => {
    const before = drawing().elements[2];
    await K("v");
    // An empty shape is taken hold of by its outline, so that things inside it can be reached.
    await drag(190, 110, 190, 210);
    await store();
    const moved = drawing().elements;
    expect(moved[1].y > 100, "the ellipse did not move: " + JSON.stringify(moved[1]));
    expect(moved[2].to === moved[1].id && moved[2].y + moved[2].h > before.y + before.h + 50, "the arrow did not follow: " + JSON.stringify(moved[2]));
    await K("Control+z");
    await store();
    expect(JSON.stringify(drawing().elements[2]) === JSON.stringify(before), "undo did not put the arrow back");
    await K("Control+Shift+z");
    await store();
    expect(JSON.stringify(drawing().elements) === JSON.stringify(moved), "redo did not move it again");
    // Delete takes the selection away; the arrow lets go of what is gone.
    await K("Delete");
    expect((await drawn()) === 2, "delete did not remove the ellipse");
    await K("Control+z");
    expect((await drawn()) === 3, "undo did not bring it back");
  });

  await check("canvas: the editor's own keys still work over a board, and the board's keys stay in it", async () => {
    await K("Control+a");
    await until("the whole drawing selected", async () => (await settle(), await p.locator(".group.focused runes-canvas .rc-each").count()) === 3, 3000);
    await K("Escape");
    await commands();
    expect((await p.locator("#runes-palette").count()) === 1, "the palette did not open over a board");
    await K("Escape");
    await until("the board to have the keyboard back", async () => p.evaluate(() => document.activeElement?.tagName === "RUNES-CANVAS"), 3000);
  });

  await check("canvas: the file can be read as text, and drawn again", async () => {
    await p.locator(".group.focused runes-canvas .rc-top .rc-button[aria-label='Show the file as text']").click();
    await until("the text", async () => (await lines()).join("\n").includes('"rune": "canvas"'), 4000);
    expect((await p.locator(".canvas-raw").count()) === 1, "nothing offers the way back");
    await p.locator(".canvas-raw button").click();
    await p.waitForSelector(".group.focused runes-canvas");
    expect((await drawn()) === 3, "the drawing did not come back whole");
  });

  await check("canvas: a change on disk is drawn, and a linked element opens its file at the line", async () => {
    await store();
    const file = drawing();
    file.elements[0].link = "src/shop.bea:7";
    file.elements.push({ id: "extra", type: "diamond", x: file.elements[0].x, y: file.elements[0].y + 200, w: 120, h: 80, stroke: "violet", fill: "violet", text: "from disk" });
    fs.writeFileSync(rux, JSON.stringify(file));
    // Files are read again when the window is come back to.
    await p.waitForTimeout(1600);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until("the new element", async () => (await drawn()) === 4, 8000);
    expect((await p.locator(".group.focused runes-canvas .rc-link").count()) === 1, "the link is not marked");
    const c = await board();
    const spot = await p.locator(".group.focused runes-canvas .rc-el[data-type='rect']").boundingBox();
    await p.keyboard.down("Control");
    await p.mouse.click(spot.x + 6, spot.y + spot.height / 2);
    await p.keyboard.up("Control");
    await until("the linked file", async () => (await status()).includes("Ln 7"), 5000);
    expect((await p.locator(".group.focused .tab.on").textContent()).includes("shop.bea"), "the wrong file opened");
    await open("how.rux");
    await p.waitForSelector(".group.focused runes-canvas");
  });

  await check("canvas: pictures are saved as PNG and SVG, and only pictures", async () => {
    const png = path.join(work, "how.png"), svg = path.join(work, "how.svg");
    await app.evaluate(({ dialog }, to) => { dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: /png/i.test(JSON.stringify(o.filters ?? "")) ? to.png : to.svg }); }, { png, svg });
    const top = p.locator(".group.focused runes-canvas .rc-top");
    await top.locator(".rc-button[aria-label='Save the drawing as a picture']").click();
    await top.locator(".rc-menu button", { hasText: "PNG…" }).click();
    await until("the PNG", async () => fs.existsSync(png), 6000);
    expect(fs.readFileSync(png).subarray(1, 4).toString() === "PNG" && fs.statSync(png).size > 2000, "that is not a picture");
    await top.locator(".rc-button[aria-label='Save the drawing as a picture']").click();
    await top.locator(".rc-menu button", { hasText: "SVG…" }).click();
    await until("the SVG", async () => fs.existsSync(svg), 6000);
    const picture = fs.readFileSync(svg, "utf8");
    expect(picture.startsWith("<svg") && picture.includes("Shop") && !/<script|onload|javascript:|foreignObject/i.test(picture), "the SVG is not a plain picture");
    const refused = await p.evaluate(async () => {
      const tries = ["data:text/html;base64,PGgxPmhpPC9oMT4=", "data:image/png;base64,PGgxPmhpPC9oMT4=", "file:///etc/passwd", ""];
      const out = [];
      for (const t of tries) out.push(await window.runesHost.saveImage("x.png", t).then((v) => v || "refused", () => "refused"));
      return out;
    });
    expect(refused.every((r) => r === "refused"), "saveImage wrote something that is not a PNG: " + refused.join());
  });

  await check("security: a hostile drawing is shown as inert shapes, and a broken one says so", async () => {
    fs.writeFileSync(path.join(project, "evil.rux"), JSON.stringify({ rune: "canvas", version: 1, elements: [
      { id: "a", type: "rect", x: 0, y: 0, w: 200, h: 80, text: "<img src=x onerror=\"window.__canvas=1\"><script>window.__canvas=1</script>", stroke: "url(javascript:1)", fill: "\"><script>window.__canvas=1</script>", link: "javascript:window.__canvas=1" },
      { id: "b", type: "text", x: 0, y: 120, text: "up", link: "../../../etc/passwd" },
      { id: "c", type: "<script>", x: 0, y: 0, w: 5, h: 5 },
      { id: "d", type: "ellipse", x: "1e999", y: {}, w: -5, h: null, link: "https://evil.example/x", __proto__: { polluted: 1 } },
    ] }));
    await open("evil.rux");
    await p.waitForSelector(".group.focused runes-canvas .rc-el");
    const facts = await p.evaluate(() => {
      const c = document.querySelector(".group.focused runes-canvas");
      return { ran: window.__canvas === 1, tags: [...c.querySelectorAll(".rc-world *")].map((n) => n.tagName.toLowerCase()).filter((t) => !["g", "path", "text", "tspan", "rect", "title", "circle", "ellipse", "line", "polyline"].includes(t)),
        handlers: [...c.querySelectorAll(".rc-world *")].some((n) => [...n.attributes].some((a) => /^on/i.test(a.name) || /javascript:|url\(/i.test(a.value))), links: c.querySelectorAll(".rc-link").length, shown: c.querySelector(".rc-text")?.textContent ?? "", polluted: ({}).polluted };
    });
    expect(!facts.ran && facts.tags.length === 0 && !facts.handlers, "the file's text became markup: " + JSON.stringify(facts));
    expect(facts.shown.includes("<img"), "the text should be shown as it was written");
    expect(facts.links === 0, "a link that leaves the project was kept");
    expect(facts.polluted === undefined, "the file reached Object.prototype");
    fs.writeFileSync(path.join(project, "broken.rux"), "{ this is not a drawing");
    await open("broken.rux");
    await p.waitForSelector(".group.focused runes-canvas .rc-problem", { timeout: 5000 });
    expect((await p.locator(".group.focused runes-canvas .rc-tools").isHidden()), "tools are offered for a file that cannot be drawn");
    await shot("canvas-problem");
    await p.locator(".rc-problem button").click();
    await until("the text of the broken file", async () => (await lines()).join("").includes("this is not a drawing"), 4000);
    expect(fs.readFileSync(path.join(project, "broken.rux"), "utf8") === "{ this is not a drawing", "a file that could not be read was written over");
    for (const name of ["evil.rux", "broken.rux"]) fs.rmSync(path.join(project, name));
  });

  await check("security: the page has no Node, cannot navigate, open windows or eval", async () => {
    const facts = await p.evaluate(async () => {
      // Scripts the page did not ship with must not run: try an inline one.
      const inline = document.createElement("script");
      inline.textContent = "window.__injected = true";
      document.head.appendChild(inline);
      const evalBlocked = window.__injected !== true;
      const opened = window.open("https://example.com");
      let fetched = "blocked";
      try { await fetch("https://example.com"); fetched = "allowed"; } catch (_) {}
      return { node: typeof require !== "undefined" || typeof process !== "undefined", evalBlocked, opened: opened !== null, fetched };
    });
    expect(!facts.node, "Node is reachable from the page");
    expect(facts.evalBlocked, "an injected inline script ran");
    expect(!facts.opened, "window.open succeeded");
    expect(facts.fetched === "blocked", "the page can fetch from the network");
    await p.evaluate(() => { location.href = "https://example.com"; }).catch(() => {});
    await p.waitForTimeout(400);
    expect(p.url().startsWith("runes://app/"), "the window navigated away: " + p.url());
    const refused = await p.evaluate(() => window.runesHost.openExternal("https://evil.example/releases/x").then(() => "ok", () => "threw"));
    expect(refused === "ok", "openExternal should ignore, not throw");
  });

  await check("no errors were thrown in the page", async () => {
    expect(errors.length === 0, errors.slice(0, 5).join("\n"));
  });

  await app.close();
  registry.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("The test run itself failed:", e); process.exit(1); });
