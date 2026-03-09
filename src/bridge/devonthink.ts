/**
 * devonthink.ts — DEVONthink high-level API (read-only)
 *
 * Each method corresponds to an Agent read-only tool.
 * Internally builds JXA scripts → calls executor → parses JSON response.
 *
 * Note: This module is strictly read-only. No methods that modify DEVONthink data are provided.
 */

import { runJXAJSON } from "./executor.js";
import { searchScript, getRelatedScript } from "./scripts/search.js";
import { getRecordContentScript } from "./scripts/records.js";
import {
  listDatabasesScript,
  listGroupContentsScript,
  listAllRecordsScript,
} from "./scripts/databases.js";
import {
  getMetadataForCitationKey,
  getMetadataForPath,
  getPathsForCitationKey,
  getRecordStemFromPath,
  loadCitationMap,
  resolveCitationKey,
  type CitationMapLoadResult,
} from "../rag/citation-map.js";

interface RawDocumentSearchResult {
  uuid: string;
  score: number;
  recordType: string;
  tags?: string[];
  modificationDate: string;
  path?: string;
}

interface DocumentSearchResult {
  citationKey?: string;
  author?: string;
  year?: string;
  title?: string;
  publicationType?: string;
  abstract?: string;
  uuid: string;
  score: number;
  fileType: string;
  modificationDate: string;
  path?: string;
  tags?: string[];
}

interface SearchDocumentOptions {
  bibliographyPath?: string;
  includeAbstract?: boolean;
  groupUuid?: string;
}

interface RawDocumentContentResult {
  uuid: string;
  recordType: string;
  contentFormat: string;
  content: string;
  truncated: boolean;
  totalLength: number;
  wordCount: number;
  path?: string;
}

interface DocumentContentResult {
  citationKey?: string;
  author?: string;
  year?: string;
  title?: string;
  publicationType?: string;
  abstract?: string;
  uuid: string;
  fileType: string;
  contentFormat: string;
  content: string;
  truncated: boolean;
  totalLength: number;
  wordCount: number;
  path?: string;
}

function enrichWithBibliography<T extends { path?: string; citationKey?: string }>(
  result: T,
  bibliography: CitationMapLoadResult | null,
  options: { includeAbstract?: boolean } = {},
): T & {
  citationKey?: string;
  author?: string;
  year?: string;
  title?: string;
  publicationType?: string;
  abstract?: string;
} {
  const citationMap = bibliography?.map ?? null;
  const metadataByPath = bibliography?.metadataByPath ?? null;
  const citationKey = result.citationKey || resolveCitationKey(citationMap, result.path);
  const metadata =
    getMetadataForPath(metadataByPath, result.path) ||
    getMetadataForCitationKey(bibliography?.metadataByCitationKey ?? null, citationKey);

  return {
    ...result,
    citationKey: citationKey || metadata?.citationKey,
    author: metadata?.author,
    year: metadata?.year,
    title: metadata?.title,
    publicationType: metadata?.publicationType,
    ...(options.includeAbstract ? { abstract: metadata?.abstract } : {}),
  };
}

function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

function formatDocumentSearchResult(
  result: RawDocumentSearchResult & {
    citationKey?: string;
    author?: string;
    year?: string;
    title?: string;
    publicationType?: string;
    abstract?: string;
  },
  options: { includeAbstract?: boolean } = {},
): DocumentSearchResult {
  return {
    ...(result.citationKey ? { citationKey: result.citationKey } : {}),
    ...(result.author ? { author: result.author } : {}),
    ...(result.year ? { year: result.year } : {}),
    ...(result.title ? { title: result.title } : {}),
    ...(result.publicationType ? { publicationType: result.publicationType } : {}),
    ...(options.includeAbstract && result.abstract ? { abstract: result.abstract } : {}),
    uuid: result.uuid,
    score: roundScore(result.score),
    fileType: result.recordType,
    modificationDate: result.modificationDate,
    ...(result.path ? { path: result.path } : {}),
    ...(result.tags && result.tags.length > 0 ? { tags: result.tags } : {}),
  };
}

function formatDocumentContentResult(
  result: RawDocumentContentResult & {
    citationKey?: string;
    author?: string;
    year?: string;
    title?: string;
    publicationType?: string;
    abstract?: string;
  },
): DocumentContentResult {
  return {
    ...(result.citationKey ? { citationKey: result.citationKey } : {}),
    ...(result.author ? { author: result.author } : {}),
    ...(result.year ? { year: result.year } : {}),
    ...(result.title ? { title: result.title } : {}),
    ...(result.publicationType ? { publicationType: result.publicationType } : {}),
    ...(result.abstract ? { abstract: result.abstract } : {}),
    uuid: result.uuid,
    fileType: result.recordType,
    contentFormat: result.contentFormat,
    content: result.content,
    truncated: result.truncated,
    totalLength: result.totalLength,
    wordCount: result.wordCount,
    ...(result.path ? { path: result.path } : {}),
  };
}

