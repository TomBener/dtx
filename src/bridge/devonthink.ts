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

// ─── Read-Only Operations ────────────────────────────────

export async function searchDocuments(query: string, database?: string, limit?: number) {
  return runJXAJSON(searchScript(query, database, limit));
}

export async function getDocumentContent(uuid: string, maxLength?: number) {
  // Support CONTENT_MAX_LENGTH env var for custom default truncation length
  const effectiveMax = maxLength ?? (Number(process.env.CONTENT_MAX_LENGTH) || undefined);
  return runJXAJSON(getRecordContentScript(uuid, effectiveMax));
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
