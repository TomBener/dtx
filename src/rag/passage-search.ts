/**
 * passage-search.ts — Passage-level semantic search
 *
 * Queries the local vector index and returns matched text chunks suitable
 * for agent-side evidence extraction and citation.
 */

import { getEmbedder } from "./embedder.js";
import { VectorStore, getIndexDir, indexExists } from "./store.js";

const storeCache = new Map<string, VectorStore>();

function getStore(indexDir?: string): VectorStore | null {
  const key = getIndexDir(indexDir);
  if (!indexExists(key)) return null;

  const cached = storeCache.get(key);
  if (cached?.isReady()) return cached;

  const store = new VectorStore(0, undefined, undefined, key);
  if (store.load()) {
    storeCache.set(key, store);
    return store;
  }
  return null;
}

/** Reset cached store (call after rebuilding index) */
export function resetStoreCache(indexDir?: string): void {
  if (indexDir) {
    storeCache.delete(getIndexDir(indexDir));
    return;
  }
  storeCache.clear();
}

export async function searchPassages(
  query: string,
  limit: number = 10,
  indexDir?: string,
): Promise<{
  results: Array<{
    uuid: string;
    docName: string;
    database: string;
    text: string;
    chunkIndex: number;
    score: number;
    citationKey?: string;
  }>;
  indexAvailable: boolean;
}> {
  const store = getStore(indexDir);
  if (!store) {
    return { results: [], indexAvailable: false };
  }

  const embedder = getEmbedder();
  const queryVector = await embedder.embedQuery(query);
  const candidatePoolSize = Math.max(limit * 20, 200);
  const results = store
    .search(queryVector, candidatePoolSize)
    .map((r) => ({
      ...r,
      score: rerankPassageScore(query, r.text, r.score),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    results: results.map((r) => ({
      uuid: r.uuid,
      docName: r.docName,
      database: r.database,
      text: r.text,
      chunkIndex: r.chunkIndex,
      score: r.score,
      citationKey: r.citationKey,
    })),
    indexAvailable: true,
  };
}

function rerankPassageScore(query: string, text: string, semanticScore: number): number {
  return Math.min(1, semanticScore + computeLexicalBoost(query, text));
}

function computeLexicalBoost(query: string, text: string): number {
  const normalizedQuery = normalizeForMatch(query);
  const normalizedText = normalizeForMatch(text);
  if (!normalizedQuery || !normalizedText) return 0;

  let boost = 0;

  if (normalizedText.includes(normalizedQuery)) {
    boost += 0.2;
  }

  const phrases = extractMatchPhrases(normalizedQuery);
  let bestMatchedLength = 0;
  let matchedCount = 0;

  for (const phrase of phrases) {
    if (!phrase || !normalizedText.includes(phrase)) continue;
    matchedCount++;
    if (phrase.length > bestMatchedLength) bestMatchedLength = phrase.length;
  }

  if (bestMatchedLength >= 6) boost += 0.14;
  else if (bestMatchedLength >= 4) boost += 0.1;
  else if (bestMatchedLength >= 3) boost += 0.06;
  else if (bestMatchedLength >= 2) boost += 0.03;

  if (matchedCount > 1) {
    boost += Math.min(0.06, (matchedCount - 1) * 0.01);
  }

  return boost;
}

function extractMatchPhrases(normalizedQuery: string): string[] {
  const phrases = new Set<string>();
  const tokens = normalizedQuery
    .split(/[^\p{L}\p{N}\p{Script=Han}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  for (const token of tokens) {
    phrases.add(token);

    // For longer CJK queries like "梅贻琦说过的话", include shorter exact subphrases
    // so that named entities inside a longer natural-language query are rewarded.
    if (/^\p{Script=Han}+$/u.test(token) && token.length >= 4) {
      const maxLen = Math.min(6, token.length);
      for (let len = 3; len <= maxLen; len++) {
        for (let i = 0; i <= token.length - len; i++) {
          phrases.add(token.slice(i, i + len));
        }
      }
    }
  }

  return [...phrases];
}

function normalizeForMatch(input: string): string {
  return input.trim().normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}