// ─── Read-Only Operations ────────────────────────────────

export async function searchDocuments(
  query: string,
  database?: string,
  limit?: number,
  options: SearchDocumentOptions = {},
) {
  const results = await runJXAJSON<RawDocumentSearchResult[]>(
    searchScript(query, database, options.groupUuid, limit),
  );
  const bibliography = loadCitationMap(options.bibliographyPath);

  return results.map((result) => {
    const enriched = enrichWithBibliography(result, bibliography, {
      includeAbstract: options.includeAbstract,
    });
    return formatDocumentSearchResult(enriched, {
      includeAbstract: options.includeAbstract,
    });
  });
}

export async function getDocumentContent(
  uuid: string,
  maxLength?: number,
  bibliographyPath?: string,
) {
  // Support CONTENT_MAX_LENGTH env var for custom default truncation length
  const effectiveMax = maxLength ?? (Number(process.env.CONTENT_MAX_LENGTH) || undefined);
  const data = await runJXAJSON<RawDocumentContentResult>(
    getRecordContentScript(uuid, effectiveMax),
  );
  const enriched = enrichWithBibliography(data, loadCitationMap(bibliographyPath), {
    includeAbstract: true,
  });
  return formatDocumentContentResult(enriched);
}

export async function getDocumentContentByCitationKey(
  citationKey: string,
  maxLength?: number,
  bibliographyPath?: string,
) {
  const bibliography = loadCitationMap(bibliographyPath);
  const paths = getPathsForCitationKey(
    bibliography?.pathsByCitationKey ?? null,
    citationKey,
  );
  if (paths.length === 0) {
    throw new Error(`Citation key not found in bibliography: ${citationKey}`);
  }

  for (const path of paths) {
    const stem = getRecordStemFromPath(path);
    const query = `name:"${stem.replace(/"/g, '\\"')}"`;
    const candidates = await searchDocuments(query, undefined, 20, { bibliographyPath });
    const match = candidates.find((candidate) => candidate.path === path);
    if (match?.uuid) {
      const content = await getDocumentContent(match.uuid, maxLength, bibliographyPath);
      return {
        citationKey,
        ...(content.author ? { author: content.author } : {}),
        ...(content.year ? { year: content.year } : {}),
        ...(content.title ? { title: content.title } : {}),
        ...(content.publicationType ? { publicationType: content.publicationType } : {}),
        ...(content.abstract ? { abstract: content.abstract } : {}),
        uuid: content.uuid,
        fileType: content.fileType,
        contentFormat: content.contentFormat,
        content: content.content,
        truncated: content.truncated,
        totalLength: content.totalLength,
        wordCount: content.wordCount,
        ...(content.path ? { path: content.path } : {}),
      };
    }
  }

  const metadata = getMetadataForCitationKey(
    bibliography?.metadataByCitationKey ?? null,
    citationKey,
  );
  throw new Error(
    `Citation key resolved in bibliography but matching DEVONthink record was not found: ${citationKey}${metadata?.author ? ` (${metadata.author})` : ""}`,
  );
}

export async function listDatabases() {
  return runJXAJSON(listDatabasesScript());
}

export async function listGroupContents(uuid?: string, limit?: number) {
  return runJXAJSON(listGroupContentsScript(uuid, limit));
}

export async function getRelatedDocuments(uuid: string, limit?: number) {
  const results = await runJXAJSON<
    Array<{
      uuid: string;
      score: number;
      recordType: string;
      tags?: string[];
    }>
  >(getRelatedScript(uuid, limit));

  return results.map((result) => ({
    uuid: result.uuid,
    score: roundScore(result.score),
    fileType: result.recordType,
    ...(result.tags && result.tags.length > 0 ? { tags: result.tags } : {}),
  }));
}

/**
 * List all document records in databases (metadata only, no content).
 * Used by the RAG indexer.
 *
 * Timeout notes:
 * - Full database scan default: 3 min
 * - Group subtree scan default: 10 min (can be slower for large nested groups)
 * - Override via LIST_ALL_RECORDS_TIMEOUT_MS
 */
export async function listAllRecords(database?: string, groupUuid?: string) {
  const timeoutFromEnv = Number(process.env.LIST_ALL_RECORDS_TIMEOUT_MS) || 0;
  const timeout = timeoutFromEnv > 0 ? timeoutFromEnv : groupUuid ? 600_000 : 180_000;
  return runJXAJSON<
    Array<{
      uuid: string;
      name: string;
      recordType: string;
      database: string;
      path?: string;
      modificationDate: string;
    }>
  >(listAllRecordsScript(database, groupUuid), timeout);
}
