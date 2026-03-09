/**
 * passage-search.ts — Passage-level search over the local vector index
 *
 * Requires a local index built via `dtx index build`.
 * Two modes:
 *   - keyword: lexical matching over indexed chunks
 *   - semantic: cosine similarity search, re-ranked with lexical signals
 */

import { getEmbedder } from "./embedder.js";
import { VectorStore, getIndexDir, indexExists } from "./store.js";

const storeCache = new Map<string, VectorStore>();

const DEFAULT_PASSAGE_MODE: PassageSearchMode = "keyword";
const DEFAULT_MAX_MERGED_PASSAGES = 2;
const DEFAULT_EXCERPT_TARGET_CHARS = 280;
const DEFAULT_EXCERPT_BOUNDARY_SCAN_CHARS = 80;
const DEFAULT_CHUNK_OVERLAP_CHARS = Number(process.env.CHUNK_OVERLAP_CHARS) || 120;
const DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER = 20;
const DEFAULT_SEMANTIC_CANDIDATE_FLOOR = 100;
const MERGE_SCORE_GAP = 0.12;

export type PassageSearchMode = "keyword" | "semantic";

export interface PassageSearchOptions {
  database?: string;
  groupUuid?: string;
  indexDir?: string;
  mode?: PassageSearchMode;
  includeContext?: boolean;
  perDocLimit?: number;
  debug?: boolean;
  /** Filter results to a known DEVONthink document UUID */
  uuid?: string;
  /** Filter results to chunks belonging to documents with this citation key */
  citationKey?: string;
}

export interface PassageSearchResult {
  uuid: string;
  docName: string;
  excerpt: string;
  score: number;
  citationKey?: string;
  contextText?: string;
  database?: string;
  passageIndex?: number;
  passageIndexStart?: number;
  passageIndexEnd?: number;
  mergedPassageCount?: number;
  documentScore?: number;
  passageScore?: number;
  mode?: PassageSearchMode;
}

interface InternalPassageResult {
  uuid: string;
  docName: string;
  database: string;
  text: string;
  excerpt: string;
  contextText: string;
  passageIndex: number;
  passageIndexStart: number;
  passageIndexEnd: number;
  mergedPassageCount: number;
  score: number;
  documentScore: number;
  passageScore: number;
  citationKey?: string;
  mode: PassageSearchMode;
}

interface CandidatePassage extends InternalPassageResult {
  hasDirectMatch: boolean;
}

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
  options: PassageSearchOptions = {},
): Promise<{
  results: PassageSearchResult[];
  indexAvailable: boolean;
}> {
  const mode = options.mode || DEFAULT_PASSAGE_MODE;
  const store = getStore(options.indexDir);
  const includeContext = options.includeContext === true;
  const perDocLimit = normalizePerDocLimit(options.perDocLimit);
  const debug = options.debug === true;
  const uuid = options.uuid;
  const citationKey = options.citationKey;

  if (store && options.groupUuid) {
    const scopeGroupUuid = store.getMeta().scope?.groupUuid;
    if (scopeGroupUuid && scopeGroupUuid !== options.groupUuid) {
      throw new Error(
        `Index scope mismatch: current index is scoped to group "${scopeGroupUuid}", not "${options.groupUuid}". Rebuild the index or override --group.`,
      );
    }
  }

  const allowedUuids = resolveAllowedUuids(store, uuid, citationKey);

  // UUID / citation-key filter without query: return merged consecutive passages for known document(s)
  if (!query.trim() && (uuid || citationKey)) {
    if (!store) {
      return { results: [], indexAvailable: false };
    }
    const results = getAllScopedPassages(store, allowedUuids, options.database);
    return {
      results: toPublicPassageResults(results.slice(0, limit), includeContext, debug),
      indexAvailable: true,
    };
  }

  if (mode === "semantic") {
    if (!store) {
      return { results: [], indexAvailable: false };
    }
    const results = await searchSemanticPassages(
      query,
      limit,
      store,
      perDocLimit,
      options.database,
      allowedUuids,
    );
    return {
      results: toPublicPassageResults(results, includeContext, debug),
      indexAvailable: true,
    };
  }

  if (!store) {
    return { results: [], indexAvailable: false };
  }
  const results = searchIndexedKeywordPassages(
    query,
    limit,
    options.database,
    store,
    perDocLimit,
    allowedUuids,
  );
  return {
    results: toPublicPassageResults(results, includeContext, debug),
    indexAvailable: true,
  };
}

