/**
 * passage-search.ts — Passage-level search
 *
 * Default mode is keyword-first:
 *   1. Use DEVONthink keyword search to find candidate documents
 *   2. Extract and rank passages from those documents locally
 *
 * Semantic mode remains available as an option and queries the local vector index.
 */

import * as dt from "../bridge/devonthink.js";
import { getEmbedder } from "./embedder.js";
import { VectorStore, getIndexDir, indexExists } from "./store.js";

const storeCache = new Map<string, VectorStore>();

const DEFAULT_PASSAGE_MODE: PassageSearchMode = "keyword";
const DEFAULT_DOCUMENT_CANDIDATES = 20;
const DEFAULT_LOCAL_SCOPE_SCAN_LIMIT = 200;
const DEFAULT_PASSAGES_PER_DOCUMENT = 1;
const DEFAULT_MAX_MERGED_PASSAGES = 2;
const DEFAULT_PASSAGE_MAX_CHARS = 700;
const DEFAULT_PASSAGE_MIN_CHARS = 80;
const DEFAULT_EXCERPT_TARGET_CHARS = 280;
const DEFAULT_EXCERPT_BOUNDARY_SCAN_CHARS = 80;
const DEFAULT_CHUNK_OVERLAP_CHARS = Number(process.env.CHUNK_OVERLAP_CHARS) || 120;
const DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER = 20;
const DEFAULT_SEMANTIC_CANDIDATE_FLOOR = 100;
const MERGE_SCORE_GAP = 0.12;

export type PassageSearchMode = "keyword" | "semantic";

export interface PassageSearchOptions {
  database?: string;
  indexDir?: string;
  mode?: PassageSearchMode;
}

