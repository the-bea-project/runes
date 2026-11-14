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

const IMAGES = { "image/png": 1, "image/jpeg": 1, "image/webp": 1, "image/gif": 1, "image/svg+xml": 1 };

/** An extension's icon as a data: address the window may show. "" when there is none worth showing. */
async function icon(url, fetcher = fetch) {
  const base = registry();
  if (typeof url !== "string" || !url.startsWith(base + "/")) return "";
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return "";
    const type = String(response.headers.get("content-type") ?? "").split(";")[0].trim();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!IMAGES[type] || bytes.length > 600 * 1024) return "";
    return `data:${type};base64,${bytes.toString("base64")}`;
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
