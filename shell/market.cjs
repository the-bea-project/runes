// Finding and downloading extensions from Open VSX (https://open-vsx.org), the open registry
// of VS Code extensions. Microsoft's own Marketplace may only be used by Microsoft's products,
// so Runes does not talk to it. No Electron in here.
"use strict";

const REGISTRY = "https://open-vsx.org";
const NAME = /^[\w.-]{1,120}$/;

function registry() {
  const custom = process.env.RUNES_MARKETPLACE;
  if (!custom) return REGISTRY;
  const url = new URL(custom);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("RUNES_MARKETPLACE must be an https address");
  return url.origin;
}

/** Extensions matching some words: [namespace, name, display name, description, version, downloads]. */
async function search(query, fetcher = fetch) {
  const base = registry();
  const url = `${base}/api/-/search?size=30&sortBy=${query ? "relevance" : "downloadCount"}&sortOrder=desc&query=${encodeURIComponent(String(query).slice(0, 200))}`;
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`The marketplace answered ${response.status}`);
  const found = (await response.json()).extensions ?? [];
  return found.filter((e) => NAME.test(e.namespace ?? "") && NAME.test(e.name ?? "")).map((e) =>
    [e.namespace, e.name, String(e.displayName ?? e.name).slice(0, 120), String(e.description ?? "").slice(0, 300), String(e.version ?? ""), Number(e.downloadCount) || 0,
      typeof e.files?.icon === "string" && e.files.icon.startsWith(base + "/") ? e.files.icon : ""]);
}

/** The bytes of the latest version of one extension. The file must come from the registry itself. */
async function download(namespace, name, fetcher = fetch) {
  if (!NAME.test(String(namespace)) || !NAME.test(String(name))) throw new Error("Bad request");
  const base = registry();
  const meta = await fetcher(`${base}/api/${namespace}/${name}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!meta.ok) throw new Error(`The marketplace has no ${namespace}.${name} (${meta.status})`);
  const file = String((await meta.json()).files?.download ?? "");
  if (!file.startsWith(base + "/")) throw new Error("The marketplace pointed somewhere else for the download; refusing it");
  const response = await fetcher(file, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`The download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 300 * 1024 * 1024) throw new Error("That extension is larger than Runes accepts");
  return bytes;
}

/**
 * What kind of picture some bytes are, by their first few: the registry's file store often
 * says only "application/octet-stream", so what it says is not what is gone by.
 */
function pictureType(bytes) {
  const starts = (...codes) => codes.every((code, i) => bytes[i] === code);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const head = bytes.subarray(0, 600).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

/**
 * An extension's icon as a data: address the window may show. "" when there is none worth
 * showing. `cache` ({ get(url), set(url, address) }, both may be async) keeps what was
 * fetched, so a picture is asked of the registry once and is there at once ever after.
 * Up to 4 MB is read; what is shown and kept is at most 1 MB.
 */
async function icon(url, fetcher = fetch, cache = null, shrink = null) {
  const base = registry();
  if (typeof url !== "string" || !url.startsWith(base + "/")) return "";
  try {
    const kept = await cache?.get(url);
    if (typeof kept === "string" && kept.startsWith("data:image/")) return kept;
  } catch {}
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) return "";
    let bytes = Buffer.from(await response.arrayBuffer());
    let type = pictureType(bytes);
    if (!type || bytes.length > 4 * 1024 * 1024) return "";
    // Some icons are far larger than the corner they are shown in: `shrink(bytes, type)` may
    // hand back a smaller { bytes, type }.
    const smaller = shrink?.(bytes, type);
    if (smaller) ({ bytes, type } = smaller);
    if (bytes.length > 1024 * 1024) return "";
    const address = `data:${type};base64,${bytes.toString("base64")}`;
    try { await cache?.set(url, address); } catch {}
    return address;
  } catch { return ""; }
}

/** An extension's readme, as text. "" when it has none or it cannot be had from the registry itself. */
async function readme(namespace, name, fetcher = fetch) {
  if (!NAME.test(String(namespace)) || !NAME.test(String(name))) throw new Error("Bad request");
  const base = registry();
  try {
    const meta = await fetcher(`${base}/api/${namespace}/${name}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!meta.ok) return "";
    const file = String((await meta.json()).files?.readme ?? "");
    if (!file.startsWith(base + "/")) return "";
    const response = await fetcher(file, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return "";
    return (await response.text()).slice(0, 400 * 1024);
  } catch { return ""; }
}

module.exports = { search, download, icon, readme, REGISTRY };
