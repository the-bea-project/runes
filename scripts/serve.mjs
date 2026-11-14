// A tiny static server for dist/. Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(fileURLToPath(new URL("..", import.meta.url)), "dist");
const port = Number(process.argv[2] ?? 4180);
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm",
};

createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
  const file = join(dist, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(dist)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Runes on http://127.0.0.1:${port}`));
