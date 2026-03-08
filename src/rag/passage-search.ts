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
  const results = store.search(queryVector, limit);

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
