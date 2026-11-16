// The only things the page may ask the machine for. Each is one named request to the shell.
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = (name) => (...args) => ipcRenderer.invoke("runes:" + name, ...args);
const direct = ["info", "root", "pickFolder", "readDir", "walk", "readFile", "writeFile", "saveAs", "userFiles", "search",
  "replaceInFiles", "extensions", "installExtension", "removeExtension", "zoom", "devtools", "openLink",
  "marketSearch", "marketDownload", "gitStatus", "gitLog", "gitShow", "gitStage", "gitUnstage", "gitFile", "gitChanged", "gitRefs", "gitDays", "gitTree", "gitHistory", "promptAnswer", "sshSessions", "sshSave", "sshRemove", "sshImport", "sshForget", "sshConnect", "sshOpen", "sshDisconnect", "marketIcon", "marketReadme", "fonts", "fontAdd", "fontRemove",
  "fileCreate", "fileRename", "fileRemove", "fileReveal", "watchDirs", "gitDiscard", "gitBlame", "saveImage",
  "extensionsDisabled", "extensionEnable", "extensionsRunning", "extensionsRestart", "reload", "filePlace", "fileImport", "clipboardFiles", "filesRemove"];

let onExtension = () => {};
ipcRenderer.on("runes:ext", (_event, message) => onExtension(message));
const terminalData = new Map();
ipcRenderer.on("runes:term", (_event, id, data) => terminalData.get(id)?.(data));
let onTerminalExit = () => {};
ipcRenderer.on("runes:termExit", (_event, id) => { terminalData.delete(id); onTerminalExit(id); });

let onPrompt = () => {}, onSsh = () => {}, onFiles = () => {};
ipcRenderer.on("runes:fs", (_event, change) => onFiles(change));
ipcRenderer.on("runes:prompt", (_event, prompt) => onPrompt(prompt));
ipcRenderer.on("runes:ssh", (_event, change) => onSsh(change));

contextBridge.exposeInMainWorld("runesHost", {
  onPrompt: (listener) => { onPrompt = listener; },
  onSsh: (listener) => { onSsh = listener; },
  onFiles: (listener) => { onFiles = listener; },
  // Where a file dropped onto the window lives. Only the system can say; the page hands over
  // the dropped file itself and cannot make one up.
  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ""; } catch { return ""; } },
  ...Object.fromEntries(direct.map((name) => [name, call(name)])),
  ext: {
    send: (message) => ipcRenderer.invoke("runes:extSend", message),
    on: (listener) => { onExtension = listener; },
  },
  term: {
    create: (id, shell, cwd, cols, rows) => ipcRenderer.invoke("runes:termCreate", id, shell, cwd, cols, rows),
    write: (id, data) => ipcRenderer.invoke("runes:termWrite", id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke("runes:termResize", id, cols, rows),
    kill: (id) => { terminalData.delete(id); return ipcRenderer.invoke("runes:termKill", id); },
    onData: (id, listener) => { terminalData.set(id, listener); },
    onExit: (listener) => { onTerminalExit = listener; },
  },
});
