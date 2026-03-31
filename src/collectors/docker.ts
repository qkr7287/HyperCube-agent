import Dockerode from "dockerode";
import type { ContainerInfo, ContainerMetrics } from "../types/index.js";

let docker: Dockerode | null = null;

export function initDocker(socketPath: string): void {
  docker = new Dockerode({ socketPath });
}

export async function collectContainers(): Promise<ContainerInfo[]> {
  if (!docker) return [];

  const containers = await docker.listContainers({ all: true });

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
  }));
}

export async function collectAllContainerMetrics(
  containers: ContainerInfo[],
): Promise<Record<string, ContainerMetrics>> {
  if (!docker) return {};

  const running = containers.filter((c) => c.state === "running");
  const results = await Promise.allSettled(
    running.map((c) => collectSingleMetrics(c.id)),
  );

  const metrics: Record<string, ContainerMetrics> = {};
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      metrics[result.value.containerId] = result.value;
    }
  }
  return metrics;
}

async function collectSingleMetrics(
  containerId: string,
): Promise<ContainerMetrics | null> {
  if (!docker) return null;

  const container = docker.getContainer(containerId);
  const stats = await container.stats({ stream: false });

  // cast to any for flexible access to Docker stats API fields
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
