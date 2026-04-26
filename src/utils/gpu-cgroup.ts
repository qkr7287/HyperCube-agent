import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("gpu-cgroup");

const READ_TIMEOUT_MS = 100;
const CONCURRENCY = 16;

// Match a 64-char container ID anywhere in a cgroup line, anchored by a
// non-hex boundary so we don't accidentally grab a longer hash prefix.
const CONTAINER_ID_REGEX = /(?:^|[^a-f0-9])([a-f0-9]{64})(?:[^a-f0-9]|$)/i;
const RUNTIME_HINT_REGEX = /docker|containerd|crio|kubepods/i;

export function parseCgroupForContainerId(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // A bare `/system.slice/...` line on a non-container PID can still
    // contain a 64-char hex hash. The runtime hint avoids those.
    if (!RUNTIME_HINT_REGEX.test(line)) continue;
    const match = CONTAINER_ID_REGEX.exec(line);
    if (match?.[1]) {
      return match[1].slice(0, 12);
    }
  }
  return null;
}

export async function lookupContainerIdByPid(
  hostProcPath: string,
  pid: number,
): Promise<string | null> {
  const file = path.join(hostProcPath, String(pid), "cgroup");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), READ_TIMEOUT_MS);
  try {
    const content = await fs.readFile(file, {
      encoding: "utf-8",
      signal: ac.signal,
    });
    return parseCgroupForContainerId(content);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // PID disappeared between the pmon snapshot and our read. Common for
    // short-lived CUDA jobs — silent skip.
    if (code === "ENOENT" || code === "ESRCH") return null;
    log.debug(`cgroup read failed for pid=${pid}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupContainerIdsForPids(
  hostProcPath: string,
  pids: Iterable<number>,
): Promise<Map<number, string>> {
  const unique = Array.from(new Set(pids));
  const out = new Map<number, string>();
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (pid) => {
        const id = await lookupContainerIdByPid(hostProcPath, pid);
        return [pid, id] as const;
      }),
    );
    for (const [pid, id] of results) {
      if (id) out.set(pid, id);
    }
  }
  return out;
}
