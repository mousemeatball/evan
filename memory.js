// Evan's memory of the group chat: short facts + short windows of real messages, searched per message.
import { createIndex } from "./retrieval.js";

/**
 * @typedef {{ chat: string, text: string }} Window
 * @typedef {{ facts: string[], excerpts: string[] }} Recall
 * @typedef {{ facts: number, excerpts: number, minScoreRatio?: number }} RecallLimits
 * @typedef {{ context?: string, contextWeight?: number }} RecallContext
 * @typedef {{
 *   available: boolean, summary: string,
 *   recall: (query: string, limits: RecallLimits, context?: RecallContext) => Recall,
 *   mentionsName: (text: string) => boolean,
 * }} Memory
 */

/** Label Evan's own lines so the model knows they're his. @param {string} text */
const markSelf = (text) => text.replace(/^(\w{3} \d{1,2} )Evan:/gm, "$1Evan (you):");

/** Drop weak matches that would only distract a small model. */
const keepStrong = (results, ratio = 0) =>
  results.filter((r) => results.length && r.score >= results[0].score * ratio);

/**
 * Pure constructor (used by the app and by the Node tests).
 * @param {string[]} facts @param {Window[]} windows @param {string} [summary]
 * @param {Record<string, string>} [synonyms]
 * @returns {Memory}
 */
export function createMemory(facts, windows, summary = "", synonyms = {}) {
  const safeFacts = facts.filter((f) => typeof f === "string" && f.trim());
  const safeWindows = windows.filter((w) => typeof w?.text === "string");
  const factIndex = createIndex(safeFacts, synonyms);
  const windowIndex = createIndex(safeWindows.map((w) => w.text), synonyms);
  return {
    available: Boolean(safeFacts.length || safeWindows.length),
    summary,
    recall(query, limits, context = {}) {
      return {
        facts: keepStrong(factIndex.search(query, limits.facts, context), limits.minScoreRatio)
          .map((r) => safeFacts[r.index]),
        excerpts: windowIndex.search(query, limits.excerpts, context).map((r) => markSelf(safeWindows[r.index].text)),
      };
    },
    mentionsName: (text) => factIndex.mentionsName(text),
  };
}

/**
 * Load the bundled memory files (missing files just mean less memory).
 * @param {Record<string, string>} [synonyms] @returns {Promise<Memory>}
 */
export async function loadMemory(synonyms = {}) {
  const getJSON = (path, fallback) => fetch(path).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
  const getText = (path) => fetch(path).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const [facts, windows, summary] = await Promise.all([
    getJSON("memory_facts.json", []), getJSON("context_chunks.json", []), getText("chat_summaries.txt"),
  ]);
  return createMemory(Array.isArray(facts) ? facts : [], Array.isArray(windows) ? windows : [], summary.trim(), synonyms);
}
