// Evan chat UI. Prompting lives in prompt.js, memory in memory.js, local models in backends.js,
// the web-server mode in server-client.js, and the message thread in thread.js.
import { BUILTIN, BUILTIN_LABEL, complete, listOllamaModels, waitForBuiltin } from "./backends.js";
import { loadMemory } from "./memory.js";
import { BUDGETS, buildMessages, cleanReply, createVoicePicker, dropRepeats, guardedReply, screenReply } from "./prompt.js";
import {
  askServer, checkPasscode, fetchHead, isServerMode, loadServerConfig, saveName, savePasscode, savedName, savedPasscode,
} from "./server-client.js";
import { createThread, forget, loadSaved, save } from "./thread.js";

const OLLAMA_CONTEXT_WITH_MEMORY = 24576;
const OLLAMA_CONTEXT = 8192;
const MODEL_KEY = "evan.model";
const TYPING_MS_PER_CHAR = 45;          // feels like a person typing
const MIN_TYPING_MS = 700;
const MAX_TYPING_MS = 3500;
const BUBBLE_GAP_MS = 500;
const SPLIT_OVER_CHARS = 90;            // long replies become a couple of bubbles
const MAX_BUBBLES = 3;
const SERVER_MODE = isServerMode();
const SERVER_ERRORS = {
  rate: "Evan needs a minute, you're texting too fast 😭",
  busy: "Evan's texting someone else rn, try again in a sec",
  offline: "Evan's phone is dead rn (the Mac running him is offline). Try later",
  glitch: "Evan's brain glitched for a sec. Send that again?",
};

const $ = (id) => document.getElementById(id);
const els = {
  log: $("log"), input: $("input"), send: $("send"), form: $("composer"), status: $("status"),
  model: $("model"), setup: $("setup"), setupTitle: $("setup-title"), setupText: $("setup-text"),
  setupRetry: $("setup-retry"), setupInput: $("setup-input"), setupName: $("setup-name"), newChat: $("new-chat"),
};
const thread = createThread(els.log);

let pickVoice = () => [];
let memory = { available: false, summary: "", recall: () => ({ facts: [], excerpts: [] }) };
let friends = "";
let persona;          // undefined -> prompt.js default
let history = [];     // [{ who: "You" | "Evan", text, at }], replaced, never mutated
let isBusy = false;
let passcode = "";
let friendName = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

// ---------- getting a reply ----------

async function askEvan(model, hist) {
  if (SERVER_MODE) return askServer(hist, passcode, friendName);
  const blocked = guardedReply(hist[hist.length - 1]?.text || "");
  if (blocked) return blocked.split("\n");
  const budget = model === BUILTIN ? BUDGETS.reasoning : BUDGETS.large;
  const messages = buildMessages({ history: hist, pickVoice, memory, friends, persona, budget });
  const ollamaContext = memory.available ? OLLAMA_CONTEXT_WITH_MEMORY : OLLAMA_CONTEXT;
  const { temperature, maxTokens, presencePenalty } = budget;
  const latest = hist[hist.length - 1]?.text || "";
  const raw = await complete(model, messages, { ollamaContext, temperature, maxTokens, presencePenalty });
  const lines = dropRepeats(cleanReply(raw, latest), hist);
  return lines.length ? screenReply(lines) : ["?"];
}

/** Long single replies become a couple of texts, split at sentence ends. */
function toBubbles(lines) {
  return lines.flatMap((line) => {
    if (line.length <= SPLIT_OVER_CHARS) return [line];
    const parts = line.split(/(?<=[.!?])\s+/);
    return parts.length > 1 ? parts : [line];
  }).slice(0, MAX_BUBBLES);
}

const typingTime = (text) => Math.min(MAX_TYPING_MS, Math.max(MIN_TYPING_MS, text.length * TYPING_MS_PER_CHAR));

// ---------- UI state ----------

function setStatus(text, isTyping = false) {
  els.status.textContent = text;
  els.status.classList.toggle("typing", isTyping);
  window.evanHead?.setTyping(isTyping);
}

function setReady(isReady) {
  els.input.disabled = !isReady;
  els.send.disabled = !isReady;
  if (isReady) els.input.focus();
}

function showSetup({ title, text, askPasscode = false, askName = false }) {
  els.setupTitle.textContent = title;
  els.setupText.textContent = text;
  els.setupInput.hidden = !askPasscode;
  els.setupName.hidden = !askName;
  els.setupRetry.textContent = askPasscode || askName ? "Let me in" : "Try again";
  els.setup.hidden = false;
  setReady(false);
  (askName ? els.setupName : els.setupInput).focus();
}

/** @param {{value: string, label: string}[]} options */
function populateModels(options) {
  const saved = (() => { try { return localStorage.getItem(MODEL_KEY); } catch { return null; } })();
  const values = options.map((o) => o.value);
  const preferred = [saved, BUILTIN].find((v) => v && values.includes(v)) || values[0];
  els.model.replaceChildren(...options.map((o) => new Option(o.label, o.value, false, o.value === preferred)));
}