function searchIndexedKeywordPassages(
  query: string,
  limit: number,
  database: string | undefined,
  store: VectorStore,
  perDocLimit?: number,
  allowedUuids?: Set<string>,
): InternalPassageResult[] {
  const candidatePassages: CandidatePassage[] = [];
  const documentBestScores = new Map<string, number>();
  const titleScores = new Map<string, number>();

  for (const chunk of store.getAllChunks()) {
    if (database && chunk.database !== database) continue;
    if (allowedUuids && !allowedUuids.has(chunk.uuid)) continue;

    const titleScore =
      titleScores.get(chunk.uuid) ?? computeKeywordSignals(query, chunk.docName).score;
    titleScores.set(chunk.uuid, titleScore);

    const lexical = computeKeywordSignals(query, chunk.text);
    const documentScore = Math.max(titleScore * 0.7, lexical.score);
    const previous = documentBestScores.get(chunk.uuid) || 0;
    if (documentScore > previous) {
      documentBestScores.set(chunk.uuid, documentScore);
    }

    if (lexical.score <= 0) continue;

    candidatePassages.push({
      uuid: chunk.uuid,
      docName: chunk.docName,
      database: chunk.database,
      text: chunk.text,
      excerpt: chunk.text,
      contextText: chunk.text,
      passageIndex: chunk.chunkIndex,
      passageIndexStart: chunk.chunkIndex,
      passageIndexEnd: chunk.chunkIndex,
      mergedPassageCount: 1,
      score: 0,
      documentScore: 0,
      passageScore: lexical.score,
      citationKey: chunk.citationKey,
      mode: "keyword",
      hasDirectMatch: lexical.hasDirectMatch,
    });
  }

  for (const candidate of candidatePassages) {
    const documentScore =
      documentBestScores.get(candidate.uuid) || candidate.passageScore;
    candidate.documentScore = documentScore;
    candidate.score = Math.min(1, candidate.passageScore + documentScore * 0.18);
  }

  candidatePassages.sort((a, b) => b.score - a.score);
  return postProcessPassages(query, candidatePassages, limit, "keyword", perDocLimit);
}

async function searchSemanticPassages(
  query: string,
  limit: number,
  store: VectorStore,
  perDocLimit?: number,
  database?: string,
  allowedUuids?: Set<string>,
): Promise<InternalPassageResult[]> {
  const embedder = getEmbedder();
  const queryVector = await embedder.embedQuery(query);
  const candidatePoolSize = Math.max(
    limit * DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER,
    DEFAULT_SEMANTIC_CANDIDATE_FLOOR,
  );

  const candidates = store
    .search(queryVector, candidatePoolSize, allowedUuids)
    .filter((r) => !database || r.database === database)
    .map((r) => {
      const lexical = computeKeywordSignals(query, r.text);
      const semanticScore = normalizeSemanticScore(r.score);
      return {
        uuid: r.uuid,
        docName: r.docName,
        database: r.database,
        text: r.text,
        excerpt: r.text,
        contextText: r.text,
        passageIndex: r.chunkIndex,
        passageIndexStart: r.chunkIndex,
        passageIndexEnd: r.chunkIndex,
        mergedPassageCount: 1,
        score: Math.min(1, semanticScore + lexical.score * 0.35),
        documentScore: semanticScore,
        passageScore: semanticScore,
        citationKey: r.citationKey,
        mode: "semantic" as const,
        hasDirectMatch: lexical.hasDirectMatch,
      } satisfies CandidatePassage;
    })
    .sort((a, b) => b.score - a.score);

  return postProcessPassages(query, candidates, limit, "semantic", perDocLimit);
}

