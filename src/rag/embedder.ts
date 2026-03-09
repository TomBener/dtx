/**
 * embedder.ts — Embedding API abstraction layer
 *
 * Supports OpenAI, OpenAI-compatible, and Google Gemini embedding models.
 * Used for building and querying the semantic search index.
 *
 * Configuration via ~/.dtx/config.json or environment variables:
 *   EMBEDDING_PROVIDER = "openai" | "openai-compatible" | "gemini"
 *   EMBEDDING_MODEL    = model name
 *   EMBEDDING_DIMENSIONS = optional override dimensions for custom models/providers
 *
 * Note: Anthropic does not offer an embedding API.
 * If using Anthropic as your LLM provider, choose OpenAI or Gemini for embeddings.
 */

import OpenAI from "openai";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import { resolveConfiguredNumber, resolveConfiguredString } from "../config.js";

// ─── Interface ───────────────────────────────────────────

export interface Embedder {
  /** Embed a batch of texts (for document indexing) */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Embed a single query (for search — may use different task type) */
  embedQuery(text: string): Promise<number[]>;
  /** Vector dimensions */
  readonly dimensions: number;
  /** Model name */
  readonly modelName: string;
}

export type EmbeddingProviderName = "openai" | "openai-compatible" | "gemini";

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "gemini-embedding-001": 3072,
};

// ─── OpenAI Embedder ─────────────────────────────────────

class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  readonly modelName: string;
  readonly dimensions: number;

  constructor(
    provider: "openai" | "openai-compatible",
    options: { model?: string; baseURL?: string; apiKey?: string } = {},
  ) {
    this.client =
      provider === "openai-compatible"
        ? new OpenAI({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
          })
        : new OpenAI({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
          });
    this.modelName = options.model || "";
    if (!this.modelName) {
      throw new Error("EMBEDDING_MODEL is required for OpenAI embeddings");
    }
    this.dimensions =
      resolveConfiguredNumber(["EMBEDDING_DIMENSIONS"], "embeddingDimensions") ||
      MODEL_DIMENSIONS[this.modelName] ||
      1536;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: texts,
    });
    return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }
}

function getOpenAICompatibleBaseURL(): string {
  const baseURL =
    resolveConfiguredString(
      ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"],
      "openaiCompatibleBaseUrl",
    ) || resolveConfiguredString(["OPENAI_BASE_URL"], "openaiBaseUrl");
  if (!baseURL) {
    throw new Error(
      "OPENAI_COMPATIBLE_BASE_URL or OPENAI_BASE_URL is required for openai-compatible embeddings",
    );
  }
  return baseURL;
}

function getOpenAICompatibleApiKey(): string {
  return (
    resolveConfiguredString(
      ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
      "openaiCompatibleApiKey",
    ) ||
    resolveConfiguredString(["OPENAI_API_KEY"], "openaiApiKey") ||
    ""
  );
}

// ─── Gemini Embedder ─────────────────────────────────────

class GeminiEmbedder implements Embedder {
  private genAI: GoogleGenerativeAI;
  readonly modelName: string;
  readonly dimensions: number;

  constructor(model?: string) {
    const key = resolveConfiguredString(["GOOGLE_API_KEY"], "googleApiKey");
    if (!key) throw new Error("GOOGLE_API_KEY is required for Gemini embeddings");
    this.genAI = new GoogleGenerativeAI(key);
    this.modelName = model || "";
    if (!this.modelName) {
      throw new Error("EMBEDDING_MODEL is required for Gemini embeddings");
    }
    this.dimensions =
      resolveConfiguredNumber(["EMBEDDING_DIMENSIONS"], "embeddingDimensions") ||
      MODEL_DIMENSIONS[this.modelName] ||
      3072;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

    // Retry with exponential backoff for rate limiting (429) and transient errors
    const MAX_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await model.batchEmbedContents({
          requests: texts.map((text) => ({
            content: { role: "user" as const, parts: [{ text }] },
            taskType: TaskType.RETRIEVAL_DOCUMENT,
          })),
        });
        return result.embeddings.map((e) => e.values);
      } catch (err: unknown) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimited =
          errMsg.includes("429") ||
          errMsg.includes("quota") ||
          errMsg.includes("rate") ||
          errMsg.includes("overloaded");

        if (attempt < MAX_RETRIES && isRateLimited) {
          const delay = 1000 * Math.pow(2, attempt);
          console.error(
            `  \u26a0 Gemini API rate limited, retrying in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async embedQuery(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

    const MAX_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await model.embedContent({
          content: { role: "user" as const, parts: [{ text }] },
          taskType: TaskType.RETRIEVAL_QUERY,
        });
        return result.embedding.values;
      } catch (err: unknown) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimited =
          errMsg.includes("429") ||
          errMsg.includes("quota") ||
          errMsg.includes("rate") ||
          errMsg.includes("overloaded");

        if (attempt < MAX_RETRIES && isRateLimited) {
          const delay = 1000 * Math.pow(2, attempt);
          console.error(
            `  \u26a0 Gemini API rate limited (query), retrying in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}

// ─── Factory ─────────────────────────────────────────────

let cachedEmbedder: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (cachedEmbedder) return cachedEmbedder;

  const provider = resolveConfiguredString(
    ["EMBEDDING_PROVIDER"],
    "embeddingProvider",
  ) as EmbeddingProviderName | undefined;
  const model = resolveConfiguredString(["EMBEDDING_MODEL"], "embeddingModel");

  if (!provider) {
    throw new Error(
      "EMBEDDING_PROVIDER is not configured. Set ~/.dtx/config.json or process env.",
    );
  }

  switch (provider) {
    case "openai":
      cachedEmbedder = new OpenAIEmbedder("openai", { model });
      break;
    case "openai-compatible":
      cachedEmbedder = new OpenAIEmbedder("openai-compatible", {
        model,
        baseURL: getOpenAICompatibleBaseURL(),
        apiKey: getOpenAICompatibleApiKey(),
      });
      break;
    case "gemini":
      cachedEmbedder = new GeminiEmbedder(model);
      break;
    default:
      throw new Error(
        `Unsupported EMBEDDING_PROVIDER: "${provider}". Must be "openai", "openai-compatible", or "gemini".`,
      );
  }

  return cachedEmbedder;
}
