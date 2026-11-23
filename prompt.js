// Builds what the model sees each turn. Pure (no DOM, no fetch) so it can be tested in Node.
import { createIndex } from "./retrieval.js";

/** Fallback if no persona.txt is bundled (the real one is private and lives outside the repo). */
export const DEFAULT_PERSONA = "You are a friend texting. Keep it short and casual. Never say you are an AI. Never be sexual.";

/** How much to put in front of each kind of model. A 1B model needs a small, focused prompt. */
export const BUDGETS = {
  small: { voiceRelevant: 5, voiceRandom: 5, facts: 3, minScoreRatio: 0.6, excerpts: 0, historyTurns: 4,
           includeSummary: false, temperature: 0.5 },
  // A small model that thinks before answering: it can use more context and the conversation.
  reasoning: { voiceRelevant: 8, voiceRandom: 8, facts: 6, minScoreRatio: 0.35, excerpts: 2, historyTurns: 10,
               includeSummary: false, temperature: 0.6, alwaysHistory: true, maxTokens: 1024, presencePenalty: 1.0 },
  // A big model behind the web server: plenty of memory and conversation, no giant summary (keeps it fast).
  server: { voiceRelevant: 20, voiceRandom: 20, facts: 8, minScoreRatio: 0.3, excerpts: 3, historyTurns: 16,
            includeSummary: false, includeFriends: true, temperature: 0.8, alwaysHistory: true, maxTokens: 120,
            companion: true },
  large: { voiceRelevant: 40, voiceRandom: 40, facts: 8, excerpts: 4, historyTurns: 12, includeSummary: true,
           temperature: 0.9 },
};

const MAX_REPLY_LINES = 3;
const EVAN_LABEL = /^\s*(Evan( \(you\))?|You|Me)\s*:\s*/i;
const OTHER_SPEAKER = /^(?!(Evan|You|Me)\b)[A-Z][\w'.-]{1,20}( [A-Z][\w'.-]{1,20})?\s*:\s/;  // "Sam: ..."
const COPIED_LOG_LINE = /^[A-Z][a-z]{2} \d{1,2}(,|\s)/;                                       // "Nov 7 Sam: ..."
const WRAPPING_QUOTES = /^["“](.*)["”]$/;

/**
 * @template T @param {T[]} arr @param {number} n @param {() => number} rng @returns {T[]}
 */
function sample(arr, n, rng) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const VAGUE_MESSAGE = /^\W*(\?+|what|wdym|huh|who|why|how|bro|wait|no|nah|yes|yeah|ok|lol|lmao|for real|fr|and)\W*$/i;
const MIN_SPECIFIC_WORDS = 3;

const FOLLOW_UP = /\b(he|she|him|her|his|hers|it|its|they|them|their|that|this|there|those|these|else|why|how come|and|also|we|us|our|when|where|then)\b/i;
const NEW_TOPIC_CONTEXT_WEIGHT = 0.25;   // a clear new subject barely looks back
const FOLLOW_UP_CONTEXT_WEIGHT = 1;      // "why was he mad" leans fully on the last exchange
const FRIEND_NAME_WEIGHT = 0.5;

/**
 * How to search memory for the latest message. The previous exchange (your last text + Evan's reply) is
 * always context, but it only matters fully for follow-ups: vague texts ("?", "what") or pronouns with no
 * name in them ("why was he mad", "where is it"). A message that names something starts a new subject.
 * @param {{who: string, text: string}[]} history
 * @param {{ mentionsName: (text: string) => boolean }} [memory]
 * @returns {{ query: string, context: string, contextWeight: number, isFollowUp: boolean }}
 */
export function searchPlan(history, memory = { mentionsName: () => false }) {
  const lastYou = history.map((m) => m.who).lastIndexOf("You");
  const query = lastYou >= 0 ? history[lastYou].text : "";
  const prevYou = history.slice(0, Math.max(lastYou, 0)).map((m) => m.who).lastIndexOf("You");
  const context = prevYou >= 0 ? history.slice(prevYou, lastYou).map((m) => m.text).join(" ") : "";
  const isFollowUp = isVagueMessage(query) || (FOLLOW_UP.test(query) && !memory.mentionsName(query));
  return {
    query, context, isFollowUp,
    contextWeight: isFollowUp ? FOLLOW_UP_CONTEXT_WEIGHT : NEW_TOPIC_CONTEXT_WEIGHT,
  };
}

