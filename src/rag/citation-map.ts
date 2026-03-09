/**
 * citation-map.ts — Citation key lookup by file path
 *
 * Loads a bibliography JSON file and builds a map:
 *   absolute file path -> citation key
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface BibliographyItem {
  id?: string;
  file?: string;
  type?: string;
  title?: string;
  editor?: Array<{
    family?: string;
    given?: string;
    literal?: string;
  }>;
  author?: Array<{
    family?: string;
    given?: string;
    literal?: string;
  }>;
  issued?: {
    "date-parts"?: unknown[];
  };
  abstract?: string;
}

export interface BibliographyMetadata {
  citationKey: string;
  author?: string;
  year?: string;
  title?: string;
  publicationType?: string;
  abstract?: string;
}

export interface CitationMapLoadResult {
  path: string;
  mapped: number;
  skipped: number;
  map: Map<string, string>;
  metadataByPath: Map<string, BibliographyMetadata>;
  metadataByCitationKey: Map<string, BibliographyMetadata>;
  pathsByCitationKey: Map<string, string[]>;
}

/** Default bibliography path: ~/Library/CloudStorage/Dropbox/bibliography/bibliography.json */
export function getDefaultBibliographyPath(): string {
  return resolve(
    homedir(),
    "Library",
    "CloudStorage",
    "Dropbox",
    "bibliography",
    "bibliography.json",
  );
}

/** Normalize path for robust matching (Unicode + slash + /private prefix on macOS). */
export function normalizePathForLookup(path: string): string {
  let p = path.trim().normalize("NFC").replace(/\\/g, "/");
  p = p.replace(/\/+/g, "/");
  if (p.startsWith("/private/")) {
    p = p.slice("/private".length);
  }
  return p;
}

/** Load citation map from bibliography JSON. */
export function loadCitationMap(bibliographyPath?: string): CitationMapLoadResult | null {
  const path =
    bibliographyPath ||
    process.env.BIBLIOGRAPHY_JSON_PATH ||
    getDefaultBibliographyPath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const items = extractBibliographyItems(parsed);

  const map = new Map<string, string>();
  const metadataByPath = new Map<string, BibliographyMetadata>();
  const metadataByCitationKey = new Map<string, BibliographyMetadata>();
  const pathsByCitationKey = new Map<string, string[]>();
  let skipped = 0;

  for (const item of items) {
    const citationKey = (item.id || "").trim();
    const filePaths = splitBibliographyFilePaths(item.file);
    if (!citationKey || filePaths.length === 0) {
      skipped++;
      continue;
    }

    for (const filePath of filePaths) {
      const normalized = normalizePathForLookup(filePath);
      const metadata: BibliographyMetadata = {
        citationKey,
        author: formatNames(item.author) || formatNames(item.editor),
        year: extractYear(item.issued),
        title:
          typeof item.title === "string" ? item.title.trim() || undefined : undefined,
        publicationType:
          typeof item.type === "string" ? item.type.trim() || undefined : undefined,
        abstract:
          typeof item.abstract === "string"
            ? item.abstract.trim() || undefined
            : undefined,
      };
      map.set(normalized, citationKey);
      map.set(normalized.toLowerCase(), citationKey);
      metadataByPath.set(normalized, metadata);
      metadataByPath.set(normalized.toLowerCase(), metadata);
      const existingPaths = pathsByCitationKey.get(citationKey) ?? [];
      existingPaths.push(normalized);
      pathsByCitationKey.set(citationKey, existingPaths);
      metadataByCitationKey.set(citationKey, metadata);
    }
  }

  return {
    path,
    mapped: map.size / 2,
    skipped,
    map,
    metadataByPath,
    metadataByCitationKey,
    pathsByCitationKey,
  };
}

/** Resolve citation key for a DEVONthink record path. */
export function resolveCitationKey(
  map: Map<string, string> | null,
  recordPath?: string,
): string | undefined {
  if (!map || !recordPath) return undefined;
  const normalized = normalizePathForLookup(recordPath);
  return map.get(normalized) || map.get(normalized.toLowerCase());
}

export function getMetadataForPath(
  metadataByPath: Map<string, BibliographyMetadata> | null,
  recordPath?: string,
): BibliographyMetadata | undefined {
  if (!metadataByPath || !recordPath) return undefined;
  const normalized = normalizePathForLookup(recordPath);
  return metadataByPath.get(normalized) || metadataByPath.get(normalized.toLowerCase());
}

export function getMetadataForCitationKey(
  metadataByCitationKey: Map<string, BibliographyMetadata> | null,
  citationKey?: string,
): BibliographyMetadata | undefined {
  if (!metadataByCitationKey || !citationKey) return undefined;
  return metadataByCitationKey.get(citationKey);
}

export function getPathsForCitationKey(
  pathsByCitationKey: Map<string, string[]> | null,
  citationKey?: string,
): string[] {
  if (!pathsByCitationKey || !citationKey) return [];
  return pathsByCitationKey.get(citationKey) ?? [];
}

export function getRecordStemFromPath(recordPath: string): string {
  const base = basename(recordPath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function extractBibliographyItems(parsed: unknown): BibliographyItem[] {
  if (Array.isArray(parsed)) {
    return parsed as BibliographyItem[];
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items as BibliographyItem[];
    }

    // Fallback: return the first array value found in object roots.
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        return value as BibliographyItem[];
      }
    }
  }

  return [];
}

/** Parse bibliography "file" field into one or more paths (semicolon-separated). */
function splitBibliographyFilePaths(file: string | undefined): string[] {
  const raw = (file || "").trim();
  if (!raw) return [];
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function formatNames(
  people: Array<{ family?: string; given?: string; literal?: string }> | undefined,
): string | undefined {
  if (!Array.isArray(people) || people.length === 0) return undefined;
  const names = people
    .map((person) => {
      if (typeof person.literal === "string" && person.literal.trim()) {
        return person.literal.trim();
      }
      const family = (person.family || "").trim();
      const given = (person.given || "").trim();
      if (family && given) return `${family} ${given}`;
      return family || given || "";
    })
    .filter((name) => name.length > 0);
  return names.length > 0 ? names.join("; ") : undefined;
}

function extractYear(
  issued: { "date-parts"?: unknown[] } | undefined,
): string | undefined {
  const first = issued?.["date-parts"]?.[0];
  if (!Array.isArray(first) || first.length === 0) return undefined;
  const year = first[0];
  if (typeof year === "string" && year.trim()) return year.trim();
  if (typeof year === "number" && Number.isFinite(year)) return String(year);
  return undefined;
}
