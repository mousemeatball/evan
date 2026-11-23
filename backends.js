// Where Evan's replies come from: the built-in model bundled in the app (llama.cpp, always there),
// plus any Ollama models if the person happens to have Ollama running.
export const BUILTIN = "builtin";
export const BUILTIN_LABEL = "Built-in (small)";
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 500;
const MAX_TOKENS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} url @param {object} body @returns {Promise<any>} */
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(err || `Model error ${res.status}`);
  }
  return data;
}

/** Wait until the bundled model server has loaded. @returns {Promise<boolean>} */
export async function waitForBuiltin() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("llm/health");
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === "ok") return true;
      if (data.fatal) return false;            // the app couldn't start it at all
    } catch { /* server still starting */ }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

/** @returns {Promise<string[]>} Ollama models, or [] if Ollama isn't running. */
export async function listOllamaModels() {
  try {
    const res = await fetch("ollama/api/tags");
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name).filter((n) => typeof n === "string");
  } catch {
    return [];
  }
}

/**
 * @param {string} model BUILTIN or an Ollama model name
 * @param {{role: string, content: string}[]} messages
 * @param {{ ollamaContext: number, temperature: number, maxTokens?: number, presencePenalty?: number }} options
 * @returns {Promise<string>}
 */
export async function complete(model, messages, { ollamaContext, temperature, maxTokens = MAX_TOKENS, presencePenalty = 0 }) {
  if (model === BUILTIN) {
    // the built-in model thinks first; llama-server returns the thinking separately from the reply
    const data = await postJSON("llm/v1/chat/completions", {
      messages, temperature, max_tokens: maxTokens, presence_penalty: presencePenalty, stream: false,
    });
    return data?.choices?.[0]?.message?.content || "";
  }
  const data = await postJSON("ollama/api/chat", {
    model, messages, stream: false, think: false,
    options: { temperature, num_predict: MAX_TOKENS, num_ctx: ollamaContext },
  });
  return data?.message?.content || "";
}
