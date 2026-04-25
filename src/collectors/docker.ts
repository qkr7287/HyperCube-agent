import Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type {
  ContainerInfo,
  ContainerMetrics,
  ContainerNetworkStat,
  NetworkMappingMode,
} from "../types/index.js";

const RETRY_INTERVAL = 30_000;
const CONCURRENCY_LIMIT = 10;
const STATS_TIMEOUT = 3_000;
const log = createLogger("docker");

export class DockerCollector {
  private docker: Dockerode;
  private available = false;
  private lastRetryAt = 0;
  private previousNetworkSamples = new Map<string, Map<string, NetworkSample>>();

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
    const runningIds = new Set(running.map((c) => c.id));

    for (let i = 0; i < running.length; i += CONCURRENCY_LIMIT) {
      const batch = running.slice(i, i + CONCURRENCY_LIMIT);
      const results = await Promise.allSettled(
        batch.map((c) => this.collectSingleMetrics(c)),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          metrics[result.value.containerId] = result.value;
        }
      }
    }

    this.pruneNetworkSamples(runningIds);
    return metrics;
  }

  private async collectSingleMetrics(
    containerInfo: ContainerInfo,
  ): Promise<ContainerMetrics | null> {
    const containerId = containerInfo.id;
    const container = this.docker.getContainer(containerId);

    // AbortController over Promise.race: when the timer fires we actually
    // cancel the dockerode HTTP request (closes the socket) instead of
    // letting the original promise leak in the background. Race-with-timeout
    // accumulates orphan promises + sockets and was the proximate cause of
    // V8 heap exhaustion + silent agent crashes.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), STATS_TIMEOUT);
    let stats: unknown;
    try {
      // dockerode runtime supports abortSignal but @types/dockerode omits it
      // from the stats() options; cast through a typed alias.
      const opts = {
        stream: false,
        abortSignal: ac.signal,
      } as unknown as { stream?: false; "one-shot"?: boolean };
      stats = await container.stats(opts);
    } catch (err) {
      if (ac.signal.aborted) {
        throw new Error(`stats timeout for ${containerId}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const s = stats as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cpuUsage = calculateCpuPercent(s);
    const memUsage = s.memory_stats?.usage ?? 0;
    const memLimit = s.memory_stats?.limit ?? 1;
    const sampleTimestamp = typeof s.read === "string" ? s.read : null;
    const sampleTimeMs = parseSampleTime(sampleTimestamp);

    const networks = s.networks ?? {};
    let rxTotal = 0;
    let txTotal = 0;
    for (const iface of Object.values(networks)) {
      const net = iface as { rx_bytes?: number; tx_bytes?: number };
      rxTotal += net.rx_bytes ?? 0;
      txTotal += net.tx_bytes ?? 0;
    }
    const networkStats = this.buildNetworkStats(
      containerInfo,
      networks as Record<string, RawDockerNetworkCounters>,
      sampleTimestamp,
      sampleTimeMs,
    );

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
      network_stats: networkStats,
    };
  }

  private buildNetworkStats(
    containerInfo: ContainerInfo,
    rawNetworks: Record<string, RawDockerNetworkCounters>,
    sampleTimestamp: string | null,
    sampleTimeMs: number,
  ): ContainerNetworkStat[] {
    const interfaceEntries = Object.entries(rawNetworks).sort(([a], [b]) => a.localeCompare(b));
    const userNetworks = (containerInfo.networks ?? []).filter((name) => name.length > 0);
    const exactMatches = new Set(userNetworks.filter((name) => rawNetworks[name] !== undefined));
    const allowSingleNetworkFallback =
      userNetworks.length === 1 && interfaceEntries.length === 1 && exactMatches.size === 0;

    const previousByInterface = this.previousNetworkSamples.get(containerInfo.id) ?? new Map();
    const nextSamples = new Map<string, NetworkSample>();
    const stats = interfaceEntries.map(([interfaceName, counters]) => {
      const prev = previousByInterface.get(interfaceName);
      const networkName =
        exactMatches.has(interfaceName)
          ? interfaceName
          : allowSingleNetworkFallback
            ? userNetworks[0]
            : null;
      const mappingMode: NetworkMappingMode =
        exactMatches.has(interfaceName)
          ? "exact"
          : allowSingleNetworkFallback
            ? "single-network-fallback"
            : "unresolved";

      const rxBytes = counters.rx_bytes ?? 0;
      const txBytes = counters.tx_bytes ?? 0;
      const rxRate = calculateRate(rxBytes, prev?.rxBytes, sampleTimeMs, prev?.sampleTimeMs);
      const txRate = calculateRate(txBytes, prev?.txBytes, sampleTimeMs, prev?.sampleTimeMs);

      nextSamples.set(interfaceName, {
        rxBytes,
        txBytes,
        sampleTimeMs,
      });

      return {
        network_name: networkName,
        interface_name: interfaceName,
        mapping_mode: mappingMode,
        rx_bytes: rxBytes,
        tx_bytes: txBytes,
        rx_rate_bps: rxRate,
        tx_rate_bps: txRate,
        rx_packets: asNullableNumber(counters.rx_packets),
        tx_packets: asNullableNumber(counters.tx_packets),
        errors_rx: asNullableNumber(counters.rx_errors),
        errors_tx: asNullableNumber(counters.tx_errors),
        timestamp: sampleTimestamp,
      } satisfies ContainerNetworkStat;
    });

    this.previousNetworkSamples.set(containerInfo.id, nextSamples);
    return stats;
  }

  private pruneNetworkSamples(runningIds: ReadonlySet<string>): void {
    for (const containerId of this.previousNetworkSamples.keys()) {
      if (!runningIds.has(containerId)) {
        this.previousNetworkSamples.delete(containerId);
      }
    }
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

function roundRate(value: number): number {
  return Math.round(value);
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

interface RawDockerNetworkCounters {
  rx_bytes?: number;
  tx_bytes?: number;
  rx_packets?: number;
  tx_packets?: number;
  rx_errors?: number;
  tx_errors?: number;
}

interface NetworkSample {
  rxBytes: number;
  txBytes: number;
  sampleTimeMs: number;
}

function calculateRate(
  currentBytes: number,
  previousBytes: number | undefined,
  currentTimeMs: number,
  previousTimeMs: number | undefined,
): number | null {
  if (previousBytes === undefined || previousTimeMs === undefined) return null;

  const elapsedMs = currentTimeMs - previousTimeMs;
  if (elapsedMs <= 0) return null;

  const delta = currentBytes - previousBytes;
  if (delta < 0) return null;

  return roundRate((delta / elapsedMs) * 1000);
}

function parseSampleTime(value: string | null): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
