// Version control, by running the `git` on the PATH. No Electron in here. Every call passes
// arguments as a list (never through a shell) and checks what it was given.
"use strict";
const { execFile } = require("node:child_process");
const path = require("node:path");

const HASH = /^[0-9a-f]{7,40}$/;
const SEP = "\x1f", END = "\x1e";

// Git runs on this machine, or on the one an SSH session is connected to: `over` swaps it.
let runner = local, P = path;
const git = (root, args, input) => runner(root, args, input);
/** Run git through a connected machine (see ssh.cjs), or pass nothing to come back to this one. */
function over(remote) {
  runner = remote ? (root, args, input) => remote.git(root, args, input) : local;
  P = remote ? path.posix : path;
}

function local(root, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim().split("\n")[0])) : resolve(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Paths from the window: relative, inside the folder, and never an option. */
function inside(root, files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 5000) throw new Error("Bad request");
  return files.map((file) => {
    if (typeof file !== "string" || !file || file.startsWith("-")) throw new Error("Bad request");
    const full = P.resolve(root, file);
    if (full !== root && !full.startsWith(root + P.sep)) throw new Error("That file is outside the folder");
    return P.relative(root, full);
  });
}

/** The branch and what has changed: { repo, branch, ahead, behind, files: [[path, staged, unstaged]] }. */
async function status(root) {
  let out;
  try { out = await git(root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]); }
  catch { return { repo: false, branch: "", ahead: 0, behind: 0, files: [] }; }
  const parts = out.split("\0");
  const head = parts.shift() ?? "";
  // "## main...origin/main [ahead 1]", "## main", "## No commits yet on main", "## HEAD (no branch)"
  const branch = head.replace(/^## /, "").replace(/^No commits yet on /, "").split("...")[0].split(" [")[0].trim();
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push([entry.slice(3), code[0] === "?" ? " " : code[0], code[1]]);
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return {
    repo: true, branch: head.includes("HEAD (no branch)") ? "detached" : branch,
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
    files: files.slice(0, 3000),
  };
}

/** Commits of every branch, newest first: [hash, parents, author, unix time, refs, subject]. */
async function log(root, limit = 600, until = "") {
  const format = ["%H", "%P", "%an", "%at", "%D", "%s"].join(SEP) + END;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("Bad request");
  let out;
  // `until` is a day: the history as it stood at the end of it, for going far back.
  try { out = await git(root, ["log", "--all", "--date-order", `--max-count=${Math.max(1, Math.min(5000, limit | 0))}`, ...(until ? [`--until=${until} 23:59:59`] : []), `--format=${format}`]); }
  catch { return []; }
  return out.split(END).map((entry) => entry.replace(/^\n/, "")).filter(Boolean).map((entry) => {
    const [hash, parents, author, time, refs, subject] = entry.split(SEP);
    return [hash, parents ? parents.split(" ") : [], author ?? "", Number(time) || 0,
      (refs ?? "").split(", ").filter(Boolean).map((r) => r.replace(/^HEAD -> /, "")), subject ?? ""];
  });
}

/** Every file there was at a branch, tag or commit, as paths from the top of the repository. */
async function tree(root, at) {
  try { return (await git(root, ["ls-tree", "-r", "--name-only", "-z", ref(at)])).split("\0").filter(Boolean).slice(0, 50000); }
  catch { return []; }
}

/**
 * One file's history, for travelling through it: every commit that changed it, newest
 * first, as [hash, author, time, subject]; and `at`, the commit among them whose version
 * of the file is the one seen from the branch, tag or commit `from`.
 */
async function history(root, name, from) {
  const [relative] = inside(root, [name]);
  const file = relative.split(P.sep).join("/");
  const format = ["%H", "%an", "%at", "%s"].join(SEP) + END;
  const read = async (args) => {
    try { return await git(root, ["log", "--date-order", "--max-count=1000", `--format=${format}`, ...args, "--", file]); } catch { return ""; }
  };
  const commits = (await read(["--all"])).split(END).map((e) => e.replace(/^\n/, "")).filter(Boolean).map((e) => {
    const [hash, author, time, subject] = e.split(SEP);
    return [hash, author ?? "", Number(time) || 0, subject ?? ""];
  });
  let at = "";
  try { at = (await git(root, ["log", "-1", "--format=%H", ref(from || "HEAD"), "--", file])).trim(); } catch {}
  return { commits, at: at || commits[0]?.[0] || "" };
}