function resolveAllowedUuids(
  store: VectorStore | null,
  uuid?: string,
  citationKey?: string,
): Set<string> | undefined {
  if (!store) return undefined;
  if (uuid) return new Set([uuid]);
  if (!citationKey) return undefined;

  const out = new Set<string>();
  for (const chunk of store.getAllChunks()) {
    if (chunk.citationKey === citationKey) out.add(chunk.uuid);
  }
  return out.size > 0 ? out : new Set<string>();
}

function getAllScopedPassages(
  store: VectorStore,
  allowedUuids?: Set<string>,
  database?: string,
): InternalPassageResult[] {
  const chunks = store
    .getAllChunks()
    .filter(
      (c) =>
        (!database || c.database === database) &&
        (!allowedUuids || allowedUuids.has(c.uuid)),
    )
    .sort((a, b) => {
      if (a.uuid !== b.uuid) return a.uuid.localeCompare(b.uuid);
      return a.chunkIndex - b.chunkIndex;
    });

  const byUuid = new Map<string, typeof chunks>();
  for (const c of chunks) {
    const arr = byUuid.get(c.uuid) ?? [];
    arr.push(c);
    byUuid.set(c.uuid, arr);
  }

  const results: InternalPassageResult[] = [];
  for (const docChunks of byUuid.values()) {
    const runs: (typeof docChunks)[] = [];
    let current: typeof docChunks = [];
    for (const c of docChunks) {
      if (
        current.length === 0 ||
        c.chunkIndex === current[current.length - 1].chunkIndex + 1
      ) {
        current.push(c);
      } else {
        runs.push(current);
        current = [c];
      }
    }
    if (current.length > 0) runs.push(current);

    for (const run of runs) {
      const mergedText = mergePassageTexts(
        run.map((c) => c.text),
        DEFAULT_CHUNK_OVERLAP_CHARS,
      );
      const first = run[0];
      const last = run[run.length - 1];
      results.push({
        uuid: first.uuid,
        docName: first.docName,
        database: first.database,
        text: mergedText,
        excerpt: mergedText,
        contextText: mergedText,
        passageIndex: first.chunkIndex,
        passageIndexStart: first.chunkIndex,
        passageIndexEnd: last.chunkIndex,
        mergedPassageCount: run.length,
        score: 1,
        documentScore: 1,
        passageScore: 1,
        citationKey: first.citationKey,
        mode: "keyword",
      });
    }
  }

  return results.sort((a, b) => {
    if (a.uuid !== b.uuid) return a.uuid.localeCompare(b.uuid);
    return a.passageIndex - b.passageIndex;
  });
}

function computeKeywordSignals(
  query: string,
  text: string,
): { score: number; hasDirectMatch: boolean } {
  const normalizedQuery = normalizeForMatch(query);
  const normalizedText = normalizeForMatch(text);
  if (!normalizedQuery || !normalizedText) {
    return { score: 0, hasDirectMatch: false };
  }

  const exactMatch = normalizedText.includes(normalizedQuery);
  const phrases = extractMatchPhrases(normalizedQuery);
  let bestPhraseLength = 0;
  let matchedPhraseCount = 0;
  let totalOccurrences = 0;

  for (const phrase of phrases) {
    const count = countOccurrences(normalizedText, phrase);
    if (count === 0) continue;
    matchedPhraseCount++;
    totalOccurrences += count;
    if (phrase.length > bestPhraseLength) bestPhraseLength = phrase.length;
  }

  const tokens = tokenizeQuery(normalizedQuery);
  const matchedTokens = tokens.filter((token) => normalizedText.includes(token)).length;

  if (!exactMatch && matchedPhraseCount === 0 && matchedTokens === 0) {
    return { score: 0, hasDirectMatch: false };
  }

  let score = 0;
  if (exactMatch) score += 0.6;

  if (bestPhraseLength >= 6) score += 0.22;
  else if (bestPhraseLength >= 4) score += 0.16;
  else if (bestPhraseLength >= 3) score += 0.12;
  else if (bestPhraseLength >= 2) score += 0.08;

  score += Math.min(0.15, matchedPhraseCount * 0.03);
  if (tokens.length > 0) {
    score += (matchedTokens / tokens.length) * 0.1;
  }
  if (totalOccurrences > 1) {
    score += Math.min(0.08, (totalOccurrences - 1) * 0.02);
  }

  return {
    score: Math.min(1, score),
    hasDirectMatch: exactMatch || bestPhraseLength >= 3,
  };
}