export interface PassageSearchResult {
  uuid: string;
  docName: string;
  database: string;
  text: string;
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

interface DocumentCandidate {
  uuid: string;
  docName: string;
  database: string;
  documentScore: number;
  citationKey?: string;
}

interface PassageUnit {
  passageIndex: number;
  text: string;
}

interface CandidatePassage extends PassageSearchResult {
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
  mode: PassageSearchMode;
}> {
  const mode = options.mode || DEFAULT_PASSAGE_MODE;
  const store = getStore(options.indexDir);
  const indexAvailable = store !== null;

  if (mode === "semantic") {
    if (!store) {
      return { results: [], indexAvailable: false, mode };
    }
    const results = await searchSemanticPassages(query, limit, store);
    return { results, indexAvailable: true, mode };
  }

  const results = await searchKeywordPassages(query, limit, options.database, store);
  return { results, indexAvailable, mode };
}

async function searchKeywordPassages(
  query: string,
  limit: number,
  database: string | undefined,
  store: VectorStore | null,
): Promise<PassageSearchResult[]> {
  const scopeUuids = store ? new Set(Object.keys(store.getMeta().documents)) : null;
  let documentCandidates = await collectKeywordDocuments(query, database, limit, scopeUuids);
  if (documentCandidates.length === 0 && store && scopeUuids) {
    documentCandidates = await collectScopedFallbackDocuments(query, store, scopeUuids);
  }
  const candidatePassages: CandidatePassage[] = [];

  for (const doc of documentCandidates) {
    const raw = (await dt.getDocumentContent(doc.uuid)) as { content?: string; error?: string };
    if (!raw || raw.error || !raw.content) continue;

    const units = splitIntoPassageUnits(raw.content);
    if (units.length === 0) continue;

    for (const unit of units) {
      const { score, passageScore, hasDirectMatch } = scoreKeywordPassage(
        query,
        unit.text,
        doc.documentScore,
      );
      if (score <= 0) continue;

      candidatePassages.push({
        uuid: doc.uuid,
        docName: doc.docName,
        database: doc.database,
        text: unit.text,
        passageIndex: unit.passageIndex,
        passageIndexStart: unit.passageIndex,
        passageIndexEnd: unit.passageIndex,
        mergedPassageCount: 1,
        score,
        documentScore: doc.documentScore,
        passageScore,
        citationKey: doc.citationKey,
        mode: "keyword",
        hasDirectMatch,
      });
    }
  }

  candidatePassages.sort((a, b) => b.score - a.score);
  return postProcessPassages(query, candidatePassages, limit, "keyword");
}

async function collectScopedFallbackDocuments(
  query: string,
  store: VectorStore,
  scopeUuids: Set<string>,
): Promise<DocumentCandidate[]> {
  const uuids = [...scopeUuids].slice(0, DEFAULT_LOCAL_SCOPE_SCAN_LIMIT);
  const docs: DocumentCandidate[] = [];

  for (const uuid of uuids) {
    const raw = (await dt.getDocumentContent(uuid)) as { name?: string; content?: string; error?: string };
    if (!raw || raw.error || !raw.content) continue;

    const titleScore = computeKeywordSignals(query, raw.name || "").score;
    const contentScore = computeKeywordSignals(query, raw.content).score;
    const documentScore = Math.max(titleScore, contentScore * 0.9);
    if (documentScore <= 0) continue;

    docs.push({
      uuid,
      docName: raw.name || store.getMeta().documents[uuid]?.name || uuid,
      database: store.getDatabaseByUuid(uuid) || "",
      documentScore,
      citationKey: store.getCitationKeyByUuid(uuid),
    });
  }

  return docs.sort((a, b) => b.documentScore - a.documentScore);
}

async function searchSemanticPassages(
  query: string,
  limit: number,
  store: VectorStore,
): Promise<PassageSearchResult[]> {
  const embedder = getEmbedder();
  const queryVector = await embedder.embedQuery(query);
  const candidatePoolSize = Math.max(
    limit * DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER,
    DEFAULT_SEMANTIC_CANDIDATE_FLOOR,
  );

  const candidates = store
    .search(queryVector, candidatePoolSize)
    .map((r) => {
      const lexical = computeKeywordSignals(query, r.text);
      const semanticScore = normalizeSemanticScore(r.score);
      return {
        uuid: r.uuid,
        docName: r.docName,
        database: r.database,
        text: r.text,
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

  return postProcessPassages(query, candidates, limit, "semantic");
}

async function collectKeywordDocuments(
  query: string,
  database: string | undefined,
  limit: number,
  scopeUuids: Set<string> | null,
): Promise<DocumentCandidate[]> {
  const target = scopeUuids
    ? Math.max(limit * 20, 100)
    : Math.max(limit * 4, DEFAULT_DOCUMENT_CANDIDATES);
  const byUuid = new Map<string, DocumentCandidate>();
  const queryVariants = buildDocumentQueryVariants(query);

  for (const variant of queryVariants) {
    let results: Array<{
      uuid: string;
      name: string;
      score: number;
      database: string;
    }> = [];

    try {
      const raw = await dt.searchDocuments(variant, database, target);
      if (Array.isArray(raw)) {
        results = raw as Array<{
          uuid: string;
          name: string;
          score: number;
          database: string;
        }>;
      }
    } catch {
      continue;
    }

    for (const r of results) {
      if (scopeUuids && !scopeUuids.has(r.uuid)) continue;
      const documentScore = normalizeDocumentScore(r.score);
      const existing = byUuid.get(r.uuid);
      if (!existing || documentScore > existing.documentScore) {
        byUuid.set(r.uuid, {
          uuid: r.uuid,
          docName: r.name,
          database: r.database,
          documentScore,
        });
      }
    }

    if (byUuid.size >= target) break;
  }

  return [...byUuid.values()]
    .sort((a, b) => b.documentScore - a.documentScore)
    .slice(0, target);
}

function buildDocumentQueryVariants(query: string): string[] {
  const out = new Set<string>();
  const normalized = query.trim().normalize("NFKC");
  if (!normalized) return [];

  out.add(normalized);
  if (/\s/.test(normalized)) {
    out.add(`"${normalized}"`);
  }

  const tokens = normalized
    .split(/[^\p{L}\p{N}\p{Script=Han}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  for (const token of tokens) {
    out.add(token);
    if (/^\p{Script=Han}+$/u.test(token) && token.length >= 4) {
      if (token.length >= 3) out.add(token.slice(0, 3));
      if (token.length >= 4) out.add(token.slice(0, 4));

      for (const len of [3, 4]) {
        if (token.length < len) continue;
        for (let i = 0; i <= token.length - len; i++) {
          out.add(token.slice(i, i + len));
        }
      }
    }
  }

  return [...out].slice(0, 12);
}

function splitIntoPassageUnits(content: string): PassageUnit[] {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const units: PassageUnit[] = [];
  let unitIndex = 0;

  for (const paragraph of paragraphs) {
    if (paragraph.length < DEFAULT_PASSAGE_MIN_CHARS && units.length > 0) {
      const prev = units[units.length - 1];
      if (prev.text.length + paragraph.length + 2 <= DEFAULT_PASSAGE_MAX_CHARS) {
        prev.text += `\n\n${paragraph}`;
        continue;
      }
    }

    if (paragraph.length <= DEFAULT_PASSAGE_MAX_CHARS) {
      units.push({ passageIndex: unitIndex++, text: paragraph });
      continue;
    }

    for (const segment of splitLongPassage(paragraph)) {
      if (segment.length < DEFAULT_PASSAGE_MIN_CHARS) continue;
      units.push({ passageIndex: unitIndex++, text: segment });
    }
  }

  return units;
}

function splitLongPassage(text: string): string[] {
  const sentences = text.split(/(?<=[.!?。！？；\n])\s+/);
  const out: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 1 <= DEFAULT_PASSAGE_MAX_CHARS) {
      current += (current ? " " : "") + trimmed;
      continue;
    }

    if (current) out.push(current);
    if (trimmed.length <= DEFAULT_PASSAGE_MAX_CHARS) {
      current = trimmed;
      continue;
    }

    for (let i = 0; i < trimmed.length; i += DEFAULT_PASSAGE_MAX_CHARS) {
      out.push(trimmed.slice(i, i + DEFAULT_PASSAGE_MAX_CHARS));
    }
    current = "";
  }

  if (current) out.push(current);
  return out;
}

function scoreKeywordPassage(
  query: string,
  text: string,
  documentScore: number,
): { score: number; passageScore: number; hasDirectMatch: boolean } {
  const lexical = computeKeywordSignals(query, text);
  if (lexical.score <= 0) {
    return { score: 0, passageScore: 0, hasDirectMatch: false };
  }

  const score = Math.min(1, lexical.score + documentScore * 0.18);
  return { score, passageScore: lexical.score, hasDirectMatch: lexical.hasDirectMatch };
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
): PassageSearchResult[] {
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
  const out: PassageSearchResult[] = [];

  for (const candidate of candidates) {
    if (out.length >= limit) break;

    const usedForDoc = getOrCreateSet(usedIndexes, candidate.uuid);
    if (usedForDoc.has(candidate.passageIndex)) continue;

    const countForDoc = countsByDoc.get(candidate.uuid) || 0;
    if (countForDoc >= DEFAULT_PASSAGES_PER_DOCUMENT) continue;

    const docMap = byDoc.get(candidate.uuid);
    if (!docMap) continue;

    const merged = mergeAdjacentPassages(query, candidate, docMap, usedForDoc, mode);
    for (let i = merged.passageIndexStart; i <= merged.passageIndexEnd; i++) {
      usedForDoc.add(i);
    }
    countsByDoc.set(candidate.uuid, countForDoc + 1);
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
): PassageSearchResult {
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
  const best = pieces.reduce((acc, cur) => (cur.score > acc.score ? cur : acc), pieces[0]);

  return {
    uuid: best.uuid,
    docName: best.docName,
    database: best.database,
    text: createExcerpt(mergedText, query),
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

function shouldMergePassage(seed: CandidatePassage, candidate: CandidatePassage): boolean {
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

function findBestMatch(text: string, query: string): { index: number; length: number } | null {
  const normalizedText = normalizeForMatch(text);
  const phrases = extractMatchPhrases(normalizeForMatch(query)).sort((a, b) => b.length - a.length);

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

function normalizeDocumentScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 1) return Math.max(0, Math.min(1, score));
  return Math.max(0, Math.min(1, score / 100));
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
