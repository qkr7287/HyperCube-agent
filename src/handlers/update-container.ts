import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("handler:update");

interface UpdateParams {
  containerId: string;
  memory_mb?: number;
  cpu_percent?: number;
  restart_policy?: string;
  restart_max_retry?: number;
}

const VALID_RESTART_POLICIES = new Set(["no", "on-failure", "unless-stopped", "always"]);
// Docker default CFS period. CpuQuota is expressed against this window, so
// cpu_percent → CpuQuota with the same 100 = 1 core unit as create_container.
const CPU_PERIOD = 100_000;

interface RestartPolicyUpdate {
  Name: string;
  MaximumRetryCount?: number;
}

// Live container resource update via the Docker /containers/{id}/update
// endpoint (dockerode container.update). Partial: only the fields the
// backend sent are touched; omitted fields keep their current value.
export async function handleUpdateContainer(
  docker: Dockerode,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const p = params as unknown as UpdateParams;
  if (!p.containerId) throw new Error("containerId is required");

  const update: Record<string, unknown> = {};
  const applied: string[] = [];

  if (p.memory_mb !== undefined) {
    if (typeof p.memory_mb !== "number" || !Number.isInteger(p.memory_mb) || p.memory_mb < 1) {
      throw new Error("memory_mb must be a positive integer (MB)");
    }
    const bytes = p.memory_mb * 1024 * 1024;
    update.Memory = bytes;
    update.MemorySwap = bytes;
    applied.push(`memory=${p.memory_mb}MB`);
  }

  if (p.cpu_percent !== undefined) {
    if (typeof p.cpu_percent !== "number" || !Number.isInteger(p.cpu_percent) || p.cpu_percent < 1) {
      throw new Error("cpu_percent must be a positive integer (100 = 1 core)");
    }
    update.CpuQuota = p.cpu_percent * 1000;
    update.CpuPeriod = CPU_PERIOD;
    applied.push(`cpu=${p.cpu_percent}%`);
  }

  if (p.restart_policy !== undefined) {
    if (typeof p.restart_policy !== "string" || !VALID_RESTART_POLICIES.has(p.restart_policy)) {
      throw new Error(
        `restart_policy must be one of: ${[...VALID_RESTART_POLICIES].join(", ")}`,
      );
    }
    const policy: RestartPolicyUpdate = { Name: p.restart_policy };
    // MaximumRetryCount only carries meaning for on-failure.
    if (p.restart_policy === "on-failure" && p.restart_max_retry !== undefined) {
      if (
        typeof p.restart_max_retry !== "number" ||
        !Number.isInteger(p.restart_max_retry) ||
        p.restart_max_retry < 0
      ) {
        throw new Error("restart_max_retry must be a non-negative integer");
      }
      policy.MaximumRetryCount = p.restart_max_retry;
    }
    update.RestartPolicy = policy;
    applied.push(`restart=${p.restart_policy}`);
  }

  if (Object.keys(update).length === 0) {
    throw new Error(
      "no updatable fields provided (memory_mb / cpu_percent / restart_policy)",
    );
  }

  const container = docker.getContainer(p.containerId);

  let info;
  try {
    info = await container.inspect();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.toLowerCase().includes("no such container")) {
      throw new Error("container not found");
    }
    throw err;
  }

  log.info(`Updating container ${p.containerId}: ${applied.join(" ")}`);
  await container.update(update);

  return {
    containerId: info.Id,
    updated: true,
    applied,
  };
}
