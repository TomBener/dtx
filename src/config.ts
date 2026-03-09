import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DtxConfig {
  defaultGroupUuid?: string;
  indexDir?: string;
  bibliographyJsonPath?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  googleApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiCompatibleApiKey?: string;
  openaiCompatibleBaseUrl?: string;
}

interface LoadedConfig {
  found: boolean;
  path: string;
  config: DtxConfig;
}

let cachedConfig: LoadedConfig | null = null;

export function getConfigPath(): string {
  return resolve(homedir(), ".dtx", "config.json");
}

export function loadConfig(): LoadedConfig {
  if (cachedConfig) return cachedConfig;

  const path = getConfigPath();
  if (!existsSync(path)) {
    cachedConfig = { found: false, path, config: {} };
    return cachedConfig;
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as DtxConfig;
  cachedConfig = { found: true, path, config: parsed };
  return cachedConfig;
}

export function resolveConfiguredString(
  envKeys: string[],
  configKey: keyof DtxConfig,
): string | undefined {
  for (const key of envKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const value = loadConfig().config[configKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveConfiguredNumber(
  envKeys: string[],
  configKey: keyof DtxConfig,
): number | undefined {
  for (const key of envKeys) {
    const raw = process.env[key];
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  const raw = loadConfig().config[configKey];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function resolveConfiguredPath(
  envKeys: string[],
  configKey: keyof DtxConfig,
): string | undefined {
  const raw = resolveConfiguredString(envKeys, configKey);
  if (!raw) return undefined;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return raw;
}
