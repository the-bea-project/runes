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
// With RUNES_DIAG, a line to the page's debugger is opened at the start: a page that has
// stopped answering cannot be reached to open one later.
let diagSession = null, diagApp = null;
const results = [];
// RUNES_ONLY=<pattern> runs just the checks whose names match, for working on one of them.
const only = process.env.RUNES_ONLY ? new RegExp(process.env.RUNES_ONLY, "i") : null;
// RUNES_UPTO=<pattern> runs everything up to and including the first check whose name matches.
const upto = process.env.RUNES_UPTO ? new RegExp(process.env.RUNES_UPTO, "i") : null;
let reached = false;
async function check(name, run) {
  if (only && !only.test(name)) return;
  if (reached) return;
  if (upto?.test(name)) reached = true;
  try { await run(); passed++; results.push("ok    " + name); console.log("ok    " + name); }
  catch (e) {
    // RUNES_DIAG=1: what the machine was busy with when a check failed, for telling a slow machine from a stuck app.
    let frozen = false;
    if (process.env.RUNES_DIAG && page) { try { const said = JSON.stringify(await Promise.race([page.evaluate(() => new Promise((done) => { const facts = { hidden: document.hidden, focus: document.hasFocus(), frames: 0 }; const tick = () => { facts.frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => done(facts), 500); })), new Promise((r) => setTimeout(() => r("no answer in 5s"), 5000))])); frozen = said.includes("no answer"); console.log("page: " + said); } catch (e) { console.log("page: " + e.message); } }
    // A page that does not answer is stopped where it stands, and says where that is. Only
    // then: asking a page that is idle to stop would stop it at the next thing it does.
    if (process.env.RUNES_DIAG && page && frozen) {
      try {
        // Where the page's process is, in its own code: the page may be busy somewhere its debugger cannot stop it.
        try {
          const run = (c) => require("node:child_process").execSync(c, { timeout: 90000 }).toString();
          const pid = run("pgrep -n -f 'type=renderer'").trim();
          console.log("the page's process, by thread:\n" + run(`top -H -b -n 1 -p ${pid} | sed -n 7,11p | cut -c1-120`));
          console.log(run(`gdb -p ${pid} -batch -ex 'bt 40' 2>&1 | grep '^#' | cut -c1-230 | head -44`));
        } catch (e) { console.log("no native stack: " + String(e.message).slice(0, 200)); }
        const cdp = diagSession ?? await Promise.race([page.context().newCDPSession(page), new Promise((_, no) => setTimeout(() => no(new Error("no session")), 4000))]);
        const paused = new Promise((done) => cdp.once("Debugger.paused", done));
        if (!diagSession) await cdp.send("Debugger.enable");
        cdp.send("Debugger.setSkipAllPauses", { skip: false }).catch(() => {});
        cdp.send("Debugger.pause").catch(() => {});
        const where = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 4000))]);
        if (where) console.log("stuck in: " + where.callFrames.slice(0, 14).map((f) => `${f.functionName || "(anonymous)"} ${String(f.url).split("/").pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber}`).join("\n          "));
        else console.log("stuck in: nothing of the page's own was running when it was stopped");
        // Nothing may be left waiting to stop the page later.
        cdp.send("Debugger.setSkipAllPauses", { skip: true }).catch(() => {});
        cdp.send("Debugger.resume").catch(() => {});
        if (!diagSession) cdp.detach().catch(() => {});
      } catch (e) { console.log("stuck in: " + e.message); }
    }
    if (process.env.RUNES_DIAG && diagApp) {
      const answer = await Promise.race([diagApp.evaluate(() => "the shell answers").catch((e) => "the shell: " + e.message), new Promise((r) => setTimeout(() => r("the shell does not answer in 4s"), 4000))]);
      console.log(answer);
      try { console.log(require("node:child_process").execSync("top -b -n 1 -w 200 | sed -n 7,14p | cut -c1-160").toString()); } catch {}
    }
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
  page = p; diagApp = app;
  if (process.env.RUNES_DIAG) { try { diagSession = await p.context().newCDPSession(p); await diagSession.send("Debugger.enable"); } catch {} }
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
  await check("Ctrl and a click goes to the definition, and into a library's own file", async () => {
    await line(1).click({ position: { x: 4, y: 8 } });
    expect((await status()).includes("Ln 1"), "the cursor did not leave the definition");
    await line(8).click({ position: { x: 150, y: 8 }, modifiers: ["Control"] });
    await until("the cursor at the definition", async () => (await status()).includes("Ln 3"), 20000);
    await p.keyboard.down("Control");
    const held = await p.evaluate(() => document.body.classList.contains("ctrl-held"));
    await p.keyboard.up("Control");
    expect(held && !(await p.evaluate(() => document.body.classList.contains("ctrl-held"))), "holding Ctrl does not show that a click will follow a name");
    // A name that comes from a library: its file is outside the folder, and opens all the same.
    const row = await p.evaluate(() => [...document.querySelectorAll(".group.focused .row .code")].findIndex((c) => /^import gleam\//.test(c.textContent)) + 1);
    if (row > 0) {
      const text = await line(row).textContent();
      const w = (await line(row).evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; })) / text.length;
      await line(row).click({ position: { x: w * (text.length - 1.5), y: 8 }, modifiers: ["Control"] });
      await until("a file of the library to open", async () => { const tab = await p.locator(".group.focused .tab.on").textContent(); return /\.gleam/.test(tab); }, 20000);
      expect((await lines()).length > 3, "the library's file is empty");
      await K("Control+w");
      await open("shop.bea");
    }
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
    expect(rows === 15, "eight slices and the seven items inside two of them should be listed, got " + rows);
    await p.locator(".settings-page .button", { hasText: "Add a slice" }).click();
    await until("a ninth slice", async () => (await p.locator(".pie-row").count()) === 16, 3000);
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
    await until("the Git items", async () => (await p.locator(".slice").allTextContents()).join() === "Changes,Graph,Compare", 3000);
    expect((await p.locator(".pie-hub").textContent()).includes("Git"), "the hub does not say which submenu this is");
    expect((await p.locator(".pie-trail polyline").count()) === 1, "no line shows the way back");
    await shot("pie-submenu");
    await p.locator(".pie-hub").click();
    await until("the top level again", async () => (await p.locator(".slice").count()) === 9, 3000);
    await p.locator(".slice", { hasText: "Git" }).click();
    await until("the Git items again", async () => (await p.locator(".slice").count()) === 3, 3000);
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
    await until("the word selected", async () => (await p.locator(".group.focused .sel").count()) === 1, 3000).catch(() => {});
    expect((await carets()) === 1 && (await p.locator(".group.focused .sel").count()) === 1, "the first Ctrl+D selects the word: " + (await carets()) + " cursors, " + (await p.locator(".group.focused .sel").count()) + " selections, " + JSON.stringify(await lines()) + " " + (await status()));
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

  await check("source control: a change is staged; committing is left to the terminal", async () => {
    fs.writeFileSync(path.join(project, "CHANGES.md"), "# Changes\n");
    await K("Control+Shift+g");
    await p.waitForSelector(".branch-line");
    expect((await p.locator(".branch-line b").textContent()) === "main", "wrong branch");
    await p.locator('.side .mini[title="Refresh"]').click();
    await until("the new file to be listed", async () => (await p.locator(".change").allTextContents()).some((t) => t.includes("CHANGES.md")), 5000);
    await p.locator('.mini[title="Stage CHANGES.md"]').click();
    await until("it to be staged", async () => (await p.locator('.mini[title="Unstage CHANGES.md"]').count()) === 1, 5000);
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: project }).toString().trim() === "CHANGES.md", "git does not have it staged");
    await shot("source-control");
    // Committing is the terminal's business: Runes shows and stages, and offers no way to commit or switch branch.
    expect((await p.locator("#runes-commit, .commit-form, .branch-switch").count()) === 0, "there is still a commit box or a branch switcher");
    await commands(); await p.keyboard.type("Git:"); await p.waitForTimeout(150);
    const offered = await p.locator(".result span:first-child").allTextContents();
    expect(!offered.some((o) => /^Git: (Commit|Switch Branch|Checkout|Push|Pull)/i.test(o)), "the palette offers: " + offered.join());
    await K("Escape");
    execFileSync("git", ["commit", "-q", "-m", "Add a change log"], { cwd: project });
    await p.locator('.side .mini[title="Refresh"]').click();
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
    await until("the modified file", async () => ((await node("notes.md").getAttribute("class").catch(() => "")) ?? "").includes("git-M"), 6000)
      .catch(async (e) => { throw new Error(e.message + ": " + (await node("notes.md").getAttribute("class").catch(() => "no such node")) + " | git says " + execFileSync("git", ["status", "--short"], { cwd: project }).toString().replace(/\n/g, "; ")); });
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
    // (A name is given a moment after Enter: the shell is asked first whether it was the one being typed to.)
    await until("the tab named after the last command", async () => ((await tab.textContent()) ?? "").includes("echo $MARK"), 5000).catch(async (e) => { throw new Error(e.message + ": " + (await tab.textContent())); });
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
    expect(items.join() === "New File…,New Folder…,New Drawing…,Cut,Copy,Paste,Rename…,Delete,Copy Path,Copy Relative Path,Show in the File Manager", "menu: " + items.join());
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

  // --- 1.2: indentation, wide characters, folding, wrapping, brackets ---
  const onDisk = (name) => fs.readFileSync(path.join(project, name), "utf8");
  const save = async () => { await K("Control+s"); await until("the file saved", async () => !(await p.locator(".group.focused .tab.on").evaluate((t) => t.classList.contains("dirty")).catch(() => true)), 4000); };
  const treeNode = (name) => p.locator(".tree.files .node", { has: p.locator(".name", { hasText: new RegExp("^" + name.replace(/\./g, "\\.") + "$") }) });
  const explorer = async () => { if (!(await p.locator(".tree.files").count())) await K("Control+Shift+e"); await p.waitForSelector(".tree.files"); };

  await check("indentation: Enter follows the language's rules, in the file's own steps", async () => {
    fs.writeFileSync(path.join(project, "indent.py"), "def f():\n    return 1\n");
    fs.writeFileSync(path.join(project, "tabs.js"), "function f() {\n\treturn 1;\n}\n");
    fs.writeFileSync(path.join(project, "fresh.py"), "");
    await open("indent.py");
    await until("four spaces to be read from the file", async () => (await status()).includes("Spaces: 4"), 4000);
    await K("Control+End");
    await p.keyboard.type("def g(x):"); await K("Enter");
    await p.keyboard.type("if x:"); await K("Enter");
    await p.keyboard.type("y = [");
    await K("Enter"); await p.keyboard.type("1,");
    await save();
    expect(onDisk("indent.py") === "def f():\n    return 1\ndef g(x):\n    if x:\n        y = [\n            1,\n        ]", "Python was indented as:\n" + onDisk("indent.py"));
    // Shift+Tab takes a step back; Tab goes to the next step, however far along the line.
    await K("Control+End"); await K("Enter"); await K("Shift+Tab"); await p.keyboard.type("ab"); await K("Tab"); await p.keyboard.type("c");
    await save();
    expect(onDisk("indent.py").endsWith("\n    ab  c"), "Tab and Shift+Tab: " + JSON.stringify(onDisk("indent.py").split("\n").at(-1)));
    // A file indented with tabs goes on being indented with tabs.
    await open("tabs.js");
    await until("tabs to be read from the file", async () => (await status()).includes("Tabs: 4"), 4000);
    await line(2).click({ position: { x: 4, y: 8 } });
    await K("End"); await K("Enter"); await p.keyboard.type("if (x) {"); await K("Enter"); await p.keyboard.type("y();");
    await save();
    expect(onDisk("tabs.js") === "function f() {\n\treturn 1;\n\tif (x) {\n\t\ty();\n\t}\n}\n", "tabs: " + JSON.stringify(onDisk("tabs.js")));
    // An empty file goes by the settings; the status bar says how, and changes it for the file.
    await open("fresh.py");
    expect((await status()).includes("Spaces: 4"), "an empty Python file should use four spaces: " + (await status()));
    await p.locator(".status .indent").click();
    await typing();
    await p.keyboard.type("2 spaces"); await K("Enter");
    await until("two spaces", async () => (await status()).includes("Spaces: 2"), 3000);
    await p.keyboard.type("if a:"); await K("Enter"); await p.keyboard.type("b");
    await save();
    expect(onDisk("fresh.py") === "if a:\n  b", "picked indentation: " + JSON.stringify(onDisk("fresh.py")));
    // The settings page has the tab size, and a tab is drawn that wide.
    await K("Control+,");
    await p.locator('.settings-page input[aria-label="editor.tabSize"]').fill("8");
    await p.locator('.settings-page input[aria-label="editor.tabSize"]').blur();
    await until("the tab size saved", async () => saved()["editor.tabSize"] === 8, 4000);
    await open("tabs.js");
    await until("tabs eight wide", async () => (await status()).includes("Tabs: 8") && (await css("--tab")) === "8", 3000);
    await K("Control+,");
    await p.locator('.settings-page input[aria-label="editor.tabSize"]').fill("4");
    await p.locator('.settings-page input[aria-label="editor.tabSize"]').blur();
    await until("the tab size back", async () => saved()["editor.tabSize"] === 4, 4000);
    for (const name of ["indent.py", "tabs.js", "fresh.py"]) fs.rmSync(path.join(project, name));
  });

  await check("wide characters and emoji: the caret stands where the text is, and steps over whole characters", async () => {
    fs.writeFileSync(path.join(project, "wide.txt"), "plain\n日本語 text 😀 end\n\ta\tb\n👨‍👩‍👧 family\n");
    await open("wide.txt");
    const caretAt = async () => (await p.locator(".group.focused .caret").first().boundingBox()).x;
    const textEnd = (n) => line(n).evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().right; });
    for (const n of [2, 3, 4]) {
      await line(n).click({ position: { x: 2, y: 8 } });
      await K("End");
      await p.waitForTimeout(250);
      const [caret, end] = [await caretAt(), await textEnd(n)];
      expect(Math.abs(caret - end) <= 2.5, `line ${n}: the caret is at ${caret.toFixed(1)}, the text ends at ${end.toFixed(1)}`);
    }
    // One press of the arrow passes the whole family, and Backspace takes it whole.
    await line(4).click({ position: { x: 2, y: 8 } });
    await K("Home"); await K("ArrowRight");
    expect((await status()).includes("Col 3"), "after one character two cells wide the column should be 3: " + (await status()));
    await K("Backspace");
    await save();
    expect(onDisk("wide.txt").split("\n")[3] === " family", "Backspace left part of the character: " + JSON.stringify(onDisk("wide.txt").split("\n")[3]));
    // A click in the middle of the wide text lands between characters, where it was aimed.
    const box = await line(2).boundingBox();
    const w = (await textEnd(1) - (await line(1).boundingBox()).x) / 5;
    await p.mouse.click(box.x + w * 4.1, box.y + 8);
    await p.keyboard.type("|");
    await save();
    expect(onDisk("wide.txt").split("\n")[1].startsWith("日本|語"), "a click two characters in landed at: " + onDisk("wide.txt").split("\n")[1]);
    await shot("wide-characters");
    fs.rmSync(path.join(project, "wide.txt"));
  });

  await check("folding: a block folds away under its first line, the cursor steps over it, and edits keep it", async () => {
    fs.writeFileSync(path.join(project, "fold.py"), "import os\n\ndef a():\n    x = 1\n    if x:\n        y = 2\n\ndef b():\n    pass\n\nlast = 1\n");
    await open("fold.py");
    await p.locator(".group.focused .fold").first().waitFor();
    expect((await p.locator(".group.focused .fold").count()) === 3, "three blocks can be folded, found " + (await p.locator(".group.focused .fold").count()));
    await p.locator(".group.focused .row", { has: p.locator(".ln", { hasText: /^3$/ }) }).locator(".fold").dispatchEvent("mousedown");
    await until("the block to fold", async () => (await p.locator(".group.focused .ln").allTextContents()).join() === "1,2,3,7,8,9,10,11,12", 3000);
    expect((await line(3).textContent()).includes("⋯"), "the folded line has no mark");
    // Down from the folded line goes past what is hidden; typing above moves the fold with its block.
    await line(3).click({ position: { x: 30, y: 8 } });
    await K("ArrowDown");
    expect((await status()).includes("Ln 7"), "the cursor went into the fold: " + (await status()));
    await K("Control+Home"); await K("Enter");
    await until("the fold to move down a line", async () => (await p.locator(".group.focused .ln").allTextContents()).join() === "1,2,3,4,8,9,10,11,12,13", 3000);
    // Going to a line inside the fold opens it.
    await K("Control+g"); await typing(); await p.keyboard.type("6"); await K("Enter");
    await until("the fold to open", async () => (await p.locator(".group.focused .ln").count()) === 13, 3000);
    // By key, and all at once.
    await K("Control+Shift+[");
    await until("the innermost block to fold", async () => (await p.locator(".group.focused .ln").allTextContents()).join() === "1,2,3,4,5,6,8,9,10,11,12,13", 3000);
    await K("Control+Shift+]");
    await until("it to unfold", async () => (await p.locator(".group.focused .ln").count()) === 13, 3000);
    await commands(); await p.keyboard.type("Fold All"); await p.waitForTimeout(150);
    await p.locator(".result", { has: p.locator("span:first-child", { hasText: /^Fold All$/ }) }).click();
    await until("every block folded", async () => (await p.locator(".group.focused .ln").allTextContents()).join() === "1,2,3,4,8,9,11,12,13", 3000);
    await shot("folding");
    await commands(); await p.keyboard.type("Unfold All"); await p.waitForTimeout(150);
    await p.locator(".result", { has: p.locator("span:first-child", { hasText: /^Unfold All$/ }) }).click();
    await until("every block open", async () => (await p.locator(".group.focused .ln").count()) === 13, 3000);
    // Indent guides run down through the blocks.
    expect((await p.locator(".group.focused .row .guide").count()) >= 5, "there are no indent guides");
    await K("Control+z");
    fs.rmSync(path.join(project, "fold.py"));
  });

  await check("word wrap: long lines take several rows, and the cursor walks them", async () => {
    const long = "word ".repeat(120).trim();
    fs.writeFileSync(path.join(project, "wrap.txt"), "first\n" + long + "\nlast\n");
    await open("wrap.txt");
    expect((await p.locator(".group.focused .row").count()) === 4, "before wrapping, a row for each line");
    await K("Alt+z");
    await until("the long line to wrap", async () => (await p.locator(".group.focused .row").count()) > 5, 4000);
    expect((await p.locator(".group.focused .ln").count()) === 4, "a wrapped line keeps one number");
    expect(saved()["editor.wordWrap"] === "on", "the setting was not written: " + JSON.stringify(saved()["editor.wordWrap"]));
    const scroller = p.locator(".group.focused .scroller");
    expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the editor still scrolls sideways");
    // Down stays in the long line, a row at a time; End, then Down again, reaches the last line.
    await line(1).click({ position: { x: 20, y: 8 } });
    await K("ArrowDown"); await K("ArrowDown");
    expect((await status()).includes("Ln 2"), "two rows down should still be line 2: " + (await status()));
    const rows = (await p.locator(".group.focused .row").count()) - 3;
    for (let i = 0; i < rows - 1; i++) await K("ArrowDown");
    expect((await status()).includes("Ln 3"), "past the last row of the long line is line 3: " + (await status()));
    // A click on a later row lands in the text of that row.
    const second = p.locator(".group.focused .row.wrapped .code").first();
    const box = await second.boundingBox();
    await p.mouse.click(box.x + 3, box.y + 8);
    await p.keyboard.type("#");
    await save();
    const at = onDisk("wrap.txt").split("\n")[1].indexOf("#");
    expect(at > 40 && onDisk("wrap.txt").split("\n")[1][at - 1] === " ", "the click on the second row typed at " + at);
    // The selection across the wrap is drawn on each row.
    await line(2).click({ position: { x: 4, y: 8 } });
    await K("Home"); await K("Shift+End");
    await until("a band on every row of the line", async () => (await p.locator(".group.focused .sel").count()) === rows, 3000);
    await shot("word-wrap");
    await K("Alt+z");
    await until("one row to a line again", async () => (await p.locator(".group.focused .row").count()) === 4, 4000);
    fs.rmSync(path.join(project, "wrap.txt"));
  });

  await check("brackets: the pair of the one at the cursor is marked, and Ctrl+Shift+\\ goes to it", async () => {
    fs.writeFileSync(path.join(project, "pairs.js"), "function f(a, [b, c]) {\n  return { a: (b) };\n}\n");
    await open("pairs.js");
    await line(1).click({ position: { x: 2, y: 8 } });
    await K("End");
    await until("both brackets marked", async () => (await p.locator(".group.focused .bracket").count()) === 2, 3000);
    const tops = await p.locator(".group.focused .bracket").evaluateAll((all) => all.map((b) => Math.round(b.getBoundingClientRect().top)));
    expect(tops[1] - tops[0] > 30, "the pair of the brace on line 1 is on line 3: " + tops.join());
    await K("Control+Shift+\\");
    await until("the cursor at the closing brace", async () => (await status()).includes("Ln 3, Col 1"), 3000);
    await K("Control+Shift+\\");
    await until("and back at the opening one", async () => (await status()).includes("Ln 1"), 3000);
    await K("Home");
    await until("no bracket marked with the cursor on none", async () => (await p.locator(".group.focused .bracket").count()) === 0, 3000);
    fs.rmSync(path.join(project, "pairs.js"));
  });

  // --- 1.2: the explorer ---
  await check("explorer: several files are chosen, copied, cut, pasted, dragged and deleted together", async () => {
    for (const dir of ["pk", "dest", "dest2"]) fs.mkdirSync(path.join(project, dir), { recursive: true });
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) fs.writeFileSync(path.join(project, "pk", name), name + "\n");
    fs.mkdirSync(path.join(project, "pk", "inner")); fs.writeFileSync(path.join(project, "pk", "inner", "deep.txt"), "deep\n");
    await explorer();
    await p.locator('.side .mini[title="Refresh the explorer"]').click();
    await unfold("pk");
    await treeNode("a.txt").waitFor();
    // Ctrl adds one; Shift takes the run between.
    await treeNode("a.txt").click({ modifiers: ["Control"] });
    await treeNode("c.txt").click({ modifiers: ["Control"] });
    const chosen = async () => (await p.locator(".tree.files .node.picked .name").allTextContents()).join();
    await until("the two chosen with Ctrl", async () => (await chosen()) === "a.txt,c.txt", 3000);
    expect((await p.locator(".group.focused .tab.on").textContent()).includes("a.txt") === false, "choosing with Ctrl opened the file");
    await treeNode("a.txt").click({ modifiers: ["Control"] }); await treeNode("c.txt").click({ modifiers: ["Control"] });
    await until("none chosen", async () => (await chosen()) === "", 3000);
    await treeNode("a.txt").click({ modifiers: ["Control"] });
    await treeNode("c.txt").click({ modifiers: ["Shift"] });
    await until("the run chosen with Shift", async () => (await chosen()) === "a.txt,b.txt,c.txt", 3000);
    // Copy the three, paste them into another folder.
    await K("Control+c");
    await treeNode("dest").click();
    await K("Control+v");
    await until("the copies", async () => ["a.txt", "b.txt", "c.txt"].every((n) => fs.existsSync(path.join(project, "dest", n))), 5000);
    expect(fs.existsSync(path.join(project, "pk", "a.txt")), "copying took the original away");
    // Pasting where the name is taken keeps both.
    await K("Control+v");
    await until("a second copy beside the first", async () => fs.existsSync(path.join(project, "dest", "a copy.txt")), 5000);
    // Cut and paste moves, a folder with what is in it.
    await treeNode("inner").click({ modifiers: ["Control"] });
    await K("Control+x");
    await until("what is cut to be shown as cut", async () => (await treeNode("inner").evaluate((n) => n.classList.contains("cut"))), 3000);
    await treeNode("dest2").click({ modifiers: ["Control"] });
    await K("Control+v");
    await until("the folder moved", async () => fs.existsSync(path.join(project, "dest2", "inner", "deep.txt")) && !fs.existsSync(path.join(project, "pk", "inner")), 5000);
    // Dragging a file onto a folder moves it; an open file's tab follows it.
    await treeNode("d.txt").click();
    await until("d.txt open", async () => (await p.locator(".group.focused .tab.on").textContent()).includes("d.txt"), 3000);
    await treeNode("d.txt").dragTo(treeNode("dest2"));
    await until("d.txt moved by dragging", async () => fs.existsSync(path.join(project, "dest2", "d.txt")) && !fs.existsSync(path.join(project, "pk", "d.txt")), 5000);
    await p.locator(".group.focused .content").click({ position: { x: 300, y: 200 } });
    await K("Control+Home");
    await p.keyboard.type("moved ");
    await save();
    expect(fs.readFileSync(path.join(project, "dest2", "d.txt"), "utf8").startsWith("moved "), "the open tab did not follow the file: " + (await p.locator(".group.focused .tab.on").textContent()));
    // A folder cannot be dropped into itself.
    await p.evaluate(() => {
      const at = (name) => [...document.querySelectorAll(".tree.files .node")].find((n) => n.querySelector(".name")?.textContent === name);
      const data = new DataTransfer();
      const fire = (el, kind) => el.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data }));
      fire(at("dest2"), "dragstart"); fire(at("inner"), "dragover"); fire(at("inner"), "drop"); fire(at("dest2"), "dragend");
    });
    await p.waitForTimeout(500);
    expect(fs.existsSync(path.join(project, "dest2", "inner", "deep.txt")) && !fs.existsSync(path.join(project, "dest2", "inner", "dest2")), "a folder went into itself");
    // Files copied in the system's file manager are pasted in.
    const outside = path.join(work, "from-outside.txt");
    fs.writeFileSync(outside, "from outside\n");
    await app.evaluate(({ clipboard, ClipboardItem }, file) => clipboard.write([new ClipboardItem({ "text/uri-list": "file://" + file + "\r\n" })]), outside);
    await treeNode("dest").click();
    await K("Control+v");   // what was cut has been pasted, so Runes' own clipboard is empty
    await until("the outside file brought in", async () => fs.existsSync(path.join(project, "dest", "from-outside.txt")), 5000);
    expect(fs.existsSync(outside), "bringing a file in took it from where it was");
    // Several are deleted with one question.
    await unfold("dest");
    await treeNode("b.txt").first().waitFor();
    const inDest = p.locator('.tree.files .node[data-path$="/dest/b.txt"], .tree.files .node[data-path$="/dest/c.txt"]');
    await K("Escape");   // nothing chosen
    await until("nothing chosen", async () => (await chosen()) === "", 3000).catch(() => {});
    await inDest.first().click({ modifiers: ["Control"] }); await inDest.nth(1).click({ modifiers: ["Control"] });
    await until("the two to delete chosen", async () => (await chosen()) === "b.txt,c.txt", 3000);
    await K("Delete");
    await p.waitForSelector(".prompt");
    expect((await p.locator(".prompt b").textContent()).includes("2 items"), "one question for both: " + (await p.locator(".prompt b").textContent()));
    await p.locator("#runes-prompt").click();
    await until("both gone", async () => !fs.existsSync(path.join(project, "dest", "b.txt")) && !fs.existsSync(path.join(project, "dest", "c.txt")), 5000);
    expect(fs.existsSync(path.join(project, "dest", "a.txt")), "a file that was not chosen was deleted");
    await shot("explorer-several");
    // The shell holds the line: nothing outside the folder is copied from, moved, or written to.
    const refused = await p.evaluate(async ([root, outside]) => {
      const tries = [
        () => window.runesHost.filePlace(["/etc/hostname"], root + "/dest", false),
        () => window.runesHost.filePlace([root + "/pk/a.txt"], "/tmp", true),
        () => window.runesHost.filePlace([root + "/pk"], root + "/pk/x", true),
        () => window.runesHost.fileImport([outside], "/tmp"),
        () => window.runesHost.fileImport(["relative.txt"], root + "/dest"),
        () => window.runesHost.filesRemove(["/etc/hostname"]),
        () => window.runesHost.filesRemove([root]),
      ];
      const out = [];
      for (const t of tries) out.push(await t().then(() => "done", (e) => "refused"));
      return out;
    }, [project, outside]);
    expect(refused.every((r) => r === "refused"), "the shell did something outside the folder: " + refused.join());
    for (const dir of ["pk", "dest", "dest2"]) fs.rmSync(path.join(project, dir), { recursive: true, force: true });
    await p.locator('.side .mini[title="Refresh the explorer"]').click();
  });

  // --- 1.2: extensions ---
  await check("running extensions: each one's state and everything it has said, on a page of its own", async () => {
    await open("shop.bea");
    await commands(); await p.keyboard.type("Show Running Extensions"); await p.waitForTimeout(150); await K("Enter");
    await p.waitForSelector(".running-page");
    await until("the Bea toolkit to be listed as started", async () => (await p.locator(".running-item").allInnerTexts()).some((t) => t.includes("Bea") && /started in \d+ ms/.test(t)), 15000);
    await p.locator(".running-item", { hasText: "Extension host" }).click();
    await until("the host to say what it activated", async () => (await p.locator(".running-log").innerText()).includes("activated"), 8000);
    await shot("running-extensions");
    // Starting the host afresh: the language server comes back, and so do its findings.
    await p.locator(".running-head .button", { hasText: "Restart" }).click();
    await until("the toolkit started again", async () => (await p.locator(".running-item").allInnerTexts()).some((t) => t.includes("Bea") && /started in \d+ ms/.test(t)), 20000);
    expect((await p.locator(".side header .button", { hasText: "Running" }).count()) <= 1, "the Extensions view has no way here");
  });

  await check("an extension that fails to start says why, in the list of running extensions", async () => {
    const zip = require("fflate");
    const manifest = { name: "broken", displayName: "Broken On Purpose", publisher: "runes-test", version: "0.0.1", engines: { vscode: "*" }, main: "./main.js", activationEvents: ["*"] };
    const source = 'const vscode = require("vscode");\nexports.activate = () => {\n  const out = vscode.window.createOutputChannel("Broken");\n  out.appendLine("about to fail");\n  console.log("printed to the console");\n  throw vscode.FileSystemError.FileNotFound("no such thing");\n};\n';
    const vsix = zip.zipSync({ "extension/package.json": zip.strToU8(JSON.stringify(manifest)), "extension/main.js": zip.strToU8(source) });
    const file = path.join(work, "broken.vsix");
    fs.writeFileSync(file, vsix);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await K("Control+Shift+x");
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".side header .button", { hasText: "Install" }).click()]);
    await chooser.setFiles(file);
    await until("the toast that says where to look", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("failed to start"), 10000);
    await commands(); await p.keyboard.type("Show Running Extensions"); await p.waitForTimeout(150); await K("Enter");
    const broken = p.locator(".running-item", { hasText: "Broken On Purpose" });
    await until("it to be listed as failed", async () => (await broken.innerText().catch(() => "")).includes("failed to start"), 8000);
    await broken.click();
    await until("the reason", async () => (await p.locator(".running-error").innerText().catch(() => "")).includes("no such thing"), 4000);
    const said = await p.locator(".running-log").innerText();
    expect(said.includes("about to fail") && said.includes("printed to the console"), "its output channel and console are not shown: " + said.slice(0, 300));
    expect((await p.locator(".running-error").innerText()).includes("FileNotFound"), "the error does not name what it was");
    await shot("extension-failed");
  });

  await check("extensions are switched off and on: off, nothing of theirs is used or run", async () => {
    await K("Control+Shift+x");
    await p.locator(".ext-tab", { hasText: "Installed" }).click();
    await p.locator(".ext", { hasText: "Broken On Purpose" }).click();
    await p.locator('.ext-actions .button[aria-label="Disable Broken On Purpose"]').click();
    await until("it to be listed as disabled", async () => (await p.locator(".ext-list.off .ext b").allTextContents()).includes("Broken On Purpose"), 5000);
    await until("the list kept by the shell", async () => { try { return JSON.parse(fs.readFileSync(path.join(profile, "extensions-disabled.json"), "utf8")).includes("runes-test.broken"); } catch { return false; } }, 5000);
    await commands(); await p.keyboard.type("Show Running Extensions"); await p.waitForTimeout(150); await K("Enter");
    await until("it to be gone from what runs", async () => !(await p.locator(".running-item").allInnerTexts()).some((t) => t.includes("Broken On Purpose")) && (await p.locator(".running-item").count()) > 0, 8000);
    // A language extension switched off: its language is not known, and its server does not run.
    await K("Control+Shift+x");
    await p.locator(".ext", { hasText: "Bea Programming Toolkit" }).first().click();
    await p.locator('.ext-actions .button[aria-label^="Disable"]').click();
    const runs = async () => { await commands(); await p.keyboard.type("Show Running Extensions"); await p.waitForTimeout(150); await K("Enter"); await p.waitForSelector(".running-page"); return p.locator(".running-item"); };
    await until("its language server to be gone from what runs", async () => !(await (await runs()).allInnerTexts()).some((t) => t.includes("Bea")), 10000);
    await commands(); await p.keyboard.type("Bea:"); await p.waitForTimeout(150);
    expect(!(await p.locator(".result small").allTextContents()).some((t) => t.includes("Bea Programming Toolkit")), "a disabled extension's commands are still offered");
    await K("Escape");
    await K("Control+Shift+x");
    await p.locator(".ext-list.off .ext", { hasText: "Bea Programming Toolkit" }).click();
    await p.locator('.ext-actions .button[aria-label^="Enable"]').click();
    await open("shop.bea");
    await until("its language server to run again", async () => (await (await runs()).allInnerTexts()).some((t) => t.includes("Bea") && /started in \d+ ms/.test(t)), 30000);
    // Uninstalling a disabled extension forgets it.
    await K("Control+Shift+x");
    await p.locator(".ext-list.off .ext", { hasText: "Broken On Purpose" }).click();
    await p.locator('.ext-actions .button[aria-label="Uninstall Broken On Purpose"]').click();
    await until("it to be gone", async () => !(await p.locator(".ext b").allTextContents()).includes("Broken On Purpose"), 5000);
    const badId = await p.evaluate(() => window.runesHost.extensionEnable("../../etc/passwd", false).then(() => "done", () => "refused"));
    expect(badId === "refused", "an id that is not one was taken");
    await K("Control+Shift+e");
  });

  // --- 1.2: git is for seeing and staging; merge conflicts are settled in the editor ---
  await check("merge conflicts: listed in Source Control, settled in the editor, staged as resolved", async () => {
    const git = (...args) => execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] }).toString();
    git("stash", "-u", "-q");   // whatever the checks before this one left lying about
    const base = git("rev-parse", "HEAD").trim(), was = git("branch", "--show-current").trim();
    const between = "a\nb\nc\nd\ne\nf\ng\nh\n";
    fs.writeFileSync(path.join(project, "clash.txt"), "top\nmiddle\n" + between + "last\n"); git("add", "clash.txt"); git("commit", "-qm", "clash: base");
    git("checkout", "-qb", "clash-side");
    fs.writeFileSync(path.join(project, "clash.txt"), "top\ntheirs one\n" + between + "theirs two\n"); git("commit", "-qam", "clash: theirs");
    git("checkout", "-q", was);
    fs.writeFileSync(path.join(project, "clash.txt"), "top\nours one\n" + between + "ours two\n"); git("commit", "-qam", "clash: ours");
    try { git("merge", "clash-side"); } catch {}
    expect(onDisk("clash.txt").includes("<<<<<<<"), "git did not leave a conflict to settle");
    await K("Control+Shift+g");
    await p.locator('.side .mini[title="Refresh"]').click();
    await until("the conflicted file under its own heading", async () => (await p.locator(".conflicted .change").allTextContents()).some((t) => t.includes("clash.txt")), 6000);
    await p.locator(".conflicted .change-name").click();
    await until("the ways to settle each conflict", async () => (await p.locator(".group.focused .conflict-bar").count()) === 2, 5000);
    expect((await status()).includes("2 conflicts"), "the status bar does not count them: " + (await status()));
    expect((await p.locator(".group.focused .row.c-ours").count()) === 2 && (await p.locator(".group.focused .row.c-theirs").count()) === 2, "the two sides are not told apart: " + (await p.locator(".group.focused .row.c-ours").count()) + " ours, " + (await p.locator(".group.focused .row.c-theirs").count()) + " theirs");
    await shot("merge-conflict");
    // The first: what is being merged in. The second: both.
    await p.locator(".group.focused .conflict-bar").first().locator(".conflict-take.theirs").dispatchEvent("mousedown");
    await until("one conflict left", async () => (await status()).includes("1 conflict") && !(await status()).includes("conflicts"), 4000);
    await p.locator(".status .conflicts").click();
    await p.locator(".group.focused .conflict-bar").first().locator(".conflict-take.both").dispatchEvent("mousedown");
    await until("none left", async () => !(await status()).includes("conflict"), 4000);
    expect(((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("No conflicts are left"), "nothing says what to do next");
    await save();
    expect(onDisk("clash.txt") === "top\ntheirs one\n" + between + "ours two\ntheirs two\n", "settled as: " + JSON.stringify(onDisk("clash.txt")));
    // It can be undone like any edit.
    await K("Control+z");
    await until("the second conflict back", async () => (await p.locator(".group.focused .conflict-bar").count()) === 1, 3000);
    await K("Control+Shift+z");
    await save();
    // Staging it tells git it is resolved; the merge is finished in the terminal.
    await p.locator('.conflicted .mini[title^="Stage clash.txt"]').click();
    await until("git to have it resolved", async () => git("diff", "--name-only", "--diff-filter=U").trim() === "", 6000);
    await until("it to leave the conflicts", async () => (await p.locator(".conflicted").count()) === 0, 6000);
    git("commit", "-q", "--no-edit");
    git("reset", "-q", "--hard", base); git("branch", "-q", "-D", "clash-side");
    try { git("stash", "pop", "-q"); } catch {}
    await p.locator('.side .mini[title="Refresh"]').click();
    await K("Control+Shift+e");
  });

  // --- 1.2: the terminal's clipboard, reloading, bending lines ---
  await check("terminal: Ctrl+Shift+C copies what is selected, and Ctrl+Shift+V pastes", async () => {
    await K("Control+`");
    await p.waitForSelector("runes-terminal.shown .xterm-screen");
    const term = p.locator("runes-terminal.shown .xterm-rows");
    await p.waitForTimeout(900);
    await p.locator("runes-terminal.shown .xterm-helper-textarea").focus();
    await app.evaluate(({ clipboard }) => clipboard.writeText("echo pasted-$((20+3))"));
    await K("Control+Shift+v");
    await until("the pasted text on the line", async () => ((await term.textContent()) ?? "").includes("echo pasted-"), 5000);
    await K("Enter");
    await until("what was pasted to have run", async () => ((await term.textContent()) ?? "").includes("pasted-23"), 8000)
      .catch(async (e) => { throw new Error(e.message + ": the terminal shows " + JSON.stringify(((await term.textContent()) ?? "").trim().slice(-200)) + ", the keyboard is in " + (await p.evaluate(() => document.activeElement?.className))); });
    await app.evaluate(({ clipboard }) => clipboard.writeText("echo with-ctrl-v"));
    await K("Control+v");
    await until("the text pasted with Ctrl+V on the line", async () => ((await term.textContent()) ?? "").includes("echo with-ctrl-v"), 5000);
    await K("Enter");
    await until("Ctrl+V to paste as well", async () => (((await term.textContent()) ?? "").match(/with-ctrl-v/g) ?? []).length >= 2, 8000);
    // Select a word by double click, copy it.
    await p.keyboard.type("echo copy-me-please"); await K("Enter");
    await until("the line to be printed", async () => (((await term.textContent()) ?? "").match(/copy-me-please/g) ?? []).length >= 2, 8000);
    const spot = await term.evaluate((el) => {
      const rows = [...el.querySelectorAll(":scope > div")];
      const row = rows.filter((r) => r.textContent.trim() === "copy-me-please").pop();
      const box = row.getBoundingClientRect();
      return { x: box.left + 30, y: box.top + box.height / 2 };
    });
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await p.mouse.dblclick(spot.x, spot.y);
    await K("Control+Shift+c");
    await until("the selection on the clipboard", async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).includes("copy-me-please"), 4000);
    // With something selected Ctrl+C copies too, and does not stop what is running.
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await p.mouse.dblclick(spot.x, spot.y);
    await K("Control+c");
    await until("Ctrl+C to copy a selection", async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).includes("copy-me-please"), 4000);
    await K("Control+`");
  });

  // --- 1.3.0 ---------------------------------------------------------------------------------------
  const tree = (name) => p.locator(".tree.files .node", { has: p.locator(".name", { hasText: new RegExp("^" + name.replace(/\./g, "\\.") + "$") }) });
  const listed = async (name) => {
    if (!(await p.locator(".tree.files").count())) { await K("Control+Shift+e"); await p.waitForSelector(".tree.files"); }
    await until(name + " in the explorer", async () => (await tree(name).count()) > 0, 8000);
  };
  const inEditor = async (n = 1) => { await line(n).click({ position: { x: 4, y: 6 } }); await settle(); };


  await check("canvas: a line bends where its middle is pulled, again between two points, and a bend is taken out", async () => {
    const bent = path.join(project, "bent.rux");
    fs.writeFileSync(bent, JSON.stringify({ rune: "canvas", version: 1, elements: [{ id: "ln", type: "arrow", x: 0, y: 0, w: 300, h: 0, sketch: false }] }));
    // A file made a moment ago can be opened by name once the explorer has seen it.
    await listed("bent.rux");
    await p.waitForTimeout(300);
    await open("bent.rux");
    await p.waitForSelector(".group.focused runes-canvas .rc-el");
    const read = () => JSON.parse(fs.readFileSync(bent, "utf8")).elements[0];
    const store = async () => { await K("Control+s"); await until("the drawing saved", async () => !(await p.locator(".group.focused .tab.on").evaluate((t) => t.classList.contains("dirty")).catch(() => true)), 4000); };
    const centre = async (locator) => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const pull = async (locator, dx, dy) => { const c = await centre(locator); await p.mouse.move(c.x, c.y); await p.mouse.down(); await p.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 4 }); await p.mouse.move(c.x + dx, c.y + dy, { steps: 4 }); await p.mouse.up(); await settle(); };
    // Select the arrow: one faint handle in its middle.
    const line = await centre(p.locator(".group.focused runes-canvas .rc-el"));
    await p.mouse.click(line.x - 40, line.y);
    await until("the middle handle", async () => (await p.locator(".group.focused .rc-handle.mid").count()) === 1, 3000);
    await pull(p.locator(".group.focused .rc-handle.mid"), 0, 90);
    await until("a bend, and a middle each side of it", async () => (await p.locator(".group.focused .rc-handle.bend").count()) === 1 && (await p.locator(".group.focused .rc-handle.mid").count()) === 2, 3000);
    await store();
    expect(read().bends?.length === 1 && read().bends[0][1] > 30, "the bend in the file: " + JSON.stringify(read()));
    expect((await p.locator(".group.focused runes-canvas .rc-el path").first().getAttribute("d")).includes("C"), "the line is not drawn as a curve");
    // Between the bend and the end, another.
    await pull(p.locator(".group.focused .rc-handle.mid").last(), 0, -120);
    await until("two bends", async () => (await p.locator(".group.focused .rc-handle.bend").count()) === 2 && (await p.locator(".group.focused .rc-handle.mid").count()) === 3, 3000);
    await store();
    const two = read().bends;
    expect(two.length === 2 && two[0][0] < two[1][0] && two[1][1] < two[0][1], "the second bend comes after the first: " + JSON.stringify(two));
    await shot("canvas-bends");
    // A bend is moved; undone; taken out with a double click; and one pulled straight is no bend.
    await pull(p.locator(".group.focused .rc-handle.bend").first(), -30, 20);
    await store();
    expect(read().bends[0][0] < two[0][0], "the bend did not move");
    await K("Control+z");
    await store();
    expect(JSON.stringify(read().bends) === JSON.stringify(two), "undo did not put the bend back");
    const second = await centre(p.locator(".group.focused .rc-handle.bend").last());
    await p.mouse.dblclick(second.x, second.y);
    await until("one bend left", async () => (await p.locator(".group.focused .rc-handle.bend").count()) === 1, 3000);
    const left = await centre(p.locator(".group.focused .rc-handle.bend"));
    await p.mouse.move(left.x, left.y); await p.mouse.down(); await p.mouse.move(left.x, line.y + 20, { steps: 4 }); await p.mouse.move(left.x, line.y, { steps: 4 }); await p.mouse.up(); await settle();
    await until("the bend to go when the line is straight again", async () => (await p.locator(".group.focused .rc-handle.bend").count()) === 0, 3000);
    await store();
    expect(!("bends" in read()), "a straight line still has bends in the file: " + JSON.stringify(read()));
    fs.rmSync(bent);
  });

  await check("lines: Ctrl+] and Ctrl+[ move them in and out, Ctrl+Shift+K deletes one, Alt+Shift+Down adds cursors", async () => {
    await K("Control+Shift+e");
    fs.writeFileSync(path.join(project, "keys.txt"), "one\ntwo\nthree\nfour\n");
    await listed("keys.txt");
    await open("keys.txt");
    await inEditor(2);
    await K("Control+]");
    await until("the line a step in", async () => /^\s+two$/.test((await lines())[1]), 3000);
    expect((await lines())[0] === "one" && (await lines())[2] === "three", "other lines moved: " + JSON.stringify(await lines()));
    await K("Control+]"); await K("Control+["); await K("Control+[");
    await until("the line back where it was", async () => (await lines())[1] === "two", 3000);
    await K("Control+[");
    expect((await lines())[1] === "two", "a line at the edge moved further out");
    await K("Control+Shift+k");
    await until("the line gone", async () => JSON.stringify((await lines()).slice(0, 3)) === JSON.stringify(["one", "three", "four"]), 3000);
    expect((await status()).includes("Ln 2"), "the cursor is not on the line that took its place: " + await status());
    await K("Control+z");
    await until("undo to bring the line back", async () => (await lines())[1] === "two", 3000);
    // A cursor on each of the next two lines, and what is typed goes to all three.
    await K("Control+Home");
    await K("Alt+Shift+ArrowDown"); await K("Alt+Shift+ArrowDown");
    await until("three cursors", async () => (await p.locator(".group.focused .caret").count()) === 3, 3000);
    await p.keyboard.type("> ");
    await until("the text at every cursor", async () => JSON.stringify((await lines()).slice(0, 4)) === JSON.stringify(["> one", "> two", "> three", "four"]), 3000);
    await K("Alt+Shift+ArrowUp");
    expect((await p.locator(".group.focused .caret").count()) === 3, "a cursor was added above the first line");
    await K("Escape");
    await save();
  });

  await check("explorer: F2 renames the file in front, and the file that was clicked, not a folder opened before it", async () => {
    await open("keys.txt");
    await inEditor(1);
    await K("F2");
    await p.waitForSelector("#runes-naming");
    expect((await p.locator("#runes-naming").inputValue()) === "keys.txt", "F2 in the editor is about " + await p.locator("#runes-naming").inputValue());
    await p.locator("#runes-naming").fill("renamed.txt"); await K("Enter");
    await until("the file renamed, on disk and in its tab", async () => fs.existsSync(path.join(project, "renamed.txt")) && !fs.existsSync(path.join(project, "keys.txt")) && ((await p.locator(".group.focused .tab.on").textContent()) ?? "").includes("renamed.txt"), 5000);
    // A folder is opened, then a file is clicked: F2 in the explorer is about the file.
    await unfold("src");
    await tree("renamed.txt").click();
    await tree("renamed.txt").focus();
    await K("F2");
    await p.waitForSelector("#runes-naming");
    expect((await p.locator("#runes-naming").inputValue()) === "renamed.txt", "F2 in the explorer is about " + await p.locator("#runes-naming").inputValue());
    await K("Escape");
    expect(fs.existsSync(path.join(project, "renamed.txt")), "Escape renamed something");
  });

  await check("explorer: opening an empty folder leaves every row below it as it was", async () => {
    fs.mkdirSync(path.join(project, "aaa-empty"));
    await listed("aaa-empty");
    // The rows below are remembered as the very elements they are.
    await p.evaluate(() => { window.__rows = [...document.querySelectorAll(".tree.files .node")].map((n) => [n, n.querySelector(".name").textContent]); });
    await tree("aaa-empty").click();
    await until("the folder open", async () => tree("aaa-empty").evaluate((n) => n.classList.contains("open")), 3000);
    await settle();
    const moved = await p.evaluate(() => window.__rows.filter(([n, name]) => !n.isConnected || n.querySelector(".name")?.textContent !== name).map(([, name]) => name));
    expect(moved.length === 0, "rows were drawn afresh: " + moved.join(", "));
    const running = await p.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.classList?.contains("children") && a.playState === "running").map((a) => a.effect.target.previousElementSibling?.textContent + " (" + a.effect.target.children.length + " inside)"));
    expect(running.length === 0, "folders being unfolded again: " + running.join(", "));
    await tree("aaa-empty").click();
    await settle();
    const after = await p.evaluate(() => window.__rows.filter(([n, name]) => !n.isConnected || n.querySelector(".name")?.textContent !== name).length);
    expect(after === 0, "closing it drew rows afresh");
    await p.evaluate(() => { delete window.__rows; });
    fs.rmdirSync(path.join(project, "aaa-empty"));
  });

  await check("explorer: Ctrl+Z brings back a deleted file and a deleted folder, exactly as they were", async () => {
    const at = (name) => path.join(project, name);
    fs.writeFileSync(at("gone.txt"), "do not lose me\n");
    fs.mkdirSync(at("gonedir/deep"), { recursive: true });
    fs.writeFileSync(at("gonedir/deep/in.bin"), Buffer.from([0, 1, 2, 250]));
    await listed("gone.txt"); await listed("gonedir");
    const agree = async () => { await p.locator(".prompt .button", { hasText: /Move to trash/ }).click(); };
    const inTree = () => p.waitForFunction(() => document.activeElement?.closest?.(".tree.files"), null, { timeout: 4000 });
    await tree("renamed.txt").click(); await p.waitForTimeout(450); await tree("renamed.txt").focus();
    // Whatever earlier checks deleted is brought back first, one deletion to a press, and removed
    // again by hand: then there is nothing to undo, it says so, and the file being edited is untouched.
    const before = await lines();
    const had = new Set(fs.readdirSync(project));
    let said = "";
    for (let i = 0; i < 30 && !/no deletion to undo/.test(said); i++) {
      await p.evaluate(() => document.querySelector(".tree.files").focus());
      await K("Control+z");
      await until("an answer", async () => /no deletion to undo|Put back|could not be put back/.test((await p.locator(".toast").textContent().catch(() => "")) ?? ""), 5000).catch(async (e) => { throw new Error(e.message + ": it says " + JSON.stringify(await p.locator(".toast").textContent().catch(() => ""))); });
      said = (await p.locator(".toast").textContent()) ?? "";
      if (!/no deletion to undo/.test(said)) await until("that toast to go", async () => !/Put back|could not be put back/.test((await p.locator(".toast").textContent().catch(() => "")) ?? ""), 8000);
    }
    expect(/no deletion to undo/.test(said), "Ctrl+Z never ran out of deletions to undo: " + said);
    for (const name of fs.readdirSync(project)) if (!had.has(name)) fs.rmSync(path.join(project, name), { recursive: true, force: true });
    expect(JSON.stringify(await lines()) === JSON.stringify(before), "Ctrl+Z in the explorer changed the text of the file in front");
    // A click on a file opens it, and the keyboard goes to the editor: it is brought back to the row.
    const pick = async (name) => {
      await p.evaluate((name) => document.querySelector(`.tree.files .node[data-path$="/${name}"]`).click(), name);
      await p.waitForTimeout(450);
      await p.evaluate((name) => document.querySelector(`.tree.files .node[data-path$="/${name}"]`).focus(), name);
    };
    await pick("gone.txt");
    await K("Delete");
    await p.waitForSelector(".prompt");
    expect(((await p.locator(".prompt").innerText()) ?? "").includes("Ctrl+Z"), "the question does not say it can be undone");
    await agree();
    await until("the file gone", async () => !fs.existsSync(at("gone.txt")) && (await tree("gone.txt").count()) === 0, 5000);
    await inTree();
    await K("Control+z");
    await until("the file back", async () => fs.existsSync(at("gone.txt")) && (await tree("gone.txt").count()) === 1, 5000);
    expect(fs.readFileSync(at("gone.txt"), "utf8") === "do not lose me\n", "it came back changed");
    expect(((await p.locator(".toast").textContent()) ?? "").includes("Put back gone.txt"), "it does not say what came back");
    // A folder, with what is in it; and two deletions are taken back last first.
    await pick("gonedir");
    await K("Delete"); await p.waitForSelector(".prompt"); await agree();
    await until("the folder gone", async () => !fs.existsSync(at("gonedir")), 5000);
    await inTree();
    await pick("gone.txt");
    await K("Delete"); await p.waitForSelector(".prompt"); await agree();
    await until("the file gone again", async () => !fs.existsSync(at("gone.txt")), 5000);
    await inTree();
    await K("Control+z");
    await until("the file back first", async () => fs.existsSync(at("gone.txt")), 5000);
    expect(!fs.existsSync(at("gonedir")), "the folder came back before the file deleted after it");
    await inTree().catch(() => {});
    await p.evaluate(() => document.querySelector(".tree.files").focus());
    await K("Control+z");
    await until("the folder back, with what was in it", async () => fs.existsSync(at("gonedir/deep/in.bin")), 5000);
    expect([...fs.readFileSync(at("gonedir/deep/in.bin"))].join() === "0,1,2,250", "what was in the folder changed");
    expect(fs.readdirSync(path.join(profile, "undo")).length === 0, "everything was put back, and something is still held: " + fs.readdirSync(path.join(profile, "undo")).join());
    // A place that has been taken since: what was there is not overwritten, the deleted one goes
    // to the trash, and it says so.
    await pick("gone.txt");
    await K("Delete"); await p.waitForSelector(".prompt"); await agree();
    await until("the file gone once more", async () => !fs.existsSync(at("gone.txt")), 5000);
    fs.writeFileSync(at("gone.txt"), "someone else's now\n");
    await inTree().catch(() => {});
    await p.evaluate(() => document.querySelector(".tree.files").focus());
    await K("Control+z");
    await until("it to say it could not be put back", async () => /could not be put back.*in the trash/.test((await p.locator(".toast").textContent().catch(() => "")) ?? ""), 5000);
    expect(fs.readFileSync(at("gone.txt"), "utf8") === "someone else's now\n", "what took its place was overwritten");
    // The window cannot name what comes back or where: there is nothing left to take back.
    const more = await p.evaluate(() => window.runesHost.fileUndo("/etc/passwd").then(() => "allowed", (e) => String(e.message)));
    expect(/no deletion to undo/.test(more), "asked to undo with nothing deleted: " + more);
    fs.rmSync(at("gonedir"), { recursive: true }); fs.rmSync(at("gone.txt"));
  });

  // An extension that says what a real language server says: problems at every level, what a
  // call expects, and the named things of a file.
  await check("problems: a module that cannot be found is an error; hints are marked and not underlined or listed", async () => {
    const zip = require("fflate");
    const manifest = { name: "levels", displayName: "Demo Levels", publisher: "runes-test", version: "0.0.1", engines: { vscode: "*" }, main: "./main.js", activationEvents: ["*"] };
    const source = `
      const vscode = require("vscode");
      exports.activate = (context) => {
        const found = vscode.languages.createDiagnosticCollection("levels");
        const look = (document) => {
          if (!document.fileName.endsWith("levels.md")) return;
          const at = (line, text, severity, tags) => { const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 6), text, severity); if (tags) d.tags = tags; return d; };
          found.set(document.uri, [
            at(0, 'Import "nowhere" could not be resolved', vscode.DiagnosticSeverity.Information),
            at(1, "\`unused\` is not accessed", vscode.DiagnosticSeverity.Hint, [vscode.DiagnosticTag.Unnecessary]),
            at(2, "old() is deprecated", vscode.DiagnosticSeverity.Hint, [vscode.DiagnosticTag.Deprecated]),
            at(3, "consider a shorter name", vscode.DiagnosticSeverity.Hint),
            at(4, "be careful here", vscode.DiagnosticSeverity.Warning),
            at(5, "for your information", vscode.DiagnosticSeverity.Information),
          ]);
        };
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(look), vscode.workspace.onDidChangeTextDocument((e) => look(e.document)));
        vscode.workspace.textDocuments.forEach(look);
        context.subscriptions.push(vscode.languages.registerSignatureHelpProvider({ language: "markdown" }, {
          provideSignatureHelp(document, position) {
            const before = document.lineAt(position.line).text.slice(0, position.character);
            const open = before.lastIndexOf("shout(");
            if (open < 0 || before.slice(open).includes(")")) return null;
            const help = new vscode.SignatureHelp();
            const one = new vscode.SignatureInformation("shout(text: string, times: number) -> string", new vscode.MarkdownString("Says it **loudly**."));
            one.parameters = [new vscode.ParameterInformation("text: string", "What to say."), new vscode.ParameterInformation([20, 33], "How many times.")];
            help.signatures = [one, new vscode.SignatureInformation("shout() -> string")];
            help.activeSignature = 0;
            help.activeParameter = Math.min(1, before.slice(open).split(",").length - 1);
            return help;
          },
        }, "(", ","));
        context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ language: "markdown" }, {
          provideDocumentSymbols(document) {
            const out = [];
            for (let i = 0; i < document.lineCount; i++) {
              const text = document.lineAt(i).text;
              if (!text.startsWith("# ")) continue;
              let end = i;
              while (end + 1 < document.lineCount && !document.lineAt(end + 1).text.startsWith("# ")) end++;
              const whole = new vscode.Range(i, 0, end, 0);
              const section = new vscode.DocumentSymbol(text.slice(2), "", vscode.SymbolKind.Class, whole, whole);
              for (let j = i + 1; j <= end; j++) if (document.lineAt(j).text.startsWith("## ")) section.children.push(new vscode.DocumentSymbol(document.lineAt(j).text.slice(3), "", vscode.SymbolKind.Method, new vscode.Range(j, 0, j + 1, 0), new vscode.Range(j, 0, j, 1)));
              out.push(section);
            }
            return out;
          },
        }));
      };`;
    const file = path.join(work, "levels.vsix");
    fs.writeFileSync(file, zip.zipSync({ "extension/package.json": zip.strToU8(JSON.stringify(manifest)), "extension/main.js": zip.strToU8(source) }));
    fs.writeFileSync(path.join(project, "levels.md"), "import nowhere\nunused = 1\nold()\nlongname\ncareful\ninform\n\n# Shop\n\n## open\ntext\n\n## shut\nmore\n\n# Other\nlast\n");
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await K("Control+Shift+x");
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".side header .button", { hasText: "Install" }).click()]);
    await chooser.setFiles(file);
    await until("the install", async () => (await p.locator(".ext b").allTextContents()).includes("Demo Levels"), 20000);
    await K("Control+Shift+e");
    await listed("levels.md");
    await open("levels.md");
    const marks = () => p.evaluate(() => [...document.querySelectorAll(".group.focused .squiggle")].map((s) => [Math.round(parseFloat(s.style.top) / parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row"))), [...s.classList].find((c) => c.startsWith("sev-"))]).sort((a, b) => a[0] - b[0]));
    await until("the six problems", async () => (await marks()).length === 6, 15000);
    expect(JSON.stringify(await marks()) === JSON.stringify([[0, "sev-1"], [1, "sev-5"], [2, "sev-6"], [3, "sev-4"], [4, "sev-2"], [5, "sev-3"]]), "how the problems are marked: " + JSON.stringify(await marks()));
    const look = (n) => p.evaluate((n) => { const s = document.querySelector(".group.focused .squiggle.sev-" + n), c = getComputedStyle(s); return { mask: c.webkitMaskImage || c.maskImage, colour: c.backgroundColor, width: s.getBoundingClientRect().width }; }, n);
    expect((await look(1)).colour === await p.evaluate(() => { const d = document.createElement("i"); d.style.color = getComputedStyle(document.documentElement).getPropertyValue("--error"); document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }), "a module that cannot be found is not in the colour of an error: " + JSON.stringify(await look(1)));
    expect((await look(5)).mask === "none" && (await look(6)).mask === "none", "code that is not needed, or out of date, is underlined");
    expect((await look(4)).width < 30, "a plain hint is drawn the whole length of what it is about: " + (await look(4)).width);
    // Errors, warnings and notes are listed and counted; hints are neither.
    await K("Control+Shift+m");
    await until("the list of problems", async () => (await p.locator(".problem").count()) >= 3, 4000);
    const said = (await p.locator(".problem").allInnerTexts()).join("\n");
    expect(said.includes("could not be resolved") && said.includes("be careful here") && said.includes("for your information"), "problems listed: " + said);
    expect(!said.includes("not accessed") && !said.includes("deprecated") && !said.includes("shorter name"), "hints are listed as problems: " + said);
    expect((await p.locator(".problem.sev-1").count()) === 1, "the missing module is not listed as an error");
    const counted = (await p.locator(".status .counts").innerText()).replace(/\D+/g, " ").trim();
    expect(counted === "1 1", "one error and one warning are not what the status bar counts: " + counted);
    await shot("problem-levels");
    // F8 goes from problem to problem and passes the hints by.
    await inEditor(1);
    await K("F8"); expect((await status()).includes("Ln 5"), "F8 from the first problem went to " + await status());
    await K("F8"); expect((await status()).includes("Ln 6"), "F8 again went to " + await status());
    await K("Escape");
    await K("Control+j");
  });

  await check("signature help: what the call being written expects, with the argument in hand marked", async () => {
    await open("levels.md");
    await inEditor(1);
    await K("Control+End");
    await p.keyboard.type("shout(");
    await p.waitForSelector(".group.focused .signature", { timeout: 8000 }).catch(async (e) => { throw new Error(e.message.split("\n")[0] + ": lines " + JSON.stringify((await lines()).slice(-3)) + ", floats " + JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("runes-float")].map((f) => f.className + " " + f.style.cssText))) + ", keyboard in " + (await p.evaluate(() => document.activeElement?.id + "." + document.activeElement?.className)) + ", status " + (await status())); });
    const sig = p.locator(".group.focused .signature");
    expect((await sig.locator(".signature-label").innerText()).includes("shout(text: string, times: number) -> string"), "the signature: " + await sig.innerText());
    expect((await sig.locator(".signature-arg").innerText()) === "text: string", "the first argument is not the one marked: " + await sig.locator(".signature-arg").innerText());
    expect((await sig.innerText()).includes("What to say.") && (await sig.innerText()).includes("loudly"), "what the server says of it is not shown: " + await sig.innerText());
    expect((await sig.locator(".signature-count").innerText()) === "1 of 2", "it does not say there are two signatures");
    // It stands over the line, inside the window, and adds nothing to what the editor scrolls to.
    const where = await p.evaluate(() => { const s = document.querySelector(".group.focused .signature").getBoundingClientRect(), c = document.querySelector(".group.focused .caret").getBoundingClientRect(), sc = document.querySelector(".group.focused .scroller"); return { above: s.bottom <= c.top + 1, inside: s.left >= 0 && s.right <= innerWidth && s.top >= 0, wide: sc.scrollWidth - sc.clientWidth, fixed: getComputedStyle(document.querySelector(".group.focused .signature")).position }; });
    expect(where.above && where.inside && where.fixed === "fixed" && where.wide <= 0, "where the help is: " + JSON.stringify(where));
    await shot("signature-help");
    await p.keyboard.type('"hello", ');
    await until("the second argument to be the one marked", async () => (await sig.locator(".signature-arg").innerText().catch(() => "")) === "times: number", 6000);
    expect((await sig.innerText()).includes("How many times."), "the second argument is not explained: " + await sig.innerText());
    // Moving back along the line follows; leaving the call closes it; Escape closes it.
    for (let i = 0; i < 9; i++) await K("ArrowLeft");
    await until("the first argument again", async () => (await sig.locator(".signature-arg").innerText().catch(() => "")) === "text: string", 6000);
    for (let i = 0; i < 9; i++) await K("ArrowRight");
    await p.keyboard.type("3)");
    await until("it to close when the call is closed", async () => (await sig.count()) === 0, 6000);
    await K("Backspace");
    await commands(); await p.keyboard.type("Trigger Parameter Hints"); await p.waitForTimeout(450); await K("Enter");
    await p.waitForSelector(".group.focused .signature", { timeout: 6000 });
    await K("Escape");
    await until("Escape to close it", async () => (await sig.count()) === 0, 3000);
    await K("Control+z"); await K("Control+z"); await K("Control+z"); await K("Control+z");
  });

  await check("breadcrumbs: where the file is and what the cursor is inside, from the server or from the indentation", async () => {
    await open("levels.md");
    const crumbs = async () => (await p.locator(".group.focused .crumbs").innerText()).replace(/\s*›\s*/g, " › ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const names = () => p.locator(".group.focused .crumbs .crumb.symbol").evaluateAll((all) => all.map((c) => c.lastChild.textContent));
    await inEditor(11);
    await until("the section and the part of it the cursor is in", async () => JSON.stringify(await names()) === JSON.stringify(["Shop", "open"]), 10000).catch(async (e) => { throw new Error(e.message + ": " + await crumbs()); });
    const file = async () => (await p.locator(".group.focused .crumbs .crumb.file").innerText()).trim().split(/\s+/).pop();
    const folders = () => p.locator(".group.focused .crumbs .crumb.folder").allInnerTexts();
    expect((await file()) === "levels.md" && (await folders()).length === 0, "the file is not named: " + await crumbs());
    await inEditor(14);
    await until("the next part", async () => JSON.stringify(await names()) === JSON.stringify(["Shop", "shut"]), 5000);
    await inEditor(17);
    await until("the other section", async () => JSON.stringify(await names()) === JSON.stringify(["Other"]), 5000);
    await inEditor(2);
    await until("nothing, outside every section", async () => (await names()).length === 0, 5000);
    // A name that is clicked is gone to.
    await inEditor(14);
    await until("both names", async () => (await names()).length === 2, 5000);
    await p.locator(".group.focused .crumbs .crumb.symbol", { hasText: "Shop" }).click();
    await until("the cursor at the section", async () => (await status()).includes("Ln 8"), 4000);
    // A file inside a folder says the folders; with no server, the names come from the indentation.
    fs.writeFileSync(path.join(project, "src/crumbs.py"), "import os\n\n\nclass Shop:\n    def total(self, items):\n        for item in items:\n            yield item\n\n\ndef main():\n    pass\n");
    await p.waitForTimeout(600);
    await open("crumbs.py");
    await inEditor(7);
    await until("the class and the function", async () => JSON.stringify(await names()) === JSON.stringify(["Shop", "total"]), 5000).catch(async (e) => { throw new Error(e.message + ": " + await crumbs()); });
    expect((await folders()).join() === "src" && (await file()) === "crumbs.py", "the path: " + await crumbs());
    expect((await p.locator(".group.focused .crumbs").getAttribute("title")) === path.join(project, "src/crumbs.py"), "the whole path is not there to be read");
    await inEditor(11);
    await until("the function at the end", async () => JSON.stringify(await names()) === JSON.stringify(["main"]), 5000);
    await shot("breadcrumbs");
    // It is a setting.
    const was = (await p.locator(".group.focused .scroller").boundingBox()).y;
    await commands(); await p.keyboard.type("Toggle Breadcrumbs"); await p.waitForTimeout(450); await K("Enter");
    await until("the line to go when it is turned off", async () => (await p.locator(".group.focused .crumbs").count()) === 0, 8000);
    expect((await p.locator(".group.focused .scroller").boundingBox()).y < was, "the editor did not take the room");
    expect(saved()["breadcrumbs.enabled"] === false, "the choice is not in the settings");
    await commands(); await p.keyboard.type("Toggle Breadcrumbs"); await p.waitForTimeout(450); await K("Enter");
    await until("the line back", async () => (await p.locator(".group.focused .crumbs").count()) === 1, 8000);
    await K("Control+w");
    fs.rmSync(path.join(project, "src/crumbs.py"));
  });

  await check("suggestions: the list stays through a slash, closes for good on Escape, and never scrolls the editor sideways", async () => {
    await open("shop.bea");
    await inEditor(1);
    const wrapped = saved()["editor.wordWrap"] === "on";
    if (!wrapped) await K("Alt+z");
    await until("word wrap on", async () => saved()["editor.wordWrap"] === "on", 8000);
    await K("Control+Home"); await K("Enter"); await K("ArrowUp");
    const offered = () => p.locator(".group.focused .suggest .option b").allTextContents();
    await p.keyboard.type("import gleam", { delay: 60 });
    await until("the modules, from the server", async () => (await offered()).some((o) => o.startsWith("gleam/")), 30000, async () => { await K("Backspace"); await p.keyboard.type("m"); });
    await p.keyboard.type("/");
    await p.waitForTimeout(700);
    expect((await offered()).some((o) => o.startsWith("gleam/")), "the list went when the slash was typed: " + JSON.stringify(await offered()));
    await p.keyboard.type("li", { delay: 60 });
    await until("the list narrowed to what fits", async () => { const now = await offered(); return now.length > 0 && now.every((o) => /l.*i/.test(o)) && now.includes("gleam/list"); }, 8000);
    // Going down a list longer than it shows moves the list, and nothing else.
    await K("Escape");
    for (let i = 0; i < 3; i++) await K("Backspace");
    await K("Control+Space");
    await until("the whole list again", async () => (await offered()).length > 8, 15000, async () => { await K("Escape"); await K("Control+Space"); });
    const facts = () => p.evaluate(() => { const s = document.querySelector(".group.focused .scroller"), n = document.querySelector(".group.focused .ln").getBoundingClientRect(), b = document.querySelector(".group.focused .suggest-box"), r = b.getBoundingClientRect(); return { left: s.scrollLeft, over: s.scrollWidth - s.clientWidth, numbers: n.left >= s.getBoundingClientRect().left - 1, fixed: getComputedStyle(b).position, inside: r.right <= innerWidth && r.left >= 0 }; });
    for (let i = 0; i < 14; i++) await K("ArrowDown");
    await p.waitForTimeout(300);
    const f = await facts();
    expect(f.left === 0 && f.over <= 0 && f.numbers && f.fixed === "fixed" && f.inside, "the editor with the list open: " + JSON.stringify(f));
    const chosen = await p.evaluate(() => { const on = document.querySelector(".suggest .option.on").getBoundingClientRect(), list = document.querySelector(".suggest").getBoundingClientRect(); return on.top >= list.top - 1 && on.bottom <= list.bottom + 1; });
    expect(chosen, "the chosen suggestion is not in sight in its list");
    // Near the right edge the list is kept inside the window, and still widens nothing.
    await K("Escape");
    await K("End");
    const room = await p.evaluate(() => { const s = document.querySelector(".group.focused .scroller"), c = document.querySelector(".group.focused .caret").getBoundingClientRect(); const w = document.querySelector(".group.focused .code").getBoundingClientRect().width / Math.max(1, document.querySelector(".group.focused .code").textContent.length); return Math.floor((s.getBoundingClientRect().right - c.left) / (w || 8)) - 14; });
    await p.keyboard.type(" " + "x".repeat(Math.max(4, room)) + " gleam/in", { delay: 5 });
    await until("the list at the edge", async () => (await offered()).length > 0, 15000, async () => { await K("Backspace"); await p.keyboard.type("n"); });
    const edge = await facts();
    expect(edge.left === 0 && edge.over <= 0 && edge.numbers && edge.inside, "the editor with the list at its right edge: " + JSON.stringify(edge));
    await shot("suggest-edge");
    // Escape closes the list, and an answer still on its way does not open it again.
    await p.keyboard.type("t");
    await K("Escape");
    await p.waitForTimeout(1500);
    expect((await offered()).length === 0, "the list came back after Escape: " + JSON.stringify(await offered()));
    // Nothing of this is kept: the tab is closed with its changes.
    await K("Escape");
    await K("Control+w");
    if (!wrapped) { await open("README.md"); await K("Alt+z"); await until("word wrap off again", async () => saved()["editor.wordWrap"] !== "on", 8000); }
  });

  await check("tabs: one dropped on another group's strip of tabs joins that group, at the tab it is dropped on", async () => {
    for (const name of ["t1.txt", "t2.txt", "t3.txt"]) fs.writeFileSync(path.join(project, name), name + "\n");
    await listed("t3.txt");
    await open("t1.txt"); await open("t2.txt");
    await K("Control+\\");
    await until("two groups", async () => (await p.locator(".group").count()) === 2, 4000);
    await open("t3.txt");
    // A tab's name comes after its icon, which is a letter of an icon font.
    const tabsOf = () => p.evaluate(() => [...document.querySelectorAll(".group")].map((g) => [...g.querySelectorAll(".tab .tab-name")].map((t) => t.textContent.replace(/[^\x21-\x7e]/g, ""))));
    const before = await tabsOf();
    const groups = before.length;
    // Dropped on the strip itself, past the last tab: it joins the group at the end.
    const drop = (name, group, onto) => p.evaluate(([name, group, onto]) => {
      const all = [...document.querySelectorAll(".group")];
      const called = (t) => t.querySelector(".tab-name").textContent.replace(/[^\x21-\x7e]/g, "");
      const named = [...document.querySelectorAll(".tab")].filter((t) => called(t) === name);
      const to = group < 0 ? 0 : group;
      // From another group when it is in one; else from the group itself (to put it in another place there).
      const tab = named.find((t) => all.indexOf(t.closest(".group")) !== to) ?? named[0];
      const strip = all[to].querySelector(".tabs");
      const target = onto ? [...strip.querySelectorAll(".tab")].find((t) => called(t) === onto) : strip;
      const data = new DataTransfer();
      const fire = (el, kind) => el.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data }));
      fire(tab, "dragstart");
      return new Promise((done) => requestAnimationFrame(() => { fire(target, "dragover"); requestAnimationFrame(() => { const lit = strip.classList.contains("drop-here"); fire(target, "drop"); fire(tab, "dragend"); done(lit); }); }));
    }, [name, group, onto]);
    const lit = await drop("t3.txt", 0, "");
    expect(lit, "the strip does not show that a tab can be dropped on it");
    await until("the tab in the first group, last", async () => { const now = await tabsOf(); return now[0][now[0].length - 1] === "t3.txt"; }, 4000).catch(async (e) => { throw new Error(e.message + ": " + JSON.stringify(await tabsOf())); });
    expect((await p.locator(".group").count()) <= groups, "a new tile was made: " + JSON.stringify(await tabsOf()));
    expect(((await p.locator(".group.focused .tab.on").textContent()) ?? "").includes("t3.txt"), "the tab that was moved is not the one in front");
    // Dropped on a tab: it goes in before that tab. This is also how tabs are put in another order.
    await drop("t3.txt", -1, "t1.txt");
    await until("the tab before the one it was dropped on", async () => { const now = (await tabsOf())[0]; return now.indexOf("t3.txt") === now.indexOf("t1.txt") - 1; }, 4000).catch(async (e) => { throw new Error(e.message + ": " + JSON.stringify(await tabsOf())); });
    // From one group to a place in another.
    if ((await p.locator(".group").count()) < 2) { await K("Control+\\"); await until("two groups again", async () => (await p.locator(".group").count()) === 2, 4000); }
    const two = await tabsOf();
    const mover = two[1].find((t) => !two[0].includes(t)) ?? two[1][0];
    const onto = two[0].find((t) => t !== mover && /^t\d/.test(t) && two[0].indexOf(t) !== two[0].indexOf(mover) + 1);
    await drop(mover, 0, onto);
    await until("the tab in the first group, before the one it was dropped on", async () => { const now = (await tabsOf())[0]; return now.includes(mover) && now.indexOf(mover) === now.indexOf(onto) - 1; }, 4000).catch(async (e) => { throw new Error(e.message + ": moved " + mover + " onto " + onto + " from " + JSON.stringify(two) + " to " + JSON.stringify(await tabsOf())); });
    expect((await p.locator(".group").count()) === 1, "the group the tab left, now empty, is still there");
    await shot("tabs-grouped");
    // Back to one group, and the test files closed.
    for (let i = 0; i < 6 && (await p.locator(".group").count()) > 1; i++) { await p.locator(".group").last().locator(".tab.on .tab-close").click().catch(() => {}); await settle(); }
    for (const name of ["t1.txt", "t2.txt", "t3.txt"]) { const tab = p.locator(".tab", { hasText: name }).first(); if (await tab.count()) await tab.locator(".tab-close").click(); fs.rmSync(path.join(project, name), { force: true }); }
  });

  await check("terminal: a password or a token typed into it never becomes its name", async () => {
    await K("Control+`");
    await p.waitForSelector("runes-terminal.shown .xterm-screen");
    const term = p.locator("runes-terminal.shown .xterm-rows");
    const name = async () => ((await p.locator(".term-list .term-tab.on").innerText().catch(() => "")) ?? "").trim().split("\n")[0].trim();
    await p.waitForTimeout(600);
    await p.locator("runes-terminal.shown .xterm-helper-textarea").focus();
    await p.keyboard.type("echo named-by-command"); await K("Enter");
    await until("the terminal named after the command", async () => (await name()).includes("echo named-by-command"), 6000).catch(async (e) => { throw new Error(e.message + ": it is called " + await name()); });
    // A program that asks for something: what is typed to it is not a command, shown or not.
    await p.keyboard.type("read -s -p 'Password: ' pw; echo; read -p 'Username: ' who"); await K("Enter");
    await until("the first question", async () => ((await term.textContent()) ?? "").includes("Password:"), 6000);
    // (Its name by now is the command that asks: names are given a moment after Enter.)
    await until("the terminal named after the asking command", async () => (await name()).startsWith("read"), 6000);
    const asked = await name();
    await p.keyboard.type("hunter2-the-password"); await K("Enter");
    await until("the second question", async () => ((await term.textContent()) ?? "").includes("Username:"), 6000);
    await app.evaluate(({ clipboard }) => clipboard.writeText("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    await K("Control+Shift+v");
    await until("the pasted token on the line", async () => ((await term.textContent()) ?? "").includes("ghp_abcdefghij"), 5000);
    await K("Enter");
    await p.waitForTimeout(900);
    const every = (await p.locator(".term-list .term-tab").allInnerTexts()).join(" | ") + " | " + (await p.locator(".tab").allInnerTexts()).join(" | ");
    expect(!every.includes("hunter2") && !every.includes("ghp_"), "a secret is on show in a name: " + every);
    expect((await name()) === asked, "the name changed while a program had the terminal: " + await name());
    // A token at the shell's own prompt, and a command that carries one: never the token.
    await K("Control+Shift+v");
    await until("the token pasted at the prompt", async () => (((await term.textContent()) ?? "").match(/ghp_abcdefghij/g) ?? []).length >= 2, 5000);
    await K("Enter");
    await until("the shell to say it is no command", async () => ((await term.textContent()) ?? "").includes("not found"), 6000);
    expect(!(await name()).includes("ghp_"), "a token pasted at the prompt named the terminal: " + await name());
    // A program the shell started has the terminal: what is typed to it is its own, shown or not.
    await p.keyboard.type("cat"); await K("Enter");
    await until("the terminal named after the program", async () => (await name()) === "cat", 6000).catch(async (e) => { throw new Error(e.message + ": it is called " + JSON.stringify(await name()) + ", and shows " + JSON.stringify(((await term.textContent()) ?? "").trim().slice(-160))); });
    await p.keyboard.type("words typed into cat"); await K("Enter");
    await until("the program to have taken them", async () => (((await term.textContent()) ?? "").match(/words typed into cat/g) ?? []).length >= 2, 6000);
    await p.waitForTimeout(500);
    expect((await name()) === "cat", "what was typed into a program named the terminal: " + await name());
    await K("Control+c");
    await p.waitForTimeout(400);
    await p.keyboard.type("echo quiet --password hunter2-again"); await K("Enter");
    await until("the terminal named after the program alone", async () => (await name()) === "echo", 6000).catch(async (e) => { throw new Error(e.message + ": it is called " + await name()); });
    await p.keyboard.type("echo fine-again"); await K("Enter");
    await until("an ordinary command to name it again", async () => (await name()).includes("echo fine-again"), 6000);
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await K("Control+`");
  });

  await check("viewers: pictures, sound, film, PDFs, workbooks and CSV open to be looked at, not as text", async () => {
    const zip = require("fflate");
    const at = (name) => path.join(project, "media", name);
    fs.mkdirSync(path.join(project, "media"), { recursive: true });
    fs.writeFileSync(at("dot.png"), png);
    fs.writeFileSync(at("dot.gif"), Buffer.from("R0lGODlhAgADAIAAAP8AAP///ywAAAAAAgADAAACA4RvBQA7", "base64"));
    // One second of a tone, as a WAV file.
    const rate = 8000, tone = Buffer.alloc(44 + rate);
    tone.write("RIFF", 0); tone.writeUInt32LE(36 + rate, 4); tone.write("WAVEfmt ", 8); tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22);
    tone.writeUInt32LE(rate, 24); tone.writeUInt32LE(rate, 28); tone.writeUInt16LE(1, 32); tone.writeUInt16LE(8, 34); tone.write("data", 36); tone.writeUInt32LE(rate, 40);
    for (let i = 0; i < rate; i++) tone[44 + i] = 128 + Math.round(60 * Math.sin(i / 3));
    fs.writeFileSync(at("tone.wav"), tone);
    fs.writeFileSync(at("paper.pdf"), "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    const cell = (r, v, more = "") => `<c r="${r}"${more}><v>${v}</v></c>`;
    fs.writeFileSync(at("book.xlsx"), zip.zipSync({
      "xl/workbook.xml": zip.strToU8('<workbook><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/><sheet name="Totals" sheetId="2" r:id="rId2"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": zip.strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
      "xl/sharedStrings.xml": zip.strToU8("<sst><si><t>item</t></si><si><t>price</t></si><si><t>tea &amp; &lt;cake&gt;</t></si><si><t>bread</t></si><si><t>jam</t></si></sst>"),
      "xl/worksheets/sheet1.xml": zip.strToU8("<worksheet><sheetData><row r=\"1\">" + cell("A1", 0, ' t="s"') + cell("B1", 1, ' t="s"') + "</row><row r=\"2\">" + cell("A2", 2, ' t="s"') + cell("B2", 12.5) + "</row><row r=\"3\">" + cell("A3", 3, ' t="s"') + cell("B3", 3) + "</row><row r=\"4\">" + cell("A4", 4, ' t="s"') + cell("B4", 40) + "</row></sheetData></worksheet>"),
      "xl/worksheets/sheet2.xml": zip.strToU8("<worksheet><sheetData><row r=\"1\">" + cell("A1", 55.5) + "</row></sheetData></worksheet>"),
    }));
    fs.writeFileSync(at("people.csv"), 'name,age,note\n"Smith, John",42,"said ""hi"""\nAda,36,\n' + Array.from({ length: 2500 }, (_, i) => `Person ${i},${20 + (i % 50)},row`).join("\n") + "\n");
    let film = false;
    try { execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5", "-pix_fmt", "yuv420p", at("clip.mp4")], { stdio: "pipe", timeout: 60000 }); film = fs.existsSync(at("clip.mp4")); } catch {}
    await K("Control+Shift+e");
    await unfold("media");
    await listed("people.csv");
    const viewer = p.locator(".group.focused runes-viewer");
    const foot = async () => (await viewer.locator(".rv-foot").innerText().catch(() => "")).replace(/\s+/g, " ");

    await open("dot.png");
    await until("the picture, with its size", async () => (await foot()).includes("8 × 8"), 8000).catch(async (e) => { throw new Error(e.message + ": " + await viewer.innerText().catch(() => "no viewer")); });
    expect((await viewer.locator("img").evaluate((i) => i.naturalWidth)) === 8 && (await viewer.locator("img").getAttribute("src")).startsWith("runes://view/"), "the picture is not drawn from the shell's address");
    expect((await p.locator(".group.focused .scroller").count()) === 0, "a picture was opened as text as well");
    // A click shows it at its own size, another fits it in again.
    await viewer.locator(".rv-stage").click();
    expect(!(await viewer.locator(".rv-stage").evaluate((s) => s.classList.contains("fit"))), "a click did not show the picture at its own size");
    await viewer.locator(".rv-stage").click();
    // What is looked at is never written: saving and typing do nothing to the file.
    const bytes = fs.readFileSync(at("dot.png"));
    await K("Control+s"); await K("Control+Shift+k"); await p.keyboard.type("x");
    await p.waitForTimeout(300);
    expect(fs.readFileSync(at("dot.png")).equals(bytes), "the picture's file was written to");
    expect(!(await p.locator(".group.focused .tab.on").evaluate((t) => t.classList.contains("dirty"))), "a picture can be edited as if it were text");
    await shot("viewer-image");

    await open("dot.gif");
    await until("the animation, with its size", async () => (await foot()).includes("2 × 3"), 8000);
    await open("tone.wav");
    await until("the sound, with its length", async () => /Sound · .* · 0:01/.test(await foot()), 10000).catch(async (e) => { throw new Error(e.message + ": " + await foot()); });
    expect(await viewer.locator("audio").evaluate((a) => a.controls && a.duration > 0.9 && !a.error), "the sound cannot be played");
    // A player asks for part of a file to move about in it.
    const part = await p.evaluate(async () => { const r = await fetch(document.querySelector(".group.focused audio").src, { headers: { range: "bytes=0-3" } }); return [r.status, r.headers.get("content-range"), await r.text()]; });
    expect(part[0] === 206 && part[1] === "bytes 0-3/8044" && part[2] === "RIFF", "part of a file: " + JSON.stringify(part));
    if (film) {
      await open("clip.mp4");
      await until("the film, with its size and length", async () => /Film · .* · 64 × 48 · 0:01/.test(await foot()), 15000).catch(async (e) => { throw new Error(e.message + ": " + await foot()); });
      await viewer.locator("video").evaluate((v) => { v.muted = true; return v.play(); });
      await until("it to play", async () => viewer.locator("video").evaluate((v) => v.currentTime > 0.1), 8000);
    }
    await open("paper.pdf");
    await until("the PDF in the engine's own viewer", async () => (await viewer.locator("iframe.rv-pdf").count()) === 1 && p.frames().some((f) => f.url().startsWith("runes://view/") || f.url().includes("mhjfbmdgcfjbbpaeojofohoefgiehjai")), 10000);
    await shot("viewer-pdf");

    await open("book.xlsx");
    const table = p.locator(".group.focused runes-table");
    await until("the first sheet as a table", async () => (await table.locator(".rt-row").count()) === 3, 10000).catch(async (e) => { throw new Error(e.message + ": " + await viewer.innerText().catch(() => "")); });
    const cells = () => table.locator(".rt-row").evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll(".rt-c")].map((c) => c.textContent)));
    expect((await table.locator(".rt-h span").allTextContents()).join() === "item,price", "the headings: " + (await table.locator(".rt-h span").allTextContents()).join());
    expect(JSON.stringify(await cells()) === JSON.stringify([["tea & <cake>", "12.5"], ["bread", "3"], ["jam", "40"]]), "the cells: " + JSON.stringify(await cells()));
    // A heading sorts by its column: numbers as numbers, then the other way, then as it was.
    await table.locator(".rt-h", { hasText: "price" }).click();
    expect((await cells()).map((r) => r[1]).join() === "3,12.5,40", "sorted up: " + JSON.stringify(await cells()));
    await table.locator(".rt-h", { hasText: "price" }).click();
    expect((await cells()).map((r) => r[1]).join() === "40,12.5,3", "sorted down: " + JSON.stringify(await cells()));
    await table.locator(".rt-h", { hasText: "price" }).click();
    expect((await cells()).map((r) => r[0]).join() === "tea & <cake>,bread,jam", "back as it was: " + JSON.stringify(await cells()));
    await table.locator(".rt-tab", { hasText: "Totals" }).click();
    await until("the second sheet", async () => (await table.locator(".rt-note").innerText()).includes("0 rows × 1 column"), 4000);
    expect((await table.locator(".rt-h span").allTextContents()).join() === "55.5", "the second sheet: " + (await table.locator(".rt-h span").allTextContents()).join());
    await shot("viewer-xlsx");

    // CSV is a table that is also text: looked at as one, edited as the other, and back.
    await open("people.csv");
    await until("the table of the CSV", async () => (await table.locator(".rt-note").innerText().catch(() => "")).includes("2,502 rows × 3 columns · comma separated"), 8000).catch(async (e) => { throw new Error(e.message + ": " + await table.innerText().catch(() => "no table")); });
    expect(JSON.stringify((await cells())[0]) === JSON.stringify(["Smith, John", "42", 'said "hi"']), "the first row: " + JSON.stringify((await cells())[0]));
    expect((await table.locator(".rt-row").count()) < 120, "every row of a long table is in the page: " + await table.locator(".rt-row").count());
    await table.locator(".rt-scroll").evaluate((s) => { s.scrollTop = s.scrollHeight; });
    await until("the last rows when scrolled to", async () => (await cells()).some((r) => r[0] === "Person 2499"), 4000);
    await shot("viewer-csv");
    await table.locator(".rt-raw").click();
    await until("the text of it", async () => (await lines())[0] === "name,age,note", 4000);
    await inEditor(3);
    await K("End"); await p.keyboard.type("new");
    await save();
    expect(fs.readFileSync(at("people.csv"), "utf8").split("\n")[2] === "Ada,36,new", "the CSV was not edited as text: " + fs.readFileSync(at("people.csv"), "utf8").split("\n")[2]);
    await p.locator(".group.focused .canvas-raw .link", { hasText: "Show the table" }).click();
    await until("the table again, with the change", async () => (await cells().catch(() => []))[1]?.[2] === "new", 4000);

    // The shell serves only what it gave an address for: a file of the open folder, of a kind that is looked at.
    const refused = await p.evaluate(async (root) => {
      const ask = (file) => window.runesHost.fileView(file).then((v) => "allowed " + v.url, (e) => String(e.message).replace(/^.*?: /, ""));
      const get = (url) => fetch(url).then((r) => r.status, () => "blocked");
      const good = await window.runesHost.fileView(root + "/media/dot.png");
      return {
        outside: await ask("/etc/passwd"), climbing: await ask(root + "/media/../../../etc/passwd"), text: await ask(root + "/README.md"), page: await ask(root + "/media/x.html"), missing: await ask(root + "/media/none.png"),
        guessed: await get(good.url.replace(/view\/[0-9a-f]+/, "view/" + "0".repeat(36))), other: await get(good.url.replace("dot.png", "../../README.md")), good: await get(good.url),
        type: (await fetch(good.url)).headers.get("content-type"), policy: (await fetch(good.url)).headers.get("content-security-policy") ?? "", hidden: !good.url.includes(root),
      };
    }, project);
    expect(/outside/.test(refused.outside) && /outside/.test(refused.climbing), "a file outside the folder: " + JSON.stringify(refused));
    expect(/no viewer/.test(refused.text) && /no viewer/.test(refused.page) && !/allowed/.test(refused.missing), "what is not looked at, or not there: " + JSON.stringify(refused));
    expect(refused.guessed === 404 && refused.good === 200 && refused.type === "image/png" && refused.hidden, "addresses: " + JSON.stringify(refused));
    expect(refused.other === 200 || refused.other === 404, "an address followed out of its file: " + JSON.stringify(refused));
    expect(/default-src 'none'/.test(refused.policy) && /sandbox/.test(refused.policy), "what is served may do things: " + refused.policy);
    // A page dressed as a picture is shown as a broken picture, and nothing in it runs.
    fs.writeFileSync(at("fake.png"), "<script>window.parent.postMessage('ran','*')</script><h1>not a picture</h1>");
    await listed("fake.png");
    await open("fake.png");
    await until("it to say the picture cannot be shown", async () => (await viewer.innerText().catch(() => "")).includes("could not be shown"), 8000);
    for (const tab of ["dot.png", "dot.gif", "tone.wav", "clip.mp4", "paper.pdf", "book.xlsx", "people.csv", "fake.png"]) { const t = p.locator(".tab", { hasText: tab }).first(); if (await t.count()) await t.locator(".tab-close").click(); }
    fs.rmSync(path.join(project, "media"), { recursive: true });
  });

  await check("canvas: lines stop sticking to shapes when that is turned off, and Alt holds it off once", async () => {
    const file = path.join(project, "stick.rux");
    fs.writeFileSync(file, JSON.stringify({ rune: "canvas", version: 1, elements: [{ id: "box", type: "rect", x: 100, y: -40, w: 120, h: 80, sketch: false }] }));
    await listed("stick.rux");
    await open("stick.rux");
    await p.waitForSelector(".group.focused runes-canvas .rc-el");
    const read = () => JSON.parse(fs.readFileSync(file, "utf8")).elements;
    const canvas = p.locator(".group.focused runes-canvas");
    // Draws from one place to another, each given in the drawing's own coordinates.
    const place = (x, y) => canvas.evaluate((c, [x, y]) => { const r = c.board.getBoundingClientRect(); return [r.left + c.view.x + x * c.view.k, r.top + c.view.y + y * c.view.k]; }, [x, y]);
    const draw = async (x1, y1, x2, y2, keys = []) => {
      const [ax, ay] = await place(x1, y1), [bx, by] = await place(x2, y2);
      await p.mouse.move(ax, ay); await p.mouse.down();
      for (const k of keys) await p.keyboard.down(k);
      await p.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 4 }); await p.mouse.move(bx, by, { steps: 4 });
      await p.mouse.up();
      for (const k of keys) await p.keyboard.up(k);
      await settle();
    };
    await canvas.focus();
    const magnet = canvas.locator('.rc-foot .rc-button[aria-label^="Lines and arrows stick"]');
    expect((await magnet.getAttribute("aria-pressed")) === "true", "lines do not stick to begin with");
    // (From the right: the panel of what a line looks like stands over the left of the board.)
    await K("l");
    await draw(400, 0, 160, 0);
    await store();
    expect(read().find((e) => e.type === "line")?.to === "box", "a line drawn onto a shape is not tied to it: " + JSON.stringify(read()));
    await K("Control+z");
    // Turned off: the same line goes exactly where it is put.
    await magnet.click();
    expect((await magnet.getAttribute("aria-pressed")) === "false", "the button does not say sticking is off");
    await K("l");
    await draw(400, 0, 160, 0);
    await store();
    const free = read().find((e) => e.type === "line");
    expect(free && !free.to && !free.from && Math.abs(free.x + free.w - 160) < 3, "with sticking off the line was moved or tied: " + JSON.stringify(free));
    // The choice outlives the board: it is the person's, not the drawing's.
    expect((await p.evaluate(() => localStorage.getItem("runes-canvas"))).includes('"sticks":false'), "the choice is not kept");
    expect(!fs.readFileSync(file, "utf8").includes("sticks"), "the choice was written into the drawing");
    await K("Control+z");
    await K("m");
    expect((await magnet.getAttribute("aria-pressed")) === "true", "M did not turn sticking on again");
    // On again, with Alt held: not this once.
    await K("l");
    await draw(400, 20, 160, 20, ["Alt"]);
    await store();
    const once = read().find((e) => e.type === "line");
    expect(once && !once.to, "Alt did not hold the sticking off: " + JSON.stringify(once));
    await shot("canvas-sticking");
    fs.rmSync(file);
  });

  await check("canvas: writing is made larger and smaller, from the panel and by pulling its corner", async () => {
    const file = path.join(project, "words.rux");
    fs.writeFileSync(file, JSON.stringify({ rune: "canvas", version: 1, elements: [{ id: "w", type: "text", x: -60, y: -20, text: "Hello", size: 20 }] }));
    await listed("words.rux");
    await open("words.rux");
    await p.waitForSelector(".group.focused runes-canvas .rc-el");
    const size = () => JSON.parse(fs.readFileSync(file, "utf8")).elements[0].size ?? 20;
    const canvas = p.locator(".group.focused runes-canvas");
    await canvas.focus();
    await K("Control+a");
    await p.waitForSelector(".group.focused .rc-props .rc-size");
    expect((await canvas.locator(".rc-props .rc-size").first().innerText()) === "20", "the panel does not say the size");
    await canvas.locator('.rc-props .rc-button[aria-label="Larger text"]').click();
    await canvas.locator('.rc-props .rc-button[aria-label="Larger text"]').click();
    await store();
    expect(size() === 26, "two steps larger from 20 is " + size());
    await canvas.locator('.rc-props .rc-button[aria-label="Smaller text"]').click();
    await store();
    expect(size() === 23, "a step smaller is " + size());
    // The named sizes are still there, and a size between them is none of them.
    expect((await canvas.locator(".rc-props .rc-choice.on", { hasText: /^(S|M|L|XL)$/ }).count()) === 0, "a size between the named ones is shown as one of them");
    await canvas.locator('.rc-props .rc-choice[aria-label="Large text"]').click();
    await store();
    expect(size() === 28, "Large is " + size());
    // Its corner, pulled out: writing only has corners, and keeps its shape.
    expect((await canvas.locator(".rc-handle").count()) === 4, "writing has " + (await canvas.locator(".rc-handle").count()) + " handles, not its four corners");
    const corner = await canvas.locator('.rc-handle[data-handle="se"]').boundingBox(), frame = await canvas.locator(".rc-frame").boundingBox();
    await p.mouse.move(corner.x + 4, corner.y + 4); await p.mouse.down();
    await p.mouse.move(corner.x + 4 + frame.width / 2, corner.y + 4 + frame.height / 2, { steps: 5 });
    await p.mouse.move(corner.x + 4 + frame.width, corner.y + 4 + frame.height, { steps: 5 });
    await p.mouse.up(); await settle();
    await store();
    expect(size() > 45 && size() < 76, "pulled to about twice its size from 28 it is " + size());
    const drawnAt = await canvas.locator(".rc-el text").first().getAttribute("font-size");
    expect(Number(drawnAt) === size(), "it is drawn at " + drawnAt + " and saved at " + size());
    await K("Control+z");
    await store();
    expect(size() === 28, "undo did not put the size back: " + size());
    await shot("canvas-text-size");
    fs.rmSync(file);
  });

  await check("canvas: things are grouped into one and taken apart again, from the panel of what is chosen", async () => {
    const file = path.join(project, "group.rux");
    const shape = (id, x) => ({ id, type: "rect", x, y: -30, w: 80, h: 60, sketch: false });
    fs.writeFileSync(file, JSON.stringify({ rune: "canvas", version: 1, elements: [shape("a", 0), shape("b", 140), shape("c", 320), { id: "far", type: "text", x: -700, y: 0, text: "." }] }));
    await listed("group.rux");
    await open("group.rux");
    await p.waitForSelector(".group.focused runes-canvas .rc-el");
    // (The writing far to the left is only there to keep the shapes clear of the panel.)
    const read = () => JSON.parse(fs.readFileSync(file, "utf8")).elements.filter((e) => e.type === "rect");
    const canvas = p.locator(".group.focused runes-canvas");
    const chosen = () => canvas.evaluate((c) => [...c.selected].sort());
    // On its right edge: a shape with no fill is taken hold of by its outline, and the panel of what is chosen stands over the left of the board.
    const at = async (id) => canvas.evaluate((c, id) => { const e = c.elements.find((k) => k.id === id), r = c.board.getBoundingClientRect(); return [r.left + c.view.x + (e.x + e.w) * c.view.k, r.top + c.view.y + (e.y + e.h / 2) * c.view.k]; }, id);
    const click = async (id, keys = []) => { const [x, y] = await at(id); for (const k of keys) await p.keyboard.down(k); await p.mouse.click(x, y); for (const k of keys) await p.keyboard.up(k); await settle(); };
    await canvas.focus();
    // One thing chosen: nothing to group. Two: the panel offers it, and the tools do not.
    await click("a");
    expect((await canvas.locator('.rc-props .rc-row[aria-label="Group"]').count()) === 0, "one thing chosen, and grouping is offered");
    await click("b", ["Shift"]);
    expect(JSON.stringify(await chosen()) === '["a","b"]', "two are not chosen: " + JSON.stringify(await chosen()));
    const make = canvas.locator('.rc-props .rc-row[aria-label="Group"] .rc-button').nth(0), apart = canvas.locator('.rc-props .rc-row[aria-label="Group"] .rc-button').nth(1);
    expect((await make.count()) === 1 && (await make.isEnabled()) && !(await apart.isEnabled()), "the panel does not offer to group two things");
    expect((await canvas.locator('.rc-tools [aria-label*="roup"], .rc-foot [aria-label*="roup"]').count()) === 0, "grouping is among the tools, not with what is chosen");
    const toolsBefore = await canvas.locator(".rc-tools").innerHTML();
    await make.click();
    await store();
    const made = read();
    expect(made[0].groups?.length === 1 && made[0].groups[0] === made[1].groups?.[0] && !made[2].groups, "the group in the file: " + JSON.stringify(made.map((e) => e.groups)));
    expect((await canvas.locator(".rc-tools").innerHTML()) === toolsBefore, "grouping changed the tools");
    expect((await make.isEnabled()) === false && (await apart.isEnabled()) && (await canvas.locator(".rc-props").innerText()).includes("2 in the group"), "the panel does not show that this is a group: " + await canvas.locator(".rc-props").innerText());
    await shot("canvas-group");
    // A click on either chooses both; a drag moves both; Alt chooses the one.
    await K("Escape");
    await click("b");
    expect(JSON.stringify(await chosen()) === '["a","b"]', "a click on one of a group chose " + JSON.stringify(await chosen()));
    // (By its top edge: the middle of its right edge is where the group's own handle is.)
    const [bx, by] = await canvas.evaluate((c) => { const e = c.elements.find((k) => k.id === "b"), r = c.board.getBoundingClientRect(); return [r.left + c.view.x + (e.x + e.w * 0.3) * c.view.k, r.top + c.view.y + e.y * c.view.k]; });
    await p.mouse.move(bx, by); await p.mouse.down(); await p.mouse.move(bx, by + 40, { steps: 4 }); await p.mouse.move(bx, by + 80, { steps: 4 }); await p.mouse.up(); await settle();
    await store();
    expect(read()[0].y > 30 && read()[1].y > 30 && read()[2].y === -30, "the group did not move as one: " + JSON.stringify(read().map((e) => e.y)));
    await click("a", ["Alt"]);
    expect(JSON.stringify(await chosen()) === '["a"]', "Alt and a click chose " + JSON.stringify(await chosen()));
    // The group and a third thing, grouped: then the copy of it all is a group of its own.
    await K("Escape");
    await click("c"); await click("a", ["Shift"]);
    expect(JSON.stringify(await chosen()) === '["a","b","c"]', "the group and one more are not chosen: " + JSON.stringify(await chosen()));
    await K("Control+g");
    await store();
    expect(read().every((e) => e.groups?.length >= 1) && read()[0].groups.length === 2 && read()[2].groups.length === 1 && read()[0].groups[1] === read()[2].groups[0], "a group in a group: " + JSON.stringify(read().map((e) => e.groups)));
    await K("Control+d");
    await store();
    const six = read();
    expect(six.length === 6 && six[3].groups.length === 2 && six[3].groups[1] === six[5].groups[0] && six[3].groups[1] !== six[0].groups[1] && six[3].groups[0] !== six[0].groups[0], "the copy is part of the group it was copied from: " + JSON.stringify(six.map((e) => e.groups)));
    await K("Control+z");
    // Taken apart with the keys: the inner group is itself again. And once more from the panel: nothing is grouped.
    await K("Escape"); await click("c");
    await K("Control+Shift+g");
    await store();
    expect(JSON.stringify(read().map((e) => e.groups?.length ?? 0)) === "[1,1,0]", "taken apart once: " + JSON.stringify(read().map((e) => e.groups)));
    await K("Escape"); await click("a");
    await canvas.locator('.rc-props .rc-row[aria-label="Group"] .rc-button').nth(1).click();
    await store();
    expect(!fs.readFileSync(file, "utf8").includes("groups"), "taken apart, the file still speaks of groups: " + fs.readFileSync(file, "utf8"));
    await K("Escape"); await click("b");
    expect(JSON.stringify(await chosen()) === '["b"]', "its parts are not themselves again: " + JSON.stringify(await chosen()));
    // Undo brings the group back.
    await K("Control+z");
    await K("Escape"); await click("b");
    expect(JSON.stringify(await chosen()) === '["a","b"]', "undo did not bring the group back: " + JSON.stringify(await chosen()));
    await store();
    fs.rmSync(file);
  });

  await check("the logo is still when pointed at", async () => {
    const hovered = await p.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).filter((r) => r.selectorText && /(logo|mark)[^,]*:hover/.test(r.selectorText) && /animation/.test(r.cssText)).map((r) => r.selectorText));
    expect(hovered.length === 0, "pointing at the logo animates it: " + hovered.join());
    const passive = await p.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).some((r) => r.selectorText === ".rune-light" && /animation/.test(r.cssText)));
    expect(passive, "the logo's own slow light is gone too");
  });

  // The Python extension is 7 MB and not kept in this repository. Download it from Open VSX
  // (open-vsx.org/extension/ms-python/python) and name the file in RUNES_PYTHON_VSIX to run this.
  const pythonVsix = process.env.RUNES_PYTHON_VSIX;
  if (pythonVsix && fs.existsSync(pythonVsix)) await check("the Python extension: it starts, and its language server completes, explains and finds definitions", async () => {
    fs.writeFileSync(path.join(project, "tool.py"), 'import os\n\n\ndef greet(name: str) -> str:\n    """Say hello to someone."""\n    return "hello " + name\n\n\nprint(greet("x"))\n');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await K("Control+Shift+x");
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".side header .button", { hasText: "Install" }).click()]);
    await chooser.setFiles(pythonVsix);
    await until("the install", async () => (await p.locator(".ext b").allTextContents()).includes("Python"), 30000);
    if (process.env.RUNES_STEPS) console.log("  .. step 1");
    await open("tool.py");
    await commands(); await p.keyboard.type("Show Running Extensions"); await p.waitForTimeout(150); await K("Enter");
    const python = p.locator(".running-item", { hasText: "ms-python.python" });
    await until("the Python extension to have started", async () => /started in \d+ ms/.test(await python.innerText().catch(() => "")), 120000);
    if (process.env.RUNES_STEPS) console.log("  .. step 2");
    await python.click();
    await until("its language server to be starting", async () => (await p.locator(".running-log").innerText()).includes("Jedi"), 120000);
    if (process.env.RUNES_STEPS) console.log("  .. step 3");
    expect(!(await p.locator(".running-error").count()), "it reports an error: " + (await p.locator(".running-error").innerText().catch(() => "")));
    await shot("python-running");
    await open("tool.py");
    await K("Control+End");
    await p.keyboard.type("os.pa");
    await until("completion from Jedi", async () => (await p.locator(".suggest .option b").allTextContents()).includes("path"), 120000, async () => { await K("Escape"); await K("Backspace"); await p.keyboard.type("a"); });
    if (process.env.RUNES_STEPS) console.log("  .. step 4");
    await shot("python-completion");
    await K("Escape");
    for (let i = 0; i < 5; i++) await K("Backspace");
    const call = await line(9).boundingBox();
    await p.mouse.move(call.x + 60, call.y + 8);
    await until("a hover from Jedi", async () => (await p.locator(".hover").innerText().catch(() => "")).includes("Say hello to someone"), 90000, async () => { await p.mouse.move(call.x + 20, call.y + 30); await p.mouse.move(call.x + 60, call.y + 8); });
    if (process.env.RUNES_STEPS) console.log("  .. step 5");
    // Ctrl and a click on the call goes to the function; on the import, into Python's own library.
    await line(9).click({ position: { x: 60, y: 8 }, modifiers: ["Control"] });
    await until("the definition in this file", async () => (await status()).includes("Ln 4"), 60000);
    if (process.env.RUNES_STEPS) console.log("  .. step 6");
    await line(1).click({ position: { x: 62, y: 8 }, modifiers: ["Control"] });
    await until("the library's own file", async () => (await p.locator(".group.focused .tab.on").textContent()).includes("os.py"), 60000);
    if (process.env.RUNES_STEPS) console.log("  .. step 7");
    expect(!(await p.locator(".group.focused .tab.on").evaluate((t) => t.classList.contains("dirty"))), "a library file that was only opened counts as changed");
    await K("Control+w");
    // What a call expects, from Jedi, as its arguments are written.
    await open("tool.py");
    await K("Control+End");
    const asItWas = JSON.stringify(await lines());
    await p.keyboard.type("greet(");
    const label = async () => (await p.locator(".group.focused .signature-label").innerText().catch(() => "")).replace(/\s+/g, " ");
    await until("what greet expects", async () => (await label()).includes("greet(name: str"), 90000, async () => { await K("Backspace"); await p.keyboard.type("("); });
    expect((await p.locator(".group.focused .signature-arg").innerText()).includes("name: str"), "the argument in hand is not marked: " + await label());
    expect((await p.locator(".group.focused .signature").innerText()).includes("Say hello to someone"), "what Jedi says of the function is not shown");
    await shot("python-signature");
    await K("Escape");
    for (let i = 0; i < 12 && JSON.stringify(await lines()) !== asItWas; i++) await K("Control+z");
    expect(JSON.stringify(await lines()) === asItWas, "the file was not put back as it was");
    if (process.env.RUNES_STEPS) console.log("  .. step 7b");
    // Enter, by the rules the extension gives as it runs: deeper after a colon, back after pass.
    await K("Control+End");
    await p.keyboard.type("def f(x):"); await K("Enter"); await p.keyboard.type("pass"); await K("Enter"); await p.keyboard.type("z = 1");
    await K("Control+s");
    await until("the file saved", async () => fs.readFileSync(path.join(project, "tool.py"), "utf8").endsWith("def f(x):\n    pass\nz = 1"), 5000);
    if (process.env.RUNES_STEPS) console.log("  .. step 8");
    // Uninstall, so that what follows starts as before.
    await K("Control+Shift+x");
    await p.locator(".ext", { hasText: "ms-python" }).first().click();
    await p.locator('.ext-actions .button[aria-label^="Uninstall"]').click();
    fs.rmSync(path.join(project, "tool.py"));
    await K("Control+Shift+e");
  });

  await check("reload: Runes starts afresh in the same window, with the same files open", async () => {
    await open("shop.bea");
    await open("README.md");
    // Unsaved work is not thrown away by a reload: it says so, and stays.
    await p.keyboard.type("x");
    await K("Control+Alt+r");
    await until("the refusal", async () => ((await p.locator(".toast").textContent().catch(() => "")) ?? "").includes("not saved"), 4000);
    await K("Control+z");
    await save();
    // Whatever the checks before this one left unsaved is saved too.
    for (let left = await p.locator(".tab.dirty").count(); left > 0; left--) {
      await p.locator(".tab.dirty").first().click();
      await K("Control+s");
      await p.waitForTimeout(300);
    }
    await open("README.md");
    await p.evaluate(() => { window.__before_reload = true; });
    await K("Control+Alt+r");
    await until("a fresh page", async () => p.evaluate(() => !window.__before_reload && !!document.querySelector(".runes.ready")).catch(() => false), 20000);
    await until("the files open again", async () => { const tabs = (await p.locator(".group.focused .tab").allTextContents()).join(); return tabs.includes("shop.bea") && tabs.includes("README.md"); }, 10000);
    expect((await p.locator(".tree.files .node").count()) > 0, "the folder is not open after the reload");
    // The extension host started afresh too, and still answers.
    await open("shop.bea");
    await line(8).click({ position: { x: 150, y: 8 } });
    await K("F12");
    await until("the language server to answer after the reload", async () => (await status()).includes("Ln 3"), 30000, async () => { await line(8).click({ position: { x: 150, y: 8 } }); await K("F12"); });
  });

  await check("security: Markdown that no rule can place is shown as it is, and never stalls the window", async () => {
    // A list item with a line separator in it once sent the renderer round and round for ever.
    fs.writeFileSync(path.join(project, "odd.md"), "# Odd\n\n- one\n- two\u2028still two\n\n1. first\u2028more\n\n#\u2028x\n\nafter\n");
    await open("odd.md");
    await K("Control+Shift+v");
    await p.waitForSelector(".markdown-page .markdown h1", { timeout: 8000 });
    const shown = await Promise.race([p.locator(".markdown-page .markdown").innerText(), new Promise((r) => setTimeout(() => r(null), 6000))]);
    expect(shown !== null, "the window stopped answering");
    expect(shown.includes("after") && shown.includes("still two"), "the text was lost: " + JSON.stringify(shown));
    await K("Control+w");
    fs.rmSync(path.join(project, "odd.md"));
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
    // What was taken out is gone from the bridge too: no update check, no opening of addresses unasked, no committing.
    const left = await p.evaluate(() => ["openExternal", "checkUpdate", "gitCommit", "gitSwitch", "gitConfigSet"].filter((name) => name in window.runesHost));
    expect(left.length === 0, "still on the bridge: " + left.join());
  });

  await check("no errors were thrown in the page", async () => {
    expect(errors.length === 0, errors.slice(0, 5).join("\n"));
  });

  await app.close();
  registry.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("The test run itself failed:", e); process.exit(1); });