/** "?", "what", "huh", one-word replies: they only make sense with the previous messages. */
export function isVagueMessage(text) {
  const t = text.trim();
  return VAGUE_MESSAGE.test(t) || t.split(/\s+/).length < MIN_SPECIFIC_WORDS - 1;
}

/**
 * Turn chat history into strictly alternating user/assistant messages that start with the user
 * (some chat templates, like Gemma's, refuse anything else). Same-speaker runs are merged.
 * @param {{who: string, text: string}[]} turns @returns {{role: string, content: string}[]}
 */
export function alternatingTurns(turns) {
  const merged = turns.reduce((acc, m) => {
    const role = m.who === "Evan" ? "assistant" : "user";
    const last = acc[acc.length - 1];
    return last?.role === role
      ? [...acc.slice(0, -1), { role, content: `${last.content}\n${m.text}` }]
      : [...acc, { role, content: m.text }];
  }, []);
  const start = merged.findIndex((m) => m.role === "user");
  const fromUser = start === -1 ? [] : merged.slice(start);
  // the final user turn is added by buildMessages, so this must end on an assistant turn
  return fromUser.length && fromUser[fromUser.length - 1].role === "user" ? fromUser.slice(0, -1) : fromUser;
}

/** Index Evan's real texts once; returns a picker for voice examples. @param {string[]} lines @param {Record<string,string>} [synonyms] */
export function createVoicePicker(lines, synonyms = {}) {
  const index = createIndex(lines, synonyms);
  return (query, nRelevant, nRandom, rng = Math.random) => {
    const relevant = index.search(query, nRelevant).map((r) => lines[r.index]);
    const used = new Set(relevant);
    return [...relevant, ...sample(lines.filter((l) => !used.has(l)), nRandom, rng)];
  };
}

/** What the model is asked to do with the latest text, per budget. */
function finalInstruction(budget, hasFacts, friendName) {
  if (budget.companion) {
    return `Reply to ${friendName || "your friend"}'s latest text as Evan, like a real friend texting back. Read the vibe: `
      + "banter gets banter, but if they're stressed or going through something, be real and kind and ask about it. "
      + "Use what you remember only when it fits. One or two short texts (put a line break between them), "
      + "under 25 words total. Talk as I/me.";
  }
  if (budget.alwaysHistory) {
    return "You ARE Evan: talk about yourself as I/me, never \"Evan\". Think about what your friend means given the "
      + "conversation so far (who \"he\"/\"it\" refers to). If it's a question, use the one or two facts that "
      + "answer it; if it's small talk, just reply casually. ONE short text, under 15 words. Don't list facts.";
  }
  return hasFacts
    ? "Answer the question with the facts above: say the actual names/things from them. "
      + "ONE short text in your style, under 15 words."
    : "Reply in ONE short text in your style (under 12 words).";
}

/**
 * @param {{
 *   history: {who: "You" | "Evan", text: string}[],
 *   pickVoice: (query: string, nRelevant: number, nRandom: number) => string[],
 *   memory: { available: boolean, summary: string, recall: Function },
 *   friends: string,
 *   isSmallModel: boolean,
 *   persona?: string,
 *   budget?: object,
 *   friendName?: string,   who is texting Evan; their name also steers memory search toward them
 * }} input
 * @returns {{role: string, content: string}[]}
 */
