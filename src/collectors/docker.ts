import Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type { ContainerInfo, ContainerMetrics } from "../types/index.js";

const RETRY_INTERVAL = 30_000;
const CONCURRENCY_LIMIT = 10;
const STATS_TIMEOUT = 3_000;
const log = createLogger("docker");

export class DockerCollector {
  private docker: Dockerode;
  private available = false;
  private lastRetryAt = 0;

  constructor(socketPath: string) {
    this.docker = new Dockerode({ socketPath });
  }

  get isAvailable(): boolean {
    return this.available;
  }

  getDocker(): Dockerode | null {
    return this.available ? this.docker : null;
  }

  async probe(): Promise<boolean> {
    try {
      await this.docker.ping();
      if (!this.available) {
        log.info("Docker connection established.");
      }
      this.available = true;
      return true;
    } catch {
      if (this.available) {
        log.warn("Docker connection lost. Will retry every 30s.");
      }
      this.available = false;
      this.lastRetryAt = Date.now();
      return false;
    }
  }

  private shouldRetry(): boolean {
    return Date.now() - this.lastRetryAt >= RETRY_INTERVAL;
  }

  async collectContainers(): Promise<ContainerInfo[]> {
    if (!this.available) {
      if (!this.shouldRetry()) return [];
      const ok = await this.probe();
      if (!ok) return [];
    }

    try {
      const containers = await this.docker.listContainers({ all: true });
      return containers.map((c) => ({
        id: c.Id.slice(0, 12),
        name: (c.Names[0] ?? "").replace(/^\//, ""),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports.map((p) => ({
          IP: p.IP,
          PrivatePort: p.PrivatePort,
          PublicPort: p.PublicPort,
          Type: p.Type,
        })),
        created: c.Created,
        labels: c.Labels ?? {},
        networks: extractUserNetworks(c),
        mounts: extractVolumeMounts(c),
      }));
    } catch (err) {
      log.warn(`collectContainers failed: ${(err as Error).message}`);
      this.available = false;
      this.lastRetryAt = Date.now();
      return [];
    }
  }

  async collectAllContainerMetrics(
    containers: ContainerInfo[],
  ): Promise<Record<string, ContainerMetrics>> {
    if (!this.available) return {};

    const running = containers.filter((c) => c.state === "running");
    const metrics: Record<string, ContainerMetrics> = {};

    for (let i = 0; i < running.length; i += CONCURRENCY_LIMIT) {
      const batch = running.slice(i, i + CONCURRENCY_LIMIT);
      const results = await Promise.allSettled(
        batch.map((c) => this.collectSingleMetrics(c.id)),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          metrics[result.value.containerId] = result.value;
        }
      }
    }

    return metrics;
  }

  private async collectSingleMetrics(
    containerId: string,
  ): Promise<ContainerMetrics | null> {
    const container = this.docker.getContainer(containerId);
    const stats = await Promise.race([
      container.stats({ stream: false }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`stats timeout for ${containerId}`)), STATS_TIMEOUT),
      ),
    ]);

    const s = stats as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cpuUsage = calculateCpuPercent(s);
    const memUsage = s.memory_stats?.usage ?? 0;
    const memLimit = s.memory_stats?.limit ?? 1;

    const networks = s.networks ?? {};
    let rxTotal = 0;
    let txTotal = 0;
    for (const iface of Object.values(networks)) {
      const net = iface as { rx_bytes?: number; tx_bytes?: number };
      rxTotal += net.rx_bytes ?? 0;
      txTotal += net.tx_bytes ?? 0;
    }

    const blkio = s.blkio_stats?.io_service_bytes_recursive ?? [];
    let diskRead = 0;
    let diskWrite = 0;
    for (const entry of blkio) {
      const e = entry as { op?: string; value?: number };
      if (e.op === "read" || e.op === "Read") diskRead += e.value ?? 0;
      if (e.op === "write" || e.op === "Write") diskWrite += e.value ?? 0;
    }

    return {
      containerId,
      cpu: {
        usage: round(cpuUsage),
        cores: s.cpu_stats?.online_cpus ?? 1,
      },
      memory: {
        usage: memUsage,
        limit: memLimit,
        percent: round((memUsage / memLimit) * 100),
      },
      network: { rx: rxTotal, tx: txTotal },
      disk: { read: diskRead, write: diskWrite },
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function calculateCpuPercent(stats: any): number {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) -
    (stats.precpu_stats?.system_cpu_usage ?? 0);

  if (systemDelta <= 0 || cpuDelta < 0) return 0;

  const onlineCpus = stats.cpu_stats?.online_cpus ?? 1;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

const BUILT_IN_NETWORKS = new Set(["bridge", "host", "none"]);

function extractUserNetworks(c: Dockerode.ContainerInfo): string[] {
  const networks = c.NetworkSettings?.Networks ?? {};
  return Object.keys(networks).filter((name) => !BUILT_IN_NETWORKS.has(name));
}

interface DockerMount {
  Type?: string;
  Name?: string;
}

function extractVolumeMounts(c: Dockerode.ContainerInfo): { name: string; type: "volume" }[] {
  const mounts = (c.Mounts ?? []) as DockerMount[];
  return mounts
    .filter((m) => m.Type === "volume" && typeof m.Name === "string" && m.Name.length > 0)
    .map((m) => ({ name: m.Name as string, type: "volume" as const }));
}
