// Talking to an AI provider with the user's own key. The key never reaches the window:
// it is kept encrypted by the operating system's keychain (Electron safeStorage).
"use strict";

const PROVIDERS = {
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-5-5" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
};

/** Where requests go. A custom address must be https, or http on this machine only. */
function endpoint(provider, baseUrl) {
  const known = PROVIDERS[provider];
  if (!known) throw new Error(`Unknown AI provider "${provider}". Use "anthropic" or "openai".`);
  if (!baseUrl) return known.url;
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("runes.ai.baseUrl must be an https address (http is allowed for localhost only)");
  }
  return url.toString().replace(/\/$/, "") + new URL(known.url).pathname;
}

function request(provider, model, key, messages) {
  const clean = messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 400000) }));
  if (provider === "anthropic") {
    return {
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: { model: model || PROVIDERS.anthropic.model, max_tokens: 4096, stream: true, messages: clean },
    };
  }
  return {
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: { model: model || PROVIDERS.openai.model, stream: true, messages: clean },
  };
}

/** The text in one server-sent event, for either provider. */
function delta(provider, json) {
  if (provider === "anthropic") return json.type === "content_block_delta" ? json.delta?.text ?? "" : "";
  return json.choices?.[0]?.delta?.content ?? "";
}

/** Send a conversation; `emit("delta", text)` as it arrives, then `emit("done")` or `emit("error", why)`. */
async function send({ provider, model, baseUrl, messages }, key, emit, fetcher = fetch) {
  try {
    if (!key) throw new Error(`No API key is stored for ${provider}. Run "Runes: Set AI API Key".`);
    const { headers, body } = request(provider, model, key, messages);
    const response = await fetcher(endpoint(provider, baseUrl), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    if (!response.ok) {
      const text = await response.text();
      let why = text.slice(0, 300);
      try { why = JSON.parse(text).error?.message ?? why; } catch {}
      throw new Error(`${provider} answered ${response.status}: ${why}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const text = delta(provider, JSON.parse(data));
          if (text) emit("delta", text);
        } catch {}
      }
    }
    emit("done", "");
  } catch (e) {
    emit("error", String(e?.message ?? e));
  }
}

module.exports = { send, endpoint, request, delta, PROVIDERS };
