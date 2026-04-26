import os from "node:os";
import { readFileSync } from "node:fs";
import type { AppConfig } from "./types/index.js";

export function loadConfig(): AppConfig {
  const backendUrl = requireEnv("BACKEND_URL");
  const backendApiUrl = requireEnv("BACKEND_API_URL");

  const collectInterval = parseInt(process.env.COLLECT_INTERVAL ?? "2000", 10);
  if (Number.isNaN(collectInterval) || collectInterval < 500) {
    throw new Error("COLLECT_INTERVAL must be a number >= 500");
  }

  const dcgmRaw = process.env.DCGM_EXPORTER_URL?.trim();

  return {
    backendUrl,
    backendApiUrl,
    agentHostname: process.env.AGENT_HOSTNAME || readHostHostname() || os.hostname(),
    collectInterval,
    dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    // Optional override sent in registration payload as ip_address. Only
    // useful in environments where the backend cannot infer the agent's
    // real IP from the TCP peer address (Docker Desktop on Windows/Mac,
    // VPN, NAT). Empty/unset = omit the field and let the backend record
    // whatever it observes.
    advertiseIp:
      process.env.AGENT_ADVERTISE_IP?.trim() ||
      process.env.HOST_IP?.trim() ||
      null,
    // When the agent runs in a container the host's /proc must be mounted
    // (e.g. /proc:/host/proc:ro) so cgroup files can map PIDs back to
    // containers. Native installs leave this at /proc.
    hostProcPath: process.env.HOST_PROC_PATH?.trim() || "/proc",
    // Optional dcgm-exporter scrape URL (Prometheus text format). When set
    // and reachable, the agent prefers DCGM SM_ACTIVE for host GPU and uses
    // MIG-instance metrics for containers attached 1:1 to a MIG slice.
    // Unset/empty = pmon-only path.
    dcgmExporterUrl: dcgmRaw && dcgmRaw.length > 0 ? dcgmRaw : null,
    gpuPerContainerEnabled:
      (process.env.GPU_PER_CONTAINER_ENABLED ?? "true").toLowerCase() !== "false",
  };
}

function readHostHostname(): string | null {
  try {
    return readFileSync("/host/etc/hostname", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
