import type { AppConfig } from "../types/index.js";
import { hashPath, pathExists, resolveCachePath } from "../utils/model-cache.js";

// Lossless recovery for the "files landed but command_response was lost over
// the WS" case (incident d). The backend re-asks the agent for the on-disk
// state of a model-cache path so it can settle a stuck ModelPrepareJob
// without re-downloading. requestId is echoed by the dispatcher.
type CacheStatus = "ready" | "missing" | "partial";

export async function handleQueryModelCache(
  config: AppConfig,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawPath = asString(params.expectedCachePath) ?? asString(params.cachePath);
  if (!rawPath) {
    throw new Error("query_model_cache requires expectedCachePath");
  }
  const expectedSha = parseSha256(params.sha256);
  const expectedSize = asNullablePositiveInteger(params.sizeBytes);
  const cachePath = resolveCachePath(config.modelCacheRoot, rawPath);

  if (!(await pathExists(cachePath))) {
    return { status: "missing" satisfies CacheStatus, cachePath, sha256: null };
  }

  // Re-hash the actual bytes on disk — the manifest alone can't tell a
  // complete file apart from a truncated one or a stale failed attempt.
  const hashed = await hashPath(cachePath);
  const shaMatches = expectedSha === null || hashed.sha256 === expectedSha;
  const sizeMatches = expectedSize === null || hashed.sizeBytes === expectedSize;
  const status: CacheStatus = shaMatches && sizeMatches ? "ready" : "partial";

  return {
    status,
    cachePath,
    sha256: hashed.sha256,
    sizeBytes: hashed.sizeBytes,
  };
}

function parseSha256(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error("query_model_cache sha256 must be a 64-character hex string");
  }
  return raw.toLowerCase();
}

function asNullablePositiveInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
