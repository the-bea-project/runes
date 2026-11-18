// Deleting that can be taken back. What the explorer deletes is not thrown in the system's
// trash at once: it is held aside, where Ctrl+Z can still put it back exactly as it was.
// It goes to the trash, from its own place and so with its own place written on it, when
// enough has been deleted after it, when the folder is left, and when Runes closes.
// No Electron in here, so it can be tested with plain Node.
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

const exists = (file) => fs.lstat(file).then(() => true, () => false);

/** Moves a file or folder, onto another disk too. Never over something that is there. */
async function move(from, to) {
  if (await exists(to)) throw new Error(path.basename(to) + " already exists");
  await fs.mkdir(path.dirname(to), { recursive: true });
  try { await fs.rename(from, to); }
  catch (e) {
    if (e.code !== "EXDEV") throw e;
    // Links stay links, pointing where they pointed: a copy must not follow one out of the folder.
    await fs.cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/** Whether a file or folder is small enough to be copied in a moment: at most `bytes` in at most `files` files. */
async function small(file, bytes, files) {
  let size = 0, count = 0;
  const visit = async (at) => {
    const stat = await fs.lstat(at);
    count += 1; size += stat.isDirectory() ? 0 : stat.size;
    if (size > bytes || count > files) return false;
    if (!stat.isDirectory()) return true;
    for (const name of await fs.readdir(at)) if (!(await visit(path.join(at, name)))) return false;
    return true;
  };
  try { return await visit(file); } catch { return false; }
}

/**
 * `dir` is where things are held (Runes' own, in its data folder); `trash(file)` throws a
 * file in the system's trash; `limit` is how many deletions can be taken back. Holding is a
 * rename, which takes no time. Where that cannot be (the folder is on another disk than
 * Runes' data), what is small is copied across, and what is large goes straight to the
 * trash: copying it would take as long as it is large, and the trash can still give it back.
 */
function create({ dir, trash, limit = 20, rename = fs.rename, mostCopied = 64 * 1024 * 1024, mostFiles = 2000 }) {
  let entries = [], next = 0, busy = Promise.resolve();
  // One thing at a time: a deletion must not be settled while it is being taken back.
  const queued = (work) => { const run = busy.then(work, work); busy = run.catch(() => {}); return run; };

  /** Puts what was held in the trash. From its own place when that is free, so the trash can put it back there. */
  async function settle(entry) {
    for (const item of entry.items) {
      if (!(await exists(item.held))) continue;
      let from = item.held;
      if (!(await exists(item.from)) && (await exists(path.dirname(item.from)))) {
        try { await move(item.held, item.from); from = item.from; } catch {}
      }
      // No trash on this system: it stays held, and is tried again when Runes next starts.
      try { await trash(from); }
      catch { if (from !== item.held) await move(from, item.held).catch(() => {}); }
    }
    await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(entry.dir).catch(() => {});
  }

  return {
    /** Takes files and folders out of `root`. Resolves to those that went; throws if none could. */
    hold: (files, root) => queued(async () => {
      const entry = { root, dir: path.join(dir, String(Date.now()) + "-" + next++), items: [] };
      // What went straight to the trash: gone, but not to be had back from here.
      const direct = [];
      let problem = null;
      for (const [i, from] of files.entries()) {
        const held = path.join(entry.dir, String(i), path.basename(from));
        try {
          await fs.mkdir(path.dirname(held), { recursive: true });
          try { await rename(from, held); entry.items.push({ from, held }); }
          catch (e) {
            if (e.code !== "EXDEV") throw e;
            if (await small(from, mostCopied, mostFiles)) { await move(from, held); entry.items.push({ from, held }); }
            else { await trash(from); direct.push(from); }
          }
        } catch (e) { problem ??= e; }
      }
      if (!entry.items.length) {
        await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
        if (!direct.length) throw problem ?? new Error("Nothing was deleted");
        return direct;
      }
      entries.push(entry);
      while (entries.length > limit) await settle(entries.shift());
      return [...entry.items.map((item) => item.from), ...direct];
    }),
    /** Whether the last deletion in `root` can be taken back. */
    pending: (root) => entries.length > 0 && entries[entries.length - 1].root === root,
    /**
     * Puts back what was last deleted from `root`: `{ restored, kept }`. `kept` are the ones
     * whose place has been taken since: they cannot go back, so they go to the trash, and the
     * deletion before this one is the next to be undone.
     */
    undo: (root) => queued(async () => {
      const entry = entries[entries.length - 1];
      if (!entry || entry.root !== root) throw new Error("There is no deletion to undo here");
      entries.pop();
      const restored = [], kept = [];
      for (const item of entry.items) {
        try { await move(item.held, item.from); restored.push(item.from); }
        catch { kept.push(item); }
      }
      if (kept.length) await settle({ ...entry, items: kept });
      else await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
      return { restored, kept: kept.map((item) => item.from) };
    }),
    /** Everything held goes to the trash: the folder is being left, or Runes is closing. */
    flush: () => queued(async () => { const all = entries; entries = []; for (const entry of all) await settle(entry); }),
    /** What an earlier run left behind (it was stopped before it could flush) goes to the trash. */
    sweep: () => queued(async () => {
      let runs = [];
      try { runs = await fs.readdir(dir); } catch { return; }
      for (const run of runs) {
        if (entries.some((entry) => entry.dir === path.join(dir, run))) continue;
        let slots = [];
        try { slots = await fs.readdir(path.join(dir, run)); } catch { continue; }
        for (const slot of slots) {
          let names = [];
          try { names = await fs.readdir(path.join(dir, run, slot)); } catch { continue; }
          for (const name of names) await Promise.resolve(trash(path.join(dir, run, slot, name))).catch(() => {});
        }
        // Only what is empty is cleared away: what the trash would not take is still there.
        for (const slot of slots) await fs.rmdir(path.join(dir, run, slot)).catch(() => {});
        await fs.rmdir(path.join(dir, run)).catch(() => {});
      }
    }),
    held: () => entries.length,
  };
}

module.exports = { create, move };
