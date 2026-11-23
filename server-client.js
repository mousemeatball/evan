// Browser side of the web-server mode: the page is served over http(s) (by the Mac's server, or by GitHub
// Pages with a config.json pointing at the Mac's tunnel) and Evan answers from the server.
const PASSCODE_KEY = "evan.passcode";
const NAME_KEY = "evan.name";
let apiBase = "";

/** True when the page came over http(s) (not the Mac app's evan:// scheme). */
export const isServerMode = () => location.protocol === "http:" || location.protocol === "https:";

/** On GitHub Pages, config.json says where the Mac's server is; served by the Mac itself, it's this origin. */
export async function loadServerConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    const config = res.ok ? await res.json() : {};
    apiBase = typeof config.api === "string" && /^https:\/\//.test(config.api) ? config.api.replace(/\/$/, "") : "";
  } catch {
    apiBase = "";
  }
}

const read = (key) => { try { return localStorage.getItem(key) || ""; } catch { return ""; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* convenience only */ } };
export const savedPasscode = () => read(PASSCODE_KEY);
export const savePasscode = (v) => write(PASSCODE_KEY, v);
export const savedName = () => read(NAME_KEY);
export const saveName = (v) => write(NAME_KEY, v);

/** Error with a code the UI turns into a friendly message: auth | rate | busy | offline | glitch. */
class ServerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const CODES = { 401: "auth", 429: "rate", 503: "busy" };

async function post(path, passcode, body = {}) {
  let res;
  try {
    res = await fetch(`${apiBase}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Evan-Passcode": passcode },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServerError("offline");
  }
  if (!res.ok) throw new ServerError(CODES[res.status] || "glitch");
  return res;
}

/** @returns {Promise<boolean>} whether the server accepts this passcode (throws "offline" if unreachable) */
export async function checkPasscode(passcode) {
  try {
    await post("api/check", passcode);
    return true;
  } catch (err) {
    if (err.code === "auth") return false;
    throw err;
  }
}

/** Evan's 3D head, which the server only hands out with the passcode. @returns {Promise<ArrayBuffer>} */
export async function fetchHead(passcode) {
  return (await post("api/head", passcode)).arrayBuffer();
}

/**
 * @param {{who: string, text: string}[]} history @param {string} passcode @param {string} name
 * @returns {Promise<string[]>} Evan's reply lines
 */
export async function askServer(history, passcode, name) {
  const turns = history.map(({ who, text }) => ({ who, text }));
  const data = await (await post("api/reply", passcode, { history: turns, name })).json();
  return Array.isArray(data.lines) ? data.lines.filter((l) => typeof l === "string") : ["?"];
}
