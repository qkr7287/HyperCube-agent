import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("workspace-usage");

// Cache TTLs differentiated by outcome so we don't hammer distroless containers
// (no `du` available) every cycle, but also pick up real usage changes within
// a reasonable window.
const SUCCESS_TTL_MS = 10_000;
const NO_DU_TTL_MS = 5 * 60_000;
const TRANSIENT_TTL_MS = 30_000;
const EXEC_TIMEOUT_MS = 3_000;

type CacheEntry = {
  expiresAt: number;
  usedGb: number | null;
  source: "du" | null;
};

export class WorkspaceUsageProbe {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly docker: Dockerode) {}

  // Returns a {usedGb, source} pair. `source: "du"` means we got a real
  // measurement; `source: null` means du failed/missing and caller should
  // fall back (typically to SizeRw).
  async measure(containerId: string): Promise<{ usedGb: number | null; source: "du" | null }> {
    const now = Date.now();
    const cached = this.cache.get(containerId);
    if (cached && cached.expiresAt > now) {
      return { usedGb: cached.usedGb, source: cached.source };
    }

    try {
      const usedKb = await this.execDu(containerId);
      const usedGb = round2(usedKb / (1024 * 1024));
      this.cache.set(containerId, {
        expiresAt: now + SUCCESS_TTL_MS,
        usedGb,
        source: "du",
      });
      return { usedGb, source: "du" };
    } catch (err) {
      const msg = (err as Error).message;
      const isNoDu = /executable file not found|not found in \$PATH|no such file|OCI runtime exec failed/i.test(msg);
      const ttl = isNoDu ? NO_DU_TTL_MS : TRANSIENT_TTL_MS;
      this.cache.set(containerId, {
        expiresAt: now + ttl,
        usedGb: null,
        source: null,
      });
      log.debug(`du failed for ${containerId} (${msg.slice(0, 120)}) — cached null for ${ttl / 1000}s`);
      return { usedGb: null, source: null };
    }
  }

  prune(activeIds: Set<string>): void {
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }
  }

  // Runs `du -sk /workspace` inside the container with TTY mode so we get a
  // single un-multiplexed stream. -sk reports kilobytes — works on both GNU du
  // (Debian/Ubuntu/RHEL) and BusyBox du (Alpine). GNU's -b (bytes) is missing
  // from BusyBox so we settle for KB precision (negligible for a GB-scale KPI)
  // in exchange for portability. Times out via stream.destroy() to avoid
  // hanging exec leaks (same pattern as docker.stats AbortController).
  private async execDu(containerId: string): Promise<number> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ["du", "-sk", "/workspace"],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const output = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          stream.destroy();
        } catch {
          // already destroyed
        }
        reject(new Error(`du timeout after ${EXEC_TIMEOUT_MS}ms`));
      }, EXEC_TIMEOUT_MS);

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      stream.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      throw new Error(`du exited ${info.ExitCode}: ${output.slice(0, 200).trim()}`);
    }

    // Output: "1234\t/workspace\n" — first whitespace-separated token is KB.
    const match = output.match(/(\d+)/);
    if (!match) throw new Error(`du output unparseable: ${output.slice(0, 100)}`);
    return parseInt(match[1], 10);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
