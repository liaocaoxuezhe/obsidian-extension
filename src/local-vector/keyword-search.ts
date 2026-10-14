/**
 * Keyword side of hybrid retrieval. Pure functions shared by the vector-store worker and
 * the MCP reader: turn a free-text query into an FTS5 trigram MATCH expression plus the
 * short (two-character) CJK terms that trigram matching cannot reach, and fuse ranked
 * lists with reciprocal rank fusion.
 */

/** Reciprocal rank fusion constant from Cormack et al.; dampens the head of every list. */
export const RRF_K = 60;
export const DEFAULT_KEYWORD_WEIGHT = 1;
export const MAX_KEYWORD_WEIGHT = 3;
const MAX_TRIGRAMS_PER_RUN = 24;
const MAX_TERMS = 32;

export interface KeywordQuery {
  /** FTS5 MATCH expression over the trigram index, or null when no term has 3+ characters. */
  match: string | null;
  /** Two-character CJK terms (typical Chinese names) matched by substring search instead. */
  shortTerms: string[];
}

const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;
const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_.\-:/#@]*[\p{L}\p{N}_]|[\p{L}\p{N}_]/gu;

function quote(term: string): string {
  return `"${term.replace(/"/g, "\"\"")}"`;
}

/**
 * Builds the keyword query. CJK runs contribute every 3-character window (n-gram retrieval;
 * BM25 rewards notes containing more of them), plus the whole run when it is short enough to
 * be a name. Latin words and code identifiers of 3+ characters are matched as phrases, so
 * `useEffect`, `react-dom` or `user_id` stay intact.
 */
export function buildKeywordQuery(text: string): KeywordQuery {
  const terms = new Set<string>();
  const shortTerms = new Set<string>();
  const source = typeof text === "string" ? text.normalize("NFKC").slice(0, 2000) : "";
  for (const match of source.matchAll(CJK_RUN)) {
    const run = [...match[0]];
    if (run.length === 2) shortTerms.add(run.join(""));
    if (run.length < 3) continue;
    if (run.length <= 8) terms.add(run.join(""));
    let windows = 0;
    for (let index = 0; index + 3 <= run.length && windows < MAX_TRIGRAMS_PER_RUN; index += 1, windows += 1) {
      terms.add(run.slice(index, index + 3).join(""));
    }
  }
  const latin = source.replace(CJK_RUN, " ");
  for (const match of latin.matchAll(WORD)) {
    const word = match[0];
    if ([...word].length >= 3) terms.add(word.toLowerCase());
  }
  const selected = [...terms].slice(0, MAX_TERMS);
  return {
    match: selected.length ? selected.map(quote).join(" OR ") : null,
    shortTerms: [...shortTerms].slice(0, 8),
  };
}

export interface RankedList {
  ids: readonly string[];
  weight: number;
}

/** Reciprocal rank fusion: score(id) = sum over lists of weight / (k + rank). */
export function reciprocalRankFusion(lists: readonly RankedList[], k = RRF_K): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const list of lists) {
    if (!(list.weight > 0)) continue;
    list.ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + list.weight / (k + index + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, order++);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || (firstSeen.get(left.id) ?? 0) - (firstSeen.get(right.id) ?? 0));
}

export function clampKeywordWeight(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return DEFAULT_KEYWORD_WEIGHT;
  return Math.min(MAX_KEYWORD_WEIGHT, Math.max(0, number));
}
