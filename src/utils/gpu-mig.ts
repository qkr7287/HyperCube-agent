import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("gpu-mig");

const INSPECT_TIMEOUT_MS = 1_000;
// Inspect output is static for the lifetime of a container — TTL exists
// only so a container that's torn down and recreated under the same short
// ID gets re-read eventually.
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  uuids: string[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearMigCacheForTests(): void {
  cache.clear();
}

export async function getContainerMigUuids(
  docker: Dockerode | null,
  containerId12: string,
): Promise<string[]> {
  if (!docker) return [];
  const now = Date.now();
  const cached = cache.get(containerId12);
  if (cached && now < cached.expiresAt) return cached.uuids;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INSPECT_TIMEOUT_MS);
  try {
    const c = docker.getContainer(containerId12);
    // dockerode's @types omit abortSignal but the runtime supports it.
    const opts = { abortSignal: ac.signal } as unknown as undefined;
    const info = await c.inspect(opts);
    const uuids = extractMigUuids(info);
    cache.set(containerId12, { uuids, expiresAt: now + CACHE_TTL_MS });
    return uuids;
  } catch (err) {
    log.debug(`inspect failed for ${containerId12}: ${(err as Error).message}`);
    // Cache the empty result briefly so a hot loop of GPU-less containers
    // doesn't spam inspect calls.
    cache.set(containerId12, { uuids: [], expiresAt: now + CACHE_TTL_MS });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

interface DockerInspectShape {
  Config?: { Env?: string[] };
  HostConfig?: {
    DeviceRequests?: Array<{
      Driver?: string;
      DeviceIDs?: string[];
      Capabilities?: string[][];
    }>;
  };
}

export function extractMigUuids(info: unknown): string[] {
  const out = new Set<string>();
  const data = info as DockerInspectShape;

  for (const env of data.Config?.Env ?? []) {
    if (typeof env !== "string") continue;
    if (!env.startsWith("NVIDIA_VISIBLE_DEVICES=")) continue;
    const value = env.slice("NVIDIA_VISIBLE_DEVICES=".length);
    for (const token of value.split(",")) {
      const trimmed = token.trim();
      if (trimmed.startsWith("MIG-")) out.add(trimmed);
    }
  }

  for (const req of data.HostConfig?.DeviceRequests ?? []) {
    for (const id of req.DeviceIDs ?? []) {
      if (typeof id === "string" && id.startsWith("MIG-")) out.add(id);
    }
  }

  return Array.from(out);
}

// Drop cached entries for containers that no longer exist. Called during
// the same prune pass docker.ts runs for network samples.
export function pruneMigCache(liveContainerIds: ReadonlySet<string>): void {
  for (const id of cache.keys()) {
    if (!liveContainerIds.has(id)) cache.delete(id);
  }
}