async function checkServerSetup() {
  els.setup.hidden = true;
  els.model.hidden = true;
  setStatus("waking up…");
  const typedCode = els.setupInput.value.trim();
  const typedName = els.setupName.value.trim();
  const candidate = typedCode || savedPasscode();
  const name = typedName || savedName();
  let isValid = false;
  try {
    isValid = candidate ? await checkPasscode(candidate) : false;
  } catch {
    setStatus("offline");
    showSetup({ title: "Evan's offline", text: "The Mac running Evan isn't reachable right now. Try again later." });
    return;
  }
  if (!isValid || !name) {
    setStatus("locked");
    showSetup({
      title: typedCode && !isValid ? "Wrong passcode" : "Who's this?",
      text: "Your name, and the passcode from the group chat.", askPasscode: true, askName: true,
    });
    if (name) els.setupName.value = name;
    return;
  }
  passcode = candidate;
  friendName = name;
  savePasscode(candidate);
  saveName(name);
  els.setupInput.value = "";
  fetchHead(passcode).then((buf) => window.evanHead?.loadBuffer(buf)).catch(() => {});
  setStatus("online");
  setReady(true);
}

async function checkSetup() {
  if (SERVER_MODE) return checkServerSetup();
  els.setup.hidden = true;
  setStatus("waking up…");
  const [isBuiltinReady, ollamaModels] = await Promise.all([waitForBuiltin(), listOllamaModels()]);
  const options = [
    ...(isBuiltinReady ? [{ value: BUILTIN, label: BUILTIN_LABEL }] : []),
    ...ollamaModels.map((m) => ({ value: m, label: m })),
  ];
  if (!options.length) {
    setStatus("offline");
    showSetup({
      title: "Evan couldn't wake up",
      text: "His built-in brain didn't start. Quit and reopen Evan. If it still fails, see READ ME FIRST in the download.",
    });
    return;
  }
  populateModels(options);
  setStatus("online");
  setReady(true);
}

// ---------- sending ----------

async function send(text) {
  if (isBusy) return;
  isBusy = true;
  els.send.disabled = true;  // keep the text box usable so you can type your next message
  const sent = { who: "You", text, at: Date.now() };
  thread.bubble("me", text, sent.at);
  history = [...history, sent];
  save(history);
  try {
    const started = Date.now();
    const pending = askEvan(els.model.value, history);
    await sleep(600);
    thread.markRead();
    setStatus("typing…", true);
    thread.typing(true);
    const bubbles = toBubbles(await pending);
    for (const [i, line] of bubbles.entries()) {
      const wait = i === 0 ? typingTime(line) - (Date.now() - started) : BUBBLE_GAP_MS + typingTime(line) / 2;
      if (wait > 0) await sleep(wait);
      const reply = { who: "Evan", text: line, at: Date.now() };
      thread.typing(false);
      thread.bubble("them", line, reply.at);
      history = [...history, reply];
      if (i < bubbles.length - 1) thread.typing(true);
    }
    save(history);
  } catch (err) {
    thread.typing(false);
    console.error("Evan reply failed:", errorMessage(err));
    if (err?.code === "auth") {
      savePasscode("");
      showSetup({ title: "Passcode changed", text: "Ask the group chat for the new passcode.", askPasscode: true });
      return;
    }
    thread.bubble("error", SERVER_ERRORS[err?.code] || SERVER_ERRORS.glitch);
  } finally {
    setStatus("online");
    isBusy = false;
    if (els.setup.hidden) setReady(true);
  }
}

const introText = () => (SERVER_MODE
  ? "AI Evan · not actually him · chats stay in your browser, not saved on the Mac"
  : "AI Evan · runs on your Mac · not actually him");

function startNewChat() {
  if (isBusy) return;
  history = [];
  forget();
  thread.clear();
  thread.note(introText());
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || isBusy) return;
  els.input.value = "";
  send(text);
});
els.model.addEventListener("change", () => {
  try { localStorage.setItem(MODEL_KEY, els.model.value); } catch { /* per-viewer convenience only */ }
});
els.setupRetry.addEventListener("click", checkSetup);
[els.setupInput, els.setupName].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") checkSetup(); }));
els.newChat.addEventListener("click", startNewChat);

// ---------- start ----------

async function loadLocalBrain() {
  const getText = (path) => fetch(path).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const synonyms = await fetch("synonyms.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const safeSynonyms = synonyms && typeof synonyms === "object" && !Array.isArray(synonyms) ? synonyms : {};
  persona = (await getText("persona.txt")).trim() || undefined;
  try {
    const lines = await (await fetch("evan_lines.json")).json();
    pickVoice = createVoicePicker(Array.isArray(lines) ? lines.filter((l) => typeof l === "string") : [], safeSynonyms);
  } catch (err) {
    thread.bubble("error", `Couldn't load Evan's texts: ${errorMessage(err)}`);
  }
  friends = (await getText("friends.txt")).trim();
  memory = await loadMemory(safeSynonyms);
}

function restoreSavedChat() {
  history = SERVER_MODE ? loadSaved() : [];
  thread.note(introText());
  history.forEach((m) => thread.bubble(m.who === "You" ? "me" : "them", m.text, m.at || Date.now()));
}

async function init() {
  if (SERVER_MODE) await loadServerConfig();   // the server holds the memory; the page only sends the chat
  else await loadLocalBrain();
  restoreSavedChat();
  await checkSetup();
}

init();
