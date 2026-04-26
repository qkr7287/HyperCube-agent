import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("cpu-quota");

const NANOCPU_TO_CORES = 1_000_000_000;

interface HostConfigQuota {
  NanoCpus?: number;
  CpuQuota?: number;
  CpuPeriod?: number;
  CpusetCpus?: string;
}

// Resolve the logical-core quota Docker enforces on a container.
// Priority mirrors how Docker itself materializes CLI flags into cgroup
// settings: --cpus (NanoCpus) > --cpu-quota/--cpu-period > --cpuset-cpus >
// inherits host. We deliberately do not read /sys/fs/cgroup directly —
// inspect works on every cgroup version, every runtime, and on Windows
// (where /sys does not exist), at the cost of one HTTP round-trip per new
// container ID. The result is cached because the quota is fixed for the
// lifetime of a container ID.
export async function resolveContainerCoresQuota(
  docker: Dockerode,
  shortId: string,
  hostLogicalCores: number,
): Promise<number | null> {
  try {
    const info = await docker.getContainer(shortId).inspect();
    const hc = (info.HostConfig ?? {}) as HostConfigQuota;

    if (typeof hc.NanoCpus === "number" && hc.NanoCpus > 0) {
      return roundCores(hc.NanoCpus / NANOCPU_TO_CORES);
    }

    if (
      typeof hc.CpuQuota === "number" &&
      hc.CpuQuota > 0 &&
      typeof hc.CpuPeriod === "number" &&
      hc.CpuPeriod > 0
    ) {
      return roundCores(hc.CpuQuota / hc.CpuPeriod);
    }

    if (typeof hc.CpusetCpus === "string" && hc.CpusetCpus.length > 0) {
      const count = countCpuset(hc.CpusetCpus);
      if (count > 0) return count;
    }

    return hostLogicalCores > 0 ? hostLogicalCores : null;
  } catch (err) {
    log.debug(`inspect failed for ${shortId}: ${(err as Error).message}`);
    return null;
  }
}

// "0-3,5,7-8" → 6
function countCpuset(spec: string): number {
  let total = 0;
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dash = trimmed.indexOf("-");
    if (dash < 0) {
      total += 1;
      continue;
    }
    const start = Number.parseInt(trimmed.slice(0, dash), 10);
    const end = Number.parseInt(trimmed.slice(dash + 1), 10);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      total += end - start + 1;
    }
  }
  return total;
}

function roundCores(value: number): number {
  return Math.round(value * 100) / 100;
}
