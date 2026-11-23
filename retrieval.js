// Tiny BM25 keyword search with group-chat-aware normalisation. Pure: no DOM, no fetch.

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MIN_TOKEN_LENGTH = 2;
const STEM_MIN_LENGTH = 5;

const STOPWORDS = new Set((
  "the a an and or but of to in on at for from by with about as is are was were be been being am do does did " +
  "have has had i me my you your u ur we us our they them their he him his she her it its this that these those " +
  "what whats who whos whom which when where why how if then so than too very just really can could would should " +
  "will wont dont didnt im ive yall bro yo hey lol lmao like get got go going gonna know think tell say said " +
  "there here any some all no not yes yeah yah ok okay rn tho though again still " +
  "up sup wyd wbu hey hi hello yo good nothing nm much doing today tonight anyway wait"
).split(" "));

// Generic texting phrases/spellings. Group-specific nicknames come from a private synonyms.json.
const PHRASES = [
  [/\bin[\s-]*n[\s'-]*out\b/g, " innout "],
  [/\bmt\.?\s*sac\b/g, " mtsac "],
  [/\bgroup\s*chat\b/g, " chat "],
];
const BASE_SYNONYMS = {
  gc: "chat", groupchat: "chat", convo: "chat", renamed: "name", rename: "name", named: "name",
  started: "start", made: "start", created: "start", founder: "start", photos: "photo",
  photographer: "photo", pics: "photo", won: "win", winning: "win",
};

/** @param {string} word @returns {string} */
function stem(word) {
  if (word.length < STEM_MIN_LENGTH) return word;
  if (word.endsWith("ing")) return word.slice(0, -3);
  if (word.endsWith("ed")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace multi-word synonym keys ("e and o") before splitting into words. */
function applyPhraseSynonyms(text, synonyms) {
  return Object.entries(synonyms)
    .filter(([from]) => from.includes(" "))
    .reduce((t, [from, to]) => t.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "g"), ` ${to} `), text);
}

/**
 * @param {string} text
 * @param {Record<string, string>} [synonyms] extra word -> canonical word (multi-word keys allowed)
 * @returns {string[]}
 */
export function tokenize(text, synonyms = {}) {
  const lower = text.toLowerCase().replace(/[’']s\b/g, "");
  const phrased = applyPhraseSynonyms(PHRASES.reduce((t, [re, rep]) => t.replace(re, rep), lower), synonyms);
  return (phrased.match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(w))
    .map((w) => stem(synonyms[w] || BASE_SYNONYMS[w] || w));
}

const MIN_FUZZY_LENGTH = 4;

/** Edit distance, capped: returns cap+1 as soon as it's clearly further. */
function editDistance(a, b, cap = 1) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...row) > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

/** For a query word not in the index (a typo like "juda"), the indexed word one edit away, if any. */
function closestTerm(term, vocabulary) {
  if (term.length < MIN_FUZZY_LENGTH) return null;
  let best = null;
  for (const [word, count] of vocabulary) {
    if (word[0] === term[0] && editDistance(term, word) <= 1 && (!best || count > best.count)) {
      best = { word, count };
    }
  }
  return best?.word || null;
}

const NOT_NAMES = new Set(("jan feb mar apr may jun jul aug sep oct nov dec january february march april june july " +
  "august september october november december monday tuesday wednesday thursday friday saturday sunday you " +
  "inside joke about the his her their").split(" "));

/**
 * @typedef {{ context?: string, contextWeight?: number }} SearchOptions
 *   context: earlier conversation; its words count at contextWeight (0-1) unless the query has them too
 * @param {string[]} docs
 * @param {Record<string, string>} [synonyms]
 * @returns {{
 *   search: (query: string, k: number, options?: SearchOptions) => {index: number, score: number}[],
 *   mentionsName: (text: string) => boolean,
 * }}
 */
export function createIndex(docs, synonyms = {}) {
  const docTokens = docs.map((d) => tokenize(d, synonyms));
  // Words written capitalised mid-sentence in the docs are treated as names (people, places, events).
  const nameTerms = new Set(docs.flatMap((d) => (d.match(/(?<=\S\s)[A-Z][a-zA-Z'-]+/g) || [])
    .flatMap((w) => tokenize(w, synonyms)))
    .filter((t) => !NOT_NAMES.has(t)));
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(docTokens.length, 1);
  const df = new Map();
  docTokens.forEach((tokens) => new Set(tokens).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const n = docTokens.length;
  const idf = (t) => Math.log(1 + (n - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const termFreqs = docTokens.map((tokens) => tokens.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map()));

  return {
    search(query, k, { context = "", contextWeight = 0 } = {}) {
      const fix = (t) => (df.has(t) ? t : closestTerm(t, df) || t);
      const weights = new Map(tokenize(query, synonyms).map((t) => [fix(t), 1]));
      if (contextWeight > 0) {
        tokenize(context, synonyms).map(fix).forEach((t) => { if (!weights.has(t)) weights.set(t, contextWeight); });
      }
      if (!weights.size) return [];
      return termFreqs
        .map((tf, index) => {
          const len = docTokens[index].length;
          const score = [...weights].reduce((s, [t, w]) => {
            const f = tf.get(t) || 0;
            return f ? s + w * idf(t) * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * len / avgLen)) : s;
          }, 0);
          return { index, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    mentionsName(text) {
      return tokenize(text, synonyms).some((t) => nameTerms.has(df.has(t) ? t : closestTerm(t, df) || t));
    },
  };
}
