/**
 * store.ts — Local vector storage with binary format
 *
 * Stores embeddings in binary (Float32Array) for space efficiency.
 * Chunk metadata is sharded into multiple JSON files to avoid giant single-file chunks.
 *
 * Storage layout:
 *   ~/Library/CloudStorage/Dropbox/bibliography/dtx-index/ (default, configurable)
 *   ├── vectors.bin          # Binary: contiguous Float32 arrays
 *   ├── chunks.json          # Chunk shard manifest
 *   ├── chunks.001.json      # Chunk metadata shard
 *   ├── chunks.002.json      # Chunk metadata shard
 *   └── meta.json            # Index-level metadata
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ─── Paths ───────────────────────────────────────────────

const DEFAULT_INDEX_DIR = resolve(
  homedir(),
  "Library",
  "CloudStorage",
  "Dropbox",
  "bibliography",
  "dtx-index",
);

interface IndexPaths {
  indexDir: string;
  vectorsPath: string;
  chunksPath: string;
  metaPath: string;
}

function resolveIndexPaths(indexDir?: string): IndexPaths {
  const raw = indexDir || process.env.DT_INDEX_DIR || DEFAULT_INDEX_DIR;
  const dir =
    raw === "~"
      ? homedir()
      : raw.startsWith("~/")
        ? resolve(homedir(), raw.slice(2))
        : raw;
  return {
    indexDir: dir,
    vectorsPath: resolve(dir, "vectors.bin"),
    chunksPath: resolve(dir, "chunks.json"),
    metaPath: resolve(dir, "meta.json"),
  };
}

// ─── Types ───────────────────────────────────────────────

export interface ChunkMeta {
  id: string;
  uuid: string;
  docName: string;
  database: string;
  text: string;
  chunkIndex: number;
  citationKey?: string;
}

export interface IndexMeta {
  version: number;
  embeddingProvider: string;
  embeddingModel: string;
  dimensions: number;
  totalChunks: number;
  totalDocuments: number;
  lastUpdated: string;
  /** Per-document tracking for incremental updates */
  documents: Record<
    string,
    {
      name: string;
      modificationDate: string;
      chunkCount: number;
    }
  >;
}

interface ChunkShardEntry {
  file: string;
  count: number;
}

interface ChunkManifest {
  version: 2;
  totalChunks: number;
  shardSize: number;
  shards: ChunkShardEntry[];
}

export interface SearchResult {
  uuid: string;
  docName: string;
  database: string;
  text: string;
  chunkIndex: number;
  score: number;
  citationKey?: string;
}

// ─── VectorStore ─────────────────────────────────────────

const CHUNK_SHARD_SIZE = Number(process.env.CHUNK_SHARD_SIZE) || 25_000;

export class VectorStore {
  private chunks: ChunkMeta[] = [];
  private vectors: Float32Array = new Float32Array(0);
  private vectorsUsed = 0;
  private meta: IndexMeta;
  private dimensions: number;
  private loaded = false;
  private paths: IndexPaths;

  constructor(dimensions: number, provider?: string, model?: string, indexDir?: string) {
    this.dimensions = dimensions;
    this.paths = resolveIndexPaths(indexDir);
    this.meta = {
      version: 1,
      embeddingProvider: provider || "unknown",
      embeddingModel: model || "unknown",
      dimensions,
      totalChunks: 0,
      totalDocuments: 0,
      lastUpdated: new Date().toISOString(),
      documents: {},
    };
  }

