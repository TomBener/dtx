#!/usr/bin/env node
/**
 * cli.ts — Non-interactive CLI for AI agents
 *
 * Default output is JSON. Progress logs are written to stderr.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as dt from "./bridge/devonthink.js";
import { loadConfig, resolveConfiguredPath, resolveConfiguredString } from "./config.js";
import { buildIndex, getIndexStatus } from "./rag/index-manager.js";
import { resetStoreCache, searchPassages } from "./rag/passage-search.js";
import { getIndexDir } from "./rag/store.js";

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = resolve(CLI_DIR, "..", "package.json");

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

function hasFlag(flags: Record<string, FlagValue>, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(flags, key));
}

function getEffectiveGroupUuid(flags: Record<string, FlagValue>): string | undefined {
  if (hasFlag(flags, "group")) {
    return getStringFlag(flags, "group");
  }
  if (hasFlag(flags, "database")) {
    return undefined;
  }
  return resolveConfiguredString(["DT_DEFAULT_GROUP_UUID"], "defaultGroupUuid");
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

function getPackageVersion(): string {
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || "unknown";
  } catch {
    return "unknown";
  }
}

function parseDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getDotEnvDiagnostics(): {
  found: boolean;
  path: string;
  keys: string[];
  googleApiKey: boolean;
  openaiApiKey: boolean;
  openaiCompatibleApiKey: boolean;
  openaiCompatibleBaseURL?: string;
  embeddingProvider?: string;
} {
  const dotEnvPath = resolve(process.cwd(), ".env");
  const parsed = parseDotEnv(dotEnvPath);
  return {
    found: existsSync(dotEnvPath),
    path: dotEnvPath,
    keys: Object.keys(parsed).sort(),
    googleApiKey:
      typeof parsed.GOOGLE_API_KEY === "string" && parsed.GOOGLE_API_KEY.length > 0,
    openaiApiKey:
      typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0,
    openaiCompatibleApiKey:
      typeof parsed.OPENAI_COMPATIBLE_API_KEY === "string" &&
      parsed.OPENAI_COMPATIBLE_API_KEY.length > 0,
    openaiCompatibleBaseURL:
      parsed.OPENAI_COMPATIBLE_BASE_URL || parsed.OPENAI_BASE_URL || undefined,
    embeddingProvider: parsed.EMBEDDING_PROVIDER || undefined,
  };
}

function getConfigDiagnostics(): {
  found: boolean;
  path: string;
  keys: string[];
} {
  const loaded = loadConfig();
  return {
    found: loaded.found,
    path: loaded.path,
    keys: Object.keys(loaded.config).sort(),
  };
}

function getResolvedSemanticProvider(dotEnv: {
  embeddingProvider?: string;
}): "gemini" | "openai" | "openai-compatible" | undefined {
  const provider =
    resolveConfiguredString(["EMBEDDING_PROVIDER"], "embeddingProvider") ||
    dotEnv.embeddingProvider;
  if (!provider) return undefined;
  if (provider === "openai" || provider === "openai-compatible") return provider;
  if (provider === "gemini") return "gemini";
  return undefined;
}

function buildVersionInfo(): Record<string, unknown> {
  return {
    name: "dtx",
    version: getPackageVersion(),
    node: process.version,
    scriptPath: process.argv[1] || null,
    realScriptPath: process.argv[1] ? realpathSync(process.argv[1]) : null,
    cwd: process.cwd(),
  };
}

function buildDoctorInfo(indexDir?: string): Record<string, unknown> {
  const dotEnv = getDotEnvDiagnostics();
  const provider = getResolvedSemanticProvider(dotEnv);
  const processGoogle = Boolean(process.env.GOOGLE_API_KEY);
  const processOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const processOpenAICompatibleApiKey = Boolean(
    process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY,
  );
  const processOpenAICompatibleBaseURL = Boolean(
    process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OPENAI_BASE_URL,
  );
  const semanticReadyFromProcessEnv =
    provider === "gemini"
      ? processGoogle
      : provider === "openai-compatible"
        ? processOpenAICompatibleBaseURL &&
          (processOpenAICompatibleApiKey || Boolean(process.env.OPENAI_BASE_URL))
        : provider === "openai"
          ? processOpenAI
          : false;
  const status = getIndexStatus(indexDir);
  const resolvedIndexDir =
    indexDir || resolveConfiguredPath(["DT_INDEX_DIR"], "indexDir") || undefined;
  const config = getConfigDiagnostics();

  return {
    ...buildVersionInfo(),
    config,
    semantic: {
      provider: provider || null,
      readyFromProcessEnv: semanticReadyFromProcessEnv,
      googleApiKeyInProcessEnv: processGoogle,
      openaiApiKeyInProcessEnv: processOpenAI,
      openaiCompatibleApiKeyInProcessEnv: processOpenAICompatibleApiKey,
      openaiCompatibleBaseURLInProcessEnv: processOpenAICompatibleBaseURL,
      note:
        dotEnv.found && !semanticReadyFromProcessEnv
          ? "A .env file exists in cwd, but dtx does not auto-load .env; export env vars before running."
          : undefined,
    },
    ...(dotEnv.found ? { dotEnv } : {}),
    index: status
      ? {
          available: true,
          indexDir: resolvedIndexDir,
          totalDocuments: status.totalDocuments,
          totalChunks: status.totalChunks,
          lastUpdated: status.lastUpdated,
          embeddingProvider: status.embeddingProvider,
          embeddingModel: status.embeddingModel,
          dimensions: status.dimensions,
        }
      : {
          available: false,
          indexDir: resolvedIndexDir,
        },
  };
}

function printHelp(): void {
  console.log(`Usage:
  dtx version
  dtx doctor [--index-dir <path>]
  dtx keyword --query "<q>" [--database <name>] [--group <uuid>] [--limit <n>] [--abstract]
  dtx semantic [--query "<q>"] [--database <name>] [--group <uuid>] [--limit <n>] [--per-doc <n>] [--context] [--debug] [--index-dir <path>] [--citation-key <key>] [--uuid <recordUuid>]
  dtx databases list
  dtx groups list [--uuid <groupUuid>] [--limit <n>]
  dtx documents get (--uuid <recordUuid> | --citation-key <key>) [--max-length <n>] [--bib <path>]
  dtx documents citation-key --uuid <recordUuid> [--bib <path>]
  dtx documents related --uuid <recordUuid> [--limit <n>]
  dtx index build [--database <name>] [--group <uuid>] [--include-md] [--force] [--bib <path>] [--index-dir <path>] [--content-max-length <n>]
  dtx index status [--index-dir <path>]

Notes:
  - Default output is JSON (stdout)
  - Progress logs are emitted on stderr
  - Default search/index group comes from ~/.dtx/config.json or DT_DEFAULT_GROUP_UUID
  - Passing --database disables the configured group unless --group is also provided
  - Markdown files are excluded by default; use --include-md to include them
  - content-max-length default: no truncation (set a positive number to cap content)
  - Index directory priority: --index-dir > DT_INDEX_DIR > ~/.dtx/config.json:indexDir
`);
}

async function run(): Promise<never> {
  const startedAt = Date.now();
  const parsed = parseArgs(process.argv.slice(2));
  const [namespace, action, ...rest] = parsed.positionals;
  const trailingPositionals = [action, ...rest].filter(
    (value): value is string => typeof value === "string",
  );

  if (!namespace || namespace === "help" || getBoolFlag(parsed.flags, "help", "h")) {
    printHelp();
    process.exit(0);
  }

  const commonMeta = (): Record<string, unknown> => ({
    elapsedMs: Date.now() - startedAt,
  });

  try {
    if (namespace === "version") {
      console.log(getPackageVersion());
      process.exit(0);
    }

    if (namespace === "doctor") {
      emitOk(buildDoctorInfo(getStringFlag(parsed.flags, "index-dir")), commonMeta());
    }

    // ─── keyword ───
    if (namespace === "keyword") {
      const query = getStringFlag(parsed.flags, "query") || trailingPositionals.join(" ");
      if (!query) {
        emitError("MISSING_ARGUMENT", 'Missing required argument: --query "<text>"');
      }
      const database = getStringFlag(parsed.flags, "database");
      const groupUuid = getEffectiveGroupUuid(parsed.flags);
      const limit = getNumberFlag(parsed.flags, "limit");
      const data = await dt.searchDocuments(query, database, limit, {
        includeAbstract: hasFlag(parsed.flags, "abstract")
          ? getBoolFlag(parsed.flags, "abstract")
          : true,
        groupUuid,
      });
      emitOk(data, { ...commonMeta(), ...(groupUuid ? { groupUuid } : {}) });
    }

    // ─── semantic ───
    if (namespace === "semantic") {
      const query = getStringFlag(parsed.flags, "query") || trailingPositionals.join(" ");
      const uuid = getStringFlag(parsed.flags, "uuid");
      const hasCitationKey = Boolean(getStringFlag(parsed.flags, "citation-key"));
      if (uuid && hasCitationKey) {
        emitError(
          "INVALID_ARGUMENT",
          "Provide either --uuid <recordUuid> or --citation-key <key>, not both.",
        );
      }
      if (!query && !hasCitationKey && !uuid) {
        emitError(
          "MISSING_ARGUMENT",
          'Missing required argument: --query "<text>" or --citation-key <key> or --uuid <recordUuid>',
        );
      }
      const limit = getNumberFlag(parsed.flags, "limit");
      const perDocLimit = getNumberFlag(parsed.flags, "per-doc", "perdoc");
      const indexDir = toIndexDir(parsed.flags);
      const groupUuid = getEffectiveGroupUuid(parsed.flags);
      const data = await searchPassages(query, limit, {
        database: getStringFlag(parsed.flags, "database"),
        groupUuid,
        indexDir,
        mode: "semantic",
        includeContext: getBoolFlag(parsed.flags, "context"),
        perDocLimit,
        debug: getBoolFlag(parsed.flags, "debug"),
        uuid,
        citationKey: getStringFlag(parsed.flags, "citation-key"),
      });
      emitOk(data, { ...commonMeta(), indexDir, ...(groupUuid ? { groupUuid } : {}) });
    }

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

    // ─── documents get ───
    if (namespace === "documents" && action === "get") {
      const uuid = getStringFlag(parsed.flags, "uuid") || rest[0];
      const citationKey = getStringFlag(parsed.flags, "citation-key");
      const bibliographyPath = getStringFlag(parsed.flags, "bib", "bibliography");
      if (uuid && citationKey) {
        emitError(
          "INVALID_ARGUMENT",
          "Provide either --uuid <recordUuid> or --citation-key <key>, not both.",
        );
      }
      if (!uuid && !citationKey) {
        emitError(
          "MISSING_ARGUMENT",
          "Missing required argument: --uuid <recordUuid> or --citation-key <key>",
        );
      }
      const maxLength = getNumberFlag(parsed.flags, "max-length");
      if (citationKey) {
        const data = await dt.getDocumentContentByCitationKey(
          citationKey,
          maxLength,
          bibliographyPath,
        );
        emitOk(data, commonMeta());
      }
      if (!uuid) {
        emitError("MISSING_ARGUMENT", "Missing required argument: --uuid <recordUuid>");
      }
      const data = await dt.getDocumentContent(uuid, maxLength, bibliographyPath);
      emitOk(data, commonMeta());
    }

    if (namespace === "documents" && action === "citation-key") {
      const uuid = getStringFlag(parsed.flags, "uuid") || rest[0];
      if (!uuid) {
        emitError("MISSING_ARGUMENT", "Missing required argument: --uuid <recordUuid>");
      }
      const bibliographyPath = getStringFlag(parsed.flags, "bib", "bibliography");
      const data = await dt.getDocumentCitationKey(uuid, bibliographyPath);
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
        groupUuid: getEffectiveGroupUuid(parsed.flags),
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
