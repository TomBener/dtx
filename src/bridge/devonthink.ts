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
  type BibliographyMetadata,
  type CitationMapLoadResult,
} from "../rag/citation-map.js";

interface DocumentSearchResult {
  uuid: string;
  name: string;
  score: number;
  recordType: string;
  tags: string[];
  location: string;
  database: string;
  modificationDate: string;
  path?: string;
  citationKey?: string;
  author?: string;
  year?: string;
  abstract?: string;
}

interface SearchDocumentOptions {
  bibliographyPath?: string;
}

interface DocumentContentResult {
  uuid: string;
  name: string;
  recordType: string;
  contentFormat: string;
  content: string;
  truncated: boolean;
  totalLength: number;
  wordCount: number;
  path?: string;
  citationKey?: string;
  author?: string;
  year?: string;
  abstract?: string;
}

function enrichWithBibliography<T extends { path?: string; citationKey?: string }>(
  result: T,
  bibliography: CitationMapLoadResult | null,
): T & {
  citationKey?: string;
  author?: string;
  year?: string;
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
    abstract: metadata?.abstract,
  };
}

// ─── Read-Only Operations ────────────────────────────────

export async function searchDocuments(
  query: string,
  database?: string,
  limit?: number,
  options: SearchDocumentOptions = {},
) {
  const results = await runJXAJSON<DocumentSearchResult[]>(searchScript(query, database, limit));
  const bibliography = loadCitationMap(options.bibliographyPath);

  return results.map((result) => enrichWithBibliography(result, bibliography));
}

export async function getDocumentContent(uuid: string, maxLength?: number, bibliographyPath?: string) {
  // Support CONTENT_MAX_LENGTH env var for custom default truncation length
  const effectiveMax = maxLength ?? (Number(process.env.CONTENT_MAX_LENGTH) || undefined);
  const data = await runJXAJSON<DocumentContentResult>(getRecordContentScript(uuid, effectiveMax));
  return enrichWithBibliography(data, loadCitationMap(bibliographyPath));
}

export async function getDocumentContentByCitationKey(
  citationKey: string,
  maxLength?: number,
  bibliographyPath?: string,
) {
  const bibliography = loadCitationMap(bibliographyPath);
  const paths = getPathsForCitationKey(bibliography?.pathsByCitationKey ?? null, citationKey);
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
        ...content,
        citationKey,
      };
    }
  }

  const metadata = getMetadataForCitationKey(bibliography?.metadataByCitationKey ?? null, citationKey);
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
  return runJXAJSON(getRelatedScript(uuid, limit));
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