function postProcessPassages(
  query: string,
  candidates: CandidatePassage[],
  limit: number,
  mode: PassageSearchMode,
  perDocLimit?: number,
): InternalPassageResult[] {
  const byDoc = new Map<string, Map<number, CandidatePassage>>();
  for (const candidate of candidates) {
    let docMap = byDoc.get(candidate.uuid);
    if (!docMap) {
      docMap = new Map<number, CandidatePassage>();
      byDoc.set(candidate.uuid, docMap);
    }
    docMap.set(candidate.passageIndex, candidate);
  }

  const usedIndexes = new Map<string, Set<number>>();
  const countsByDoc = new Map<string, number>();
  const out: InternalPassageResult[] = [];

  for (const candidate of candidates) {
    if (out.length >= limit) break;

    const usedForDoc = getOrCreateSet(usedIndexes, candidate.uuid);
    if (usedForDoc.has(candidate.passageIndex)) continue;

    if (typeof perDocLimit === "number") {
      const countForDoc = countsByDoc.get(candidate.uuid) || 0;
      if (countForDoc >= perDocLimit) continue;
    }

    const docMap = byDoc.get(candidate.uuid);
    if (!docMap) continue;

    const merged = mergeAdjacentPassages(query, candidate, docMap, usedForDoc, mode);
    for (let i = merged.passageIndexStart; i <= merged.passageIndexEnd; i++) {
      usedForDoc.add(i);
    }
    countsByDoc.set(candidate.uuid, (countsByDoc.get(candidate.uuid) || 0) + 1);
    out.push(merged);
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function mergeAdjacentPassages(
  query: string,
  seed: CandidatePassage,
  docMap: Map<number, CandidatePassage>,
  usedForDoc: Set<number>,
  mode: PassageSearchMode,
): InternalPassageResult {
  let start = seed.passageIndex;
  let end = seed.passageIndex;
  let mergedCount = 1;

  while (mergedCount < DEFAULT_MAX_MERGED_PASSAGES) {
    const left = docMap.get(start - 1);
    if (!left || usedForDoc.has(start - 1)) break;
    if (!shouldMergePassage(seed, left)) break;
    start--;
    mergedCount++;
  }

  while (mergedCount < DEFAULT_MAX_MERGED_PASSAGES) {
    const right = docMap.get(end + 1);
    if (!right || usedForDoc.has(end + 1)) break;
    if (!shouldMergePassage(seed, right)) break;
    end++;
    mergedCount++;
  }

  const pieces: CandidatePassage[] = [];
  for (let i = start; i <= end; i++) {
    const piece = docMap.get(i);
    if (piece) pieces.push(piece);
  }

  const mergedText = mergePassageTexts(
    pieces.map((p) => p.text),
    mode === "semantic" ? DEFAULT_CHUNK_OVERLAP_CHARS : 0,
  );
  const excerpt = createExcerpt(mergedText, query);
  const best = pieces.reduce(
    (acc, cur) => (cur.score > acc.score ? cur : acc),
    pieces[0],
  );

  return {
    uuid: best.uuid,
    docName: best.docName,
    database: best.database,
    text: mergedText,
    excerpt,
    contextText: mergedText,
    passageIndex: start,
    passageIndexStart: start,
    passageIndexEnd: end,
    mergedPassageCount: pieces.length,
    score: Math.min(1, best.score + Math.min(0.03, (pieces.length - 1) * 0.015)),
    documentScore: best.documentScore,
    passageScore: Math.max(...pieces.map((p) => p.passageScore)),
    citationKey: best.citationKey,
    mode,
  };
}

function shouldMergePassage(
  seed: CandidatePassage,
  candidate: CandidatePassage,
): boolean {
  const scoreCloseEnough = seed.score - candidate.score <= MERGE_SCORE_GAP;
  return scoreCloseEnough || candidate.hasDirectMatch;
}

function mergePassageTexts(texts: string[], overlapChars: number): string {
  if (texts.length === 0) return "";
  let merged = texts[0];
  for (let i = 1; i < texts.length; i++) {
    if (overlapChars <= 0) {
      merged = `${merged}\n\n${texts[i]}`;
      continue;
    }
    merged = mergeAdjacentTexts(merged, texts[i], overlapChars);
  }
  return merged;
}

function mergeAdjacentTexts(left: string, right: string, overlapChars: number): string {
  const maxOverlap = Math.min(overlapChars + 8, left.length, right.length);
  for (let len = maxOverlap; len >= 20; len--) {
    if (left.slice(-len) === right.slice(0, len)) {
      return left + right.slice(len);
    }
  }
  return `${left}\n${right}`;
}

function createExcerpt(text: string, query: string): string {
  const target = DEFAULT_EXCERPT_TARGET_CHARS;
  if (text.length <= target) return text.trim();

  const match = findBestMatch(text, query);
  if (match) {
    const sentenceExcerpt = createSentenceExcerpt(text, match.index, target);
    if (sentenceExcerpt) return sentenceExcerpt;
  }

  const halfWindow = Math.floor(target / 2);

  let start = 0;
  let end = Math.min(text.length, target);
  if (match) {
    const focus = match.index + Math.floor(match.length / 2);
    start = Math.max(0, focus - halfWindow);
    end = Math.min(text.length, start + target);
    start = Math.max(0, end - target);
  }

  start = moveStartToBoundary(text, start);
  end = moveEndToBoundary(text, end);
  if (end <= start) {
    start = Math.max(0, start);
    end = Math.min(text.length, start + target);
  }

  let excerpt = text.slice(start, end).trim();
  if (start > 0) excerpt = `...${excerpt}`;
  if (end < text.length) excerpt = `${excerpt}...`;
  return excerpt;
}

function createSentenceExcerpt(
  text: string,
  matchIndex: number,
  target: number,
): string | null {
  const sentences = splitSentencesWithOffsets(text);
  if (sentences.length === 0) return null;

  const currentIndex = sentences.findIndex(
    (sentence) => matchIndex >= sentence.start && matchIndex < sentence.end,
  );
  if (currentIndex < 0) return null;

  const parts = [sentences[currentIndex].text.trim()];
  let start = sentences[currentIndex].start;
  let end = sentences[currentIndex].end;

  if (
    parts[0].length < target * 0.55 &&
    currentIndex + 1 < sentences.length &&
    parts[0].length + sentences[currentIndex + 1].text.length <= target * 1.2
  ) {
    parts.push(sentences[currentIndex + 1].text.trim());
    end = sentences[currentIndex + 1].end;
  }

  if (
    parts.join(" ").length < target * 0.45 &&
    currentIndex > 0 &&
    sentences[currentIndex - 1].text.length + parts.join(" ").length <= target * 1.2
  ) {
    parts.unshift(sentences[currentIndex - 1].text.trim());
    start = sentences[currentIndex - 1].start;
  }

  let excerpt = parts.join(" ").replace(/\s+/g, " ").trim();
  if (start > 0) excerpt = `...${excerpt}`;
  if (end < text.length) excerpt = `${excerpt}...`;
  return excerpt;
}

function splitSentencesWithOffsets(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^。！？.!?;\n]+[。！？.!?;\n]?/gu;
  for (const match of text.matchAll(pattern)) {
    const sentence = match[0];
    const start = match.index ?? 0;
    const end = start + sentence.length;
    if (sentence.trim()) {
      out.push({ text: sentence, start, end });
    }
  }
  return out;
}

function findBestMatch(
  text: string,
  query: string,
): { index: number; length: number } | null {
  const normalizedText = normalizeForMatch(text);
  const phrases = extractMatchPhrases(normalizeForMatch(query)).sort(
    (a, b) => b.length - a.length,
  );

  for (const phrase of phrases) {
    const idx = normalizedText.indexOf(phrase);
    if (idx >= 0) {
      return { index: idx, length: phrase.length };
    }
  }
  return null;
}

function moveStartToBoundary(text: string, start: number): number {
  const min = Math.max(0, start - DEFAULT_EXCERPT_BOUNDARY_SCAN_CHARS);
  for (let i = start - 1; i >= min; i--) {
    if (isBoundaryChar(text[i])) return i + 1;
  }
  return start;
}

function moveEndToBoundary(text: string, end: number): number {
  const max = Math.min(text.length, end + DEFAULT_EXCERPT_BOUNDARY_SCAN_CHARS);
  for (let i = end; i < max; i++) {
    if (isBoundaryChar(text[i])) return i + 1;
  }
  return end;
}

function isBoundaryChar(char: string | undefined): boolean {
  return Boolean(char && /[。！？；.!?;\n]/u.test(char));
}

function normalizeSemanticScore(score: number): number {
  return Math.max(0, Math.min(1, (score - 0.4) / 0.6));
}

function extractMatchPhrases(normalizedQuery: string): string[] {
  const phrases = new Set<string>();
  if (!normalizedQuery) return [];

  phrases.add(normalizedQuery);

  const tokens = tokenizeQuery(normalizedQuery);
  for (const token of tokens) {
    phrases.add(token);

    if (/^\p{Script=Han}+$/u.test(token) && token.length >= 4) {
      for (const len of [3, 4, 5, 6]) {
        if (token.length < len) continue;
        for (let i = 0; i <= token.length - len; i++) {
          phrases.add(token.slice(i, i + len));
        }
      }
    }
  }

  return [...phrases];
}

function tokenizeQuery(normalizedQuery: string): string[] {
  return normalizedQuery
    .split(/[^\p{L}\p{N}\p{Script=Han}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function normalizeForMatch(input: string): string {
  return input.trim().normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function countOccurrences(text: string, phrase: string): number {
  if (!phrase) return 0;
  let count = 0;
  let idx = 0;
  while (idx <= text.length - phrase.length) {
    const found = text.indexOf(phrase, idx);
    if (found < 0) break;
    count++;
    idx = found + phrase.length;
  }
  return count;
}

function getOrCreateSet(map: Map<string, Set<number>>, key: string): Set<number> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<number>();
  map.set(key, created);
  return created;
}

const DEFAULT_PER_DOC_LIMIT = 2;

function normalizePerDocLimit(input?: number): number | undefined {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return undefined; // 0 or negative = no limit
    return Math.floor(input);
  }
  return DEFAULT_PER_DOC_LIMIT;
}

function toPublicPassageResults(
  results: InternalPassageResult[],
  includeContext: boolean,
  debug: boolean,
): PassageSearchResult[] {
  return results.map((result) => ({
    uuid: result.uuid,
    docName: result.docName,
    excerpt: result.excerpt,
    score: result.score,
    citationKey: result.citationKey,
    ...(includeContext ? { contextText: result.contextText } : {}),
    ...(debug
      ? {
          database: result.database,
          passageIndex: result.passageIndex,
          passageIndexStart: result.passageIndexStart,
          passageIndexEnd: result.passageIndexEnd,
          mergedPassageCount: result.mergedPassageCount,
          documentScore: result.documentScore,
          passageScore: result.passageScore,
          mode: result.mode,
        }
      : {}),
  }));
}
