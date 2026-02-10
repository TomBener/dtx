/**
 * citation-map.ts — Citation key lookup by file path
 *
 * Loads a bibliography JSON file and builds a map:
 *   absolute file path -> citation key
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface BibliographyItem {
  id?: string;
  file?: string;
}

export interface CitationMapLoadResult {
  path: string;
  mapped: number;
  skipped: number;
  map: Map<string, string>;
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
  let skipped = 0;

  for (const item of items) {
    const citationKey = (item.id || "").trim();
    const filePath = (item.file || "").trim();
    if (!citationKey || !filePath) {
      skipped++;
      continue;
    }

    const normalized = normalizePathForLookup(filePath);
    map.set(normalized, citationKey);
    map.set(normalized.toLowerCase(), citationKey);
  }

  return {
    path,
    mapped: map.size / 2,
    skipped,
    map,
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
