#!/usr/bin/env node
/**
 * cli.ts — Non-interactive CLI for AI agents
 *
 * Default output is JSON. Progress logs are written to stderr.
 */

import * as dt from "./bridge/devonthink.js";
import { buildIndex, getIndexStatus } from "./rag/index-manager.js";
import { resetStoreCache, searchPassages } from "./rag/passage-search.js";
import { getIndexDir } from "./rag/store.js";

const DEFAULT_GROUP_UUID = "33203673-B7E2-4F3F-9D87-6E83EB4781EA";

type FlagValue = string | boolean;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

interface JsonOk {
  ok: true;
  data: unknown;
  meta: Record<string, unknown>;
}

interface JsonErr {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: Record<string, unknown>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx >= 0) {
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      flags[key] = value;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[trimmed] = true;
      continue;
    }

    flags[trimmed] = next;
    i++;
  }

  return { positionals, flags };
}

function getStringFlag(
  flags: Record<string, FlagValue>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = flags[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function getBoolFlag(flags: Record<string, FlagValue>, ...keys: string[]): boolean {
  for (const key of keys) {
    const v = flags[key];
    if (v === undefined) continue;
    if (v === true) return true;
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      if (["1", "true", "yes", "on"].includes(lower)) return true;
      if (["0", "false", "no", "off"].includes(lower)) return false;
      return true;
    }
  }
  return false;
}

function getNumberFlag(
  flags: Record<string, FlagValue>,
  ...keys: string[]
): number | undefined {
  const raw = getStringFlag(flags, ...keys);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function toIndexDir(flags: Record<string, FlagValue>): string {
  const fromCli = getStringFlag(flags, "index-dir");
  return getIndexDir(fromCli);
}

function emitOk(data: unknown, meta: Record<string, unknown> = {}): never {
  const body: JsonOk = { ok: true, data, meta };
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

function emitError(
  code: string,
  message: string,
  details?: unknown,
  meta: Record<string, unknown> = {},
): never {
  const body: JsonErr = { ok: false, error: { code, message, details }, meta };
  console.log(JSON.stringify(body, null, 2));
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage:
  dtx databases list
  dtx groups list [--uuid <groupUuid>] [--limit <n>]
  dtx search documents --query "<q>" [--database <name>] [--limit <n>]
  dtx search passages --query "<q>" [--database <name>] [--limit <n>] [--per-doc <n>] [--mode <keyword|semantic>] [--context] [--debug] [--index-dir <path>] [--citation-key <key>]
  dtx documents get --uuid <recordUuid> [--max-length <n>]
  dtx documents related --uuid <recordUuid> [--limit <n>]
  dtx index build [--database <name>] [--group <uuid>] [--include-md] [--force] [--bib <path>] [--index-dir <path>] [--content-max-length <n>]
  dtx index status [--index-dir <path>]

Notes:
  - Default output is JSON (stdout)
  - Progress logs are emitted on stderr
  - Default group for "dtx index build": ${DEFAULT_GROUP_UUID}
  - Markdown files are excluded by default; use --include-md to include them
  - content-max-length default: no truncation (set a positive number to cap content)
  - Index directory priority: --index-dir > DT_INDEX_DIR > ~/Library/CloudStorage/Dropbox/bibliography/dtx-index
`);
}

async function run(): Promise<never> {
  const startedAt = Date.now();
  const parsed = parseArgs(process.argv.slice(2));
  const [namespace, action, ...rest] = parsed.positionals;

  if (!namespace || namespace === "help" || getBoolFlag(parsed.flags, "help", "h")) {
    printHelp();
    process.exit(0);
  }

  const commonMeta = (): Record<string, unknown> => ({
    elapsedMs: Date.now() - startedAt,
  });

  try {
    // ─── databases list ───
    if (namespace === "databases" && action === "list") {
      const data = await dt.listDatabases();
      emitOk(data, commonMeta());
    }

    // ─── groups list ───
    if (namespace === "groups" && action === "list") {
      const uuid = getStringFlag(parsed.flags, "uuid") || rest[0];
      const limit = getNumberFlag(parsed.flags, "limit");
      const data = await dt.listGroupContents(uuid, limit);
      emitOk(data, commonMeta());
    }

    // ─── search documents ───
    if (namespace === "search" && action === "documents") {
      const query = getStringFlag(parsed.flags, "query") || rest.join(" ");
      if (!query) {
        emitError("MISSING_ARGUMENT", 'Missing required argument: --query "<text>"');
      }
      const database = getStringFlag(parsed.flags, "database");
      const limit = getNumberFlag(parsed.flags, "limit");
      const data = await dt.searchDocuments(query, database, limit);
      emitOk(data, commonMeta());
    }

    // ─── documents get ───
    if (namespace === "documents" && action === "get") {
      const uuid = getStringFlag(parsed.flags, "uuid") || rest[0];
      if (!uuid) {
        emitError("MISSING_ARGUMENT", "Missing required argument: --uuid <recordUuid>");
      }
      const maxLength = getNumberFlag(parsed.flags, "max-length");
      const data = await dt.getDocumentContent(uuid, maxLength);
      emitOk(data, commonMeta());
    }

    if (namespace === "documents" && action === "related") {
      const uuid = getStringFlag(parsed.flags, "uuid") || rest[0];
      if (!uuid) {
        emitError("MISSING_ARGUMENT", "Missing required argument: --uuid <recordUuid>");
      }
      const limit = getNumberFlag(parsed.flags, "limit");
      const data = await dt.getRelatedDocuments(uuid, limit);
      emitOk(data, commonMeta());
    }

    // ─── index build/status ───
    if (namespace === "index" && action === "build") {
      const includeMd = getBoolFlag(parsed.flags, "include-md");
      const contentMaxLength = getNumberFlag(parsed.flags, "content-max-length");

      const indexDir = toIndexDir(parsed.flags);
      const stats = await buildIndex({
        database: getStringFlag(parsed.flags, "database"),
        groupUuid: getStringFlag(parsed.flags, "group") || DEFAULT_GROUP_UUID,
        bibliographyPath: getStringFlag(parsed.flags, "bib", "bibliography"),
        excludeMarkdown: !includeMd,
        force: getBoolFlag(parsed.flags, "force"),
        indexDir,
        contentMaxLength,
        onProgress: (msg) => console.error(msg),
      });
      resetStoreCache(indexDir);
      emitOk(stats, { ...commonMeta(), indexDir });
    }

    if (namespace === "index" && action === "status") {
      const indexDir = toIndexDir(parsed.flags);
      const status = getIndexStatus(indexDir);
      if (!status) {
        emitError("INDEX_NOT_FOUND", "No semantic index found", undefined, {
          ...commonMeta(),
          indexDir,
        });
      }
      emitOk(status, { ...commonMeta(), indexDir });
    }

    // ─── search passages ───
    if (namespace === "search" && action === "passages") {
      const query = getStringFlag(parsed.flags, "query") || rest.join(" ");
      const hasCitationKey = Boolean(getStringFlag(parsed.flags, "citation-key"));
      if (!query && !hasCitationKey) {
        emitError("MISSING_ARGUMENT", 'Missing required argument: --query "<text>"');
      }
      const limit = getNumberFlag(parsed.flags, "limit");
      const perDocLimit = getNumberFlag(parsed.flags, "per-doc", "perdoc");
      const indexDir = toIndexDir(parsed.flags);
      const mode = getStringFlag(parsed.flags, "mode");
      if (mode && mode !== "keyword" && mode !== "semantic") {
        emitError(
          "INVALID_ARGUMENT",
          'Invalid --mode. Expected "keyword" or "semantic".',
        );
      }
      const data = await searchPassages(query, limit, {
        database: getStringFlag(parsed.flags, "database"),
        indexDir,
        mode: mode as "keyword" | "semantic" | undefined,
        includeContext: getBoolFlag(parsed.flags, "context"),
        perDocLimit,
        debug: getBoolFlag(parsed.flags, "debug"),
        citationKey: getStringFlag(parsed.flags, "citation-key"),
      });
      emitOk(data, { ...commonMeta(), indexDir });
    }

    emitError(
      "UNKNOWN_COMMAND",
      `Unknown command: ${parsed.positionals.join(" ") || "(empty)"}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emitError("RUNTIME_ERROR", msg, undefined, commonMeta());
  }
}

run();