export function buildMessages({
  history, pickVoice, memory, friends, isSmallModel, persona = DEFAULT_PERSONA, budget: requested, friendName = "",
}) {
  const budget = requested || (isSmallModel ? BUDGETS.small : BUDGETS.large);
  const recent = history.slice(-budget.historyTurns);
  const latest = recent[recent.length - 1]?.text || "";
  const plan = searchPlan(history, memory);
  const voiceQuery = plan.isFollowUp ? `${plan.query} ${plan.context}` : plan.query;

  const voice = pickVoice(voiceQuery, budget.voiceRelevant, budget.voiceRandom).map((l) => `- ${l}`).join("\n");
  const background = [
    (budget === BUDGETS.large || budget.includeFriends) && friends ? friends : "",
    budget.includeSummary && memory.summary ? `What you know about the group chat:\n${memory.summary}` : "",
  ].filter(Boolean).join("\n\n");
  const whoIsTexting = friendName ? `You're texting ${friendName} right now.` : "";
  const system = [persona, whoIsTexting, background, `Real texts you've sent before (match this voice):\n${voice}`]
    .filter(Boolean).join("\n\n");

  // Earlier turns as a real conversation; small models follow this far better than a transcript blob.
  // A 1B model copies its last answer, so it only sees earlier turns when the new message needs them.
  const needsEarlier = budget === BUDGETS.large || budget.alwaysHistory || plan.isFollowUp;
  const earlier = needsEarlier ? alternatingTurns(recent.slice(0, -1)) : [];

  // The friend's own name joins the context so facts about them come up (at half weight).
  const context = [plan.context, friendName].filter(Boolean).join(" ");
  const contextWeight = Math.max(plan.contextWeight, friendName ? FRIEND_NAME_WEIGHT : 0);
  const recall = memory.available
    ? memory.recall(plan.query, budget, { context, contextWeight })
    : { facts: [], excerpts: [] };
  const remembered = [
    recall.facts.length ? `Facts you know:\n${recall.facts.map((f) => `- ${f}`).join("\n")}` : "",
    recall.excerpts.length ? `From the group chat:\n${recall.excerpts.join("\n---\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const finalTurn = [
    remembered,
    `Your friend texts: ${latest}`,
    finalInstruction(budget, recall.facts.length > 0, friendName),
  ].filter(Boolean).join("\n\n");

  return [{ role: "system", content: system }, ...earlier, { role: "user", content: finalTurn }];
}

const normalise = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

const MIN_ECHO_WORDS = 3;   // "yo" -> "yo" is a reply, not an echo

/** Remove the friend's question if the model echoed it at the start of a line. */
function stripEcho(line, latest) {
  const echo = normalise(latest);
  if (!echo || echo.split(" ").length < MIN_ECHO_WORDS) return line;
  const words = line.split(/\s+/);
  for (let n = words.length; n > 0; n--) {
    if (normalise(words.slice(0, n).join(" ")) === echo) return words.slice(n).join(" ").replace(/^[\s,.!?-]+/, "");
  }
  return line;
}

// Requests to rate/rank people's looks or gossip about crushes never reach the model.
const RATING_REQUEST = /\b(rate|rank|ranking|hottest|hotter|cutest|prettiest|smash|crush(es)?|who do you like|wifey|1-10|out of 10)\b/i;
const DEFLECTIONS = [
  "Nah I'm not doing ts 😭",
  "Bro what is wrong with you",
  "Deadass get a hobby",
  "Not touching that one chief",
  "Absolutely not, ask someone else",
];

// Small models sometimes admit to being an AI when asked directly; the persona never does.
const AI_QUESTION = /\b(are|r)\s+(you|u)\s+(an?\s+)?(ai|a\.i\.|bot|robot|chat\s*gpt|chatbot|llm|real|human|fake)\b|\b(you'?re|ur|youre)\s+(an?\s+)?(ai|bot|robot)\b/i;
const AI_DENIALS = [
  "Bro what 😭 no",
  "Nah I'm just built different",
  "Deadass? I'm literally texting you rn",
  "Why would a bot know this much about yall",
  "Bro I ran 15:21, bots don't run",
];

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

// Replies that rank or rate girls get replaced, even if the model invents them on its own.
const RANKING_WORDS = /\b(number|no\.?|#)\s*\d+\b|\b\d+\s*\/\s*10\b|\b(rank|ranked|ranking|rankings|rated|rating|top \d+|blacklist|list)\b/i;
const ABOUT_GIRLS = /\b(she|she'?d|she'?s|her|hers|girl|girls|gf|baddie|wifey)\b/i;

/**
 * Drop sentences Evan already sent earlier in this chat (small models loop on their own lines).
 * @param {string[]} lines @param {{who: string, text: string}[]} history @returns {string[]}
 */
export function dropRepeats(lines, history) {
  const said = new Set(history.filter((m) => m.who === "Evan")
    .flatMap((m) => m.text.split(/(?<=[.!?])\s+/)).map(normalise).filter((t) => t.length > 8));
  return lines
    .map((l) => l.split(/(?<=[.!?])\s+/).filter((part) => !said.has(normalise(part))).join(" ").trim())
    .filter(Boolean);
}

/**
 * Last check on a reply before it's shown. @param {string[]} lines @param {() => number} [rng]
 * @returns {string[]}
 */
export function screenReply(lines, rng = Math.random) {
  const text = lines.join(" ");
  return RANKING_WORDS.test(text) && ABOUT_GIRLS.test(text) ? [pick(DEFLECTIONS, rng)] : lines;
}

// Someone in real trouble gets a real answer, never a bit. Checked before anything else.
const CRISIS = new RegExp([
  "\\b(kill|hurt|cut|harm)(ing)? (my ?self|myself)\\b", "\\bsuicid", "\\bwant(s|ed)? to die\\b",
  "\\b(end|ending|take|taking) (it all|my life|my own life)\\b", "\\bdon'?t want to (be alive|live|exist)\\b",
  "\\bno reason to live\\b", "\\bbetter off (dead|without me)\\b", "\\bself[- ]?harm",
  "\\bkms\\b", "\\bkys\\b", "\\bunalive",
].join("|"), "i");
export const CRISIS_REPLY = [
  "Hey, dropping the bit for a sec. I'm really glad you told me, and I'm taking it seriously.",
  "I'm just an AI version of Evan though, and you deserve a real person right now. Text or call 988 "
    + "(Suicide & Crisis Lifeline, free, 24/7), or text HOME to 741741. If you're in danger right now, call 911.",
  "Please also tell someone you trust tonight: a parent, a coach, a friend. Text the real Evan or any of the boys. "
    + "Nobody's gonna be weird about it.",
];

/** True when a message sounds like someone might hurt themselves. @param {string} text */
export const isCrisis = (text) => CRISIS.test(text);

/**
 * Canned reply for requests the model shouldn't handle (crisis, rating people, crushes, "are you a bot"), or null.
 * A crisis reply has several bubbles, so callers should split on "\n".
 * @param {string} text @param {() => number} [rng] @returns {string | null}
 */
export function guardedReply(text, rng = Math.random) {
  if (isCrisis(text)) return CRISIS_REPLY.join("\n");
  if (RATING_REQUEST.test(text)) return pick(DEFLECTIONS, rng);
  if (AI_QUESTION.test(text)) return pick(AI_DENIALS, rng);
  return null;
}

/**
 * Keep only Evan's own short lines from a model reply (first person, no other speakers, no echo).
 * @param {string} raw @param {string} [latest] the friend's message, to drop echoes of it
 * @returns {string[]}
 */
// Small models sometimes narrate in third person ("Evan renamed it"); a reply-initial "Evan" is "I".
const SELF_AT_START = [
  [/^Evan's\s+(\w+ing)\b/i, "I'm $1"], [/^Evan's\s/i, "My "], [/^Evan\s+(is|was)\b/i, "I $1"], [/^Evan\s/i, "I "],
];
const firstPerson = (line) => SELF_AT_START.reduce((l, [re, rep]) => l.replace(re, rep), line);

export function cleanReply(raw, latest = "") {
  return raw
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")   // in case the thinking wasn't split out
    .split("\n")
    .map((l) => stripEcho(l.trim(), latest))
    .filter((l) => l && !OTHER_SPEAKER.test(l) && !COPIED_LOG_LINE.test(l))  // small models copy other people's lines
    .map((l) => firstPerson(l.replace(EVAN_LABEL, "").replace(WRAPPING_QUOTES, "$1").trim()))
    .filter(Boolean)
    .slice(0, MAX_REPLY_LINES);
}