  /** Load index from disk. Returns false if no index exists or is unreadable. */
  load(): boolean {
    if (!existsSync(this.paths.metaPath)) return false;

    try {
      this.meta = JSON.parse(readFileSync(this.paths.metaPath, "utf-8"));
      this.dimensions = this.meta.dimensions;

      if (existsSync(this.paths.chunksPath)) {
        const manifest = JSON.parse(
          readFileSync(this.paths.chunksPath, "utf-8"),
        ) as ChunkManifest;
        if (manifest.version !== 2 || !Array.isArray(manifest.shards)) {
          throw new Error("Unsupported chunks.json format (expected version 2)");
        }
        const loadedChunks: ChunkMeta[] = [];
        for (const shard of manifest.shards) {
          const shardPath = resolve(this.paths.indexDir, shard.file);
          if (!existsSync(shardPath)) {
            throw new Error(`Missing chunk shard file: ${shard.file}`);
          }
          const chunkPart = JSON.parse(readFileSync(shardPath, "utf-8")) as ChunkMeta[];
          loadedChunks.push(...chunkPart);
        }
        this.chunks = loadedChunks;
      }

      if (existsSync(this.paths.vectorsPath)) {
        const buf = readFileSync(this.paths.vectorsPath);
        // Copy to aligned ArrayBuffer for safe Float32Array creation
        const ab = new ArrayBuffer(buf.length);
        new Uint8Array(ab).set(buf);
        this.vectors = new Float32Array(ab);
        this.vectorsUsed = this.vectors.length;
      }

      this.loaded = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Save index to disk */
  save(): void {
    mkdirSync(this.paths.indexDir, { recursive: true });

    // Update meta counters
    this.meta.totalChunks = this.chunks.length;
    this.meta.totalDocuments = Object.keys(this.meta.documents).length;
    this.meta.lastUpdated = new Date().toISOString();
    this.meta.dimensions = this.dimensions;

    // Write only the used portion of vectors as binary Float32
    const usedBytes = this.vectorsUsed * Float32Array.BYTES_PER_ELEMENT;
    writeFileSync(this.paths.vectorsPath, Buffer.from(this.vectors.buffer, 0, usedBytes));

    const shardFiles: string[] = [];
    for (const file of readdirSync(this.paths.indexDir)) {
      if (/^chunks\.\d+\.json$/.test(file)) {
        shardFiles.push(file);
      }
    }
    for (const file of shardFiles) {
      unlinkSync(resolve(this.paths.indexDir, file));
    }

    const shardSize = Math.max(1, CHUNK_SHARD_SIZE);
    const totalShards = Math.max(1, Math.ceil(this.chunks.length / shardSize));
    const padWidth = Math.max(3, String(totalShards).length);
    const shards: ChunkShardEntry[] = [];
    for (let start = 0, idx = 0; start < this.chunks.length; start += shardSize, idx++) {
      const chunkPart = this.chunks.slice(start, start + shardSize);
      const file = `chunks.${String(idx + 1).padStart(padWidth, "0")}.json`;
      writeFileSync(resolve(this.paths.indexDir, file), JSON.stringify(chunkPart));
      shards.push({ file, count: chunkPart.length });
    }

    const manifest: ChunkManifest = {
      version: 2,
      totalChunks: this.chunks.length,
      shardSize,
      shards,
    };
    writeFileSync(this.paths.chunksPath, JSON.stringify(manifest, null, 2));

    // Write meta as formatted JSON
    writeFileSync(this.paths.metaPath, JSON.stringify(this.meta, null, 2));
  }

  /** Semantic search: find top-K most similar chunks by cosine similarity */
  search(queryVector: number[], topK: number = 10): SearchResult[] {
    if (this.chunks.length === 0) return [];

    const scores: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const offset = i * this.dimensions;
      const score = cosineSimilarity(queryVector, this.vectors, offset, this.dimensions);
      scores.push({ index: i, score });
    }

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map((s) => {
      const chunk = this.chunks[s.index];
      return {
        uuid: chunk.uuid,
        docName: chunk.docName,
        database: chunk.database,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        score: s.score,
        citationKey: chunk.citationKey,
      };
    });
  }

  /** Get a document-level citation key (first chunk that has one). */
  getCitationKeyByUuid(uuid: string): string | undefined {
    for (const chunk of this.chunks) {
      if (chunk.uuid === uuid && chunk.citationKey) {
        return chunk.citationKey;
      }
    }
    return undefined;
  }

  /** Get UUID set for documents that already have citation keys in index. */
  getCitationKeyUuidSet(): Set<string> {
    const out = new Set<string>();
    for (const chunk of this.chunks) {
      if (chunk.citationKey) out.add(chunk.uuid);
    }
    return out;
  }

  /** Check if a document needs re-indexing based on modification date */
  needsReindex(uuid: string, modificationDate: string): boolean {
    const doc = this.meta.documents[uuid];
    return !doc || doc.modificationDate !== modificationDate;
  }

  /** Add or replace a document's chunks in the store */
  upsertDocument(
    uuid: string,
    name: string,
    modificationDate: string,
    newChunks: ChunkMeta[],
    newVectors: number[][],
  ): void {
    // Remove old chunks for this document (if any)
    this.removeDocument(uuid);

    // Append new chunks metadata
    this.chunks.push(...newChunks);

    // Append new vectors with amortized growth (O(n) total instead of O(n²))
    const addLength = newVectors.length * this.dimensions;
    const needed = this.vectorsUsed + addLength;
    if (needed > this.vectors.length) {
      // Double capacity or use needed size, whichever is larger
      const newCapacity = Math.max(needed, this.vectors.length * 2, 4096);
      const expanded = new Float32Array(newCapacity);
      if (this.vectorsUsed > 0) {
        expanded.set(this.vectors.subarray(0, this.vectorsUsed));
      }
      this.vectors = expanded;
    }
    for (let i = 0; i < newVectors.length; i++) {
      const offset = this.vectorsUsed + i * this.dimensions;
      for (let d = 0; d < this.dimensions; d++) {
        this.vectors[offset + d] = newVectors[i][d];
      }
    }
    this.vectorsUsed += addLength;

    // Update document tracking
    this.meta.documents[uuid] = {
      name,
      modificationDate,
      chunkCount: newChunks.length,
    };
  }

  /** Remove all chunks for a document */
  removeDocument(uuid: string): void {
    const removeIndices = new Set<number>();
    this.chunks.forEach((c, i) => {
      if (c.uuid === uuid) removeIndices.add(i);
    });

    if (removeIndices.size === 0) return;

    // Filter chunks and compact vectors in-place (no reallocation)
    const newChunks: ChunkMeta[] = [];
    const keepIndices: number[] = [];
    this.chunks.forEach((c, i) => {
      if (!removeIndices.has(i)) {
        newChunks.push(c);
        keepIndices.push(i);
      }
    });

    // Compact vectors in-place to avoid unnecessary memory allocation
    let writePos = 0;
    for (const oldIdx of keepIndices) {
      const src = oldIdx * this.dimensions;
      const dst = writePos * this.dimensions;
      if (src !== dst) {
        for (let d = 0; d < this.dimensions; d++) {
          this.vectors[dst + d] = this.vectors[src + d];
        }
      }
      writePos++;
    }

    this.chunks = newChunks;
    this.vectorsUsed = keepIndices.length * this.dimensions;
    delete this.meta.documents[uuid];
  }

  /** Get a copy of the index metadata */
  getMeta(): IndexMeta {
    return { ...this.meta };
  }

  /** Check if index is loaded and contains data */
  isReady(): boolean {
    return this.loaded && this.chunks.length > 0;
  }

  /** Total number of chunks in the store */
  get totalChunks(): number {
    return this.chunks.length;
  }
}

// ─── Cosine Similarity ───────────────────────────────────

/**
 * Compute cosine similarity between a query vector (plain array)
 * and a stored vector within a contiguous Float32Array.
 */
function cosineSimilarity(
  query: number[],
  stored: Float32Array,
  offset: number,
  dims: number,
): number {
  let dot = 0;
  let normQ = 0;
  let normS = 0;
  for (let i = 0; i < dims; i++) {
    const q = query[i];
    const s = stored[offset + i];
    dot += q * s;
    normQ += q * q;
    normS += s * s;
  }
  const denom = Math.sqrt(normQ) * Math.sqrt(normS);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Utilities ───────────────────────────────────────────

/** Check if an index exists on disk */
export function indexExists(indexDir?: string): boolean {
  const p = resolveIndexPaths(indexDir);
  return existsSync(p.metaPath) && existsSync(p.vectorsPath);
}

/** Get index directory path */
export function getIndexDir(indexDir?: string): string {
  return resolveIndexPaths(indexDir).indexDir;
}