/** How many commits were made on each day, over the whole history: [[day, count]], oldest first. */
async function days(root) {
  let out;
  try { out = await git(root, ["log", "--all", "--format=%cd", "--date=format-local:%Y-%m-%d"]); } catch { return []; }
  const counts = new Map();
  for (const day of out.split("\n")) if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
  return [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** What one commit changed, as text. */
async function show(root, hash) {
  if (!HASH.test(String(hash))) throw new Error("Bad request");
  return (await git(root, ["show", "--stat=100", "--format=%H%n%an <%ae>%n%ad%n%n%B", "--date=format:%Y-%m-%d %H:%M", hash])).slice(0, 20000);
}

/** A branch, tag or commit as the window names it: never an option, never a range. */
const REF = /^[\w][\w./@^~{}-]{0,199}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function ref(name) {
  if (typeof name !== "string" || !REF.test(name) || name.includes("..")) throw new Error("That is not a branch, tag or commit: " + String(name).slice(0, 60));
  return name;
}

/** A file as it was at a branch, tag or commit. null when it was not there, or there is no repository. */
async function file(root, at, name) {
  const [relative] = inside(root, [name]);
  try { return await git(root, ["show", `${ref(at)}:${relative.split(P.sep).join("/")}`]); }
  catch { return null; }
}

/**
 * The files that differ between two points: [[state, path]]. `to` may be "" for the files as
 * they are on disk. `from` may be "<commit>^" for a commit's parent; a first commit, which
 * has none, is compared with the empty tree.
 */
async function changed(root, from, to) {
  let base = ref(from);
  if (base.endsWith("^")) {
    try { await git(root, ["rev-parse", "--verify", "-q", base + "^{commit}"]); } catch { base = EMPTY_TREE; }
  }
  const args = ["diff", "--name-status", "--no-renames", base];
  if (to) args.push(ref(to));
  const out = await git(root, [...args, "--"]);
  const files = out.split("\n").filter(Boolean).map((line) => { const [state, ...rest] = line.split("\t"); return [state[0], rest.join("\t")]; });
  if (!to) {
    // Files git does not know yet are changes too.
    const fresh = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const name of fresh.split("\0").filter(Boolean)) files.push(["A", name]);
  }
  return { base, files: files.slice(0, 5000) };
}

/** Branches, remote branches and tags, newest first: [kind, name]. */
async function refs(root) {
  try {
    return (await git(root, ["for-each-ref", "--format=%(refname)", "--sort=-committerdate", "refs/heads", "refs/remotes", "refs/tags"]))
      .split("\n").filter(Boolean).slice(0, 400).map((name) =>
        name.startsWith("refs/heads/") ? ["branch", name.slice(11)]
          : name.startsWith("refs/remotes/") ? ["remote", name.slice(13)]
          : ["tag", name.slice(10)]);
  } catch { return []; }
}

/**
 * Moves the working tree to another branch. A remote branch is followed by a local one of
 * the same name; a tag or commit is checked out on its own, detached. Git refuses, and
 * says why, when files that are changed here would be overwritten.
 */
async function switchTo(root, kind, name) {
  ref(name);
  if (kind === "branch") return void (await git(root, ["switch", "--no-guess", name]));
  if (kind === "remote") {
    const local = name.slice(name.indexOf("/") + 1);
    ref(local);
    const have = await git(root, ["rev-parse", "--verify", "--quiet", "refs/heads/" + local]).then(() => true, () => false);
    return void (await git(root, have ? ["switch", "--no-guess", local] : ["switch", "--track", "-c", local, "refs/remotes/" + name]));
  }
  await git(root, ["switch", "--detach", name]);
}

const stage = (root, files) => git(root, ["add", "--", ...inside(root, files)]);
const unstage = (root, files) => git(root, ["reset", "-q", "HEAD", "--", ...inside(root, files)]).catch(() => git(root, ["rm", "-q", "--cached", "--", ...inside(root, files)]));
async function commit(root, message) {
  if (typeof message !== "string" || !message.trim() || message.length > 20000) throw new Error("A commit needs a message");
  // The message goes in on standard input, so nothing in it can be read as an option.
  await git(root, ["commit", "-q", "-F", "-"], message);
}

module.exports = { over, status, log, days, tree, history, show, stage, unstage, commit, file, changed, refs, switchTo, EMPTY_TREE };
