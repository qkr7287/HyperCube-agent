import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type {
  AppConfig,
  ContainerInfo,
  GpuPerContainer,
} from "../types/index.js";
import {
  collectPmonSnapshot,
  type PmonProbeResult,
  type ProcessGpuUsage,
} from "../utils/gpu-pmon.js";
import {
  collectDcgmSnapshot,
  type DcgmMigInstance,
  type DcgmSnapshot,
} from "../utils/gpu-dcgm.js";
import { lookupContainerIdsForPids } from "../utils/gpu-cgroup.js";
import { getContainerMigUuids, pruneMigCache } from "../utils/gpu-mig.js";

const log = createLogger("gpu-per-container");

export async function collectGpuPerContainer(
  config: AppConfig,
  docker: Dockerode | null,
  runningContainers: ContainerInfo[],
): Promise<Map<string, GpuPerContainer>> {
  const out = new Map<string, GpuPerContainer>();
  if (!config.gpuPerContainerEnabled) return out;
  if (runningContainers.length === 0) return out;

  // Cheap probe: if pmon says no GPU on this host, dcgm wouldn't help
  // either — short-circuit before any further work.
  const [pmon, dcgm] = await Promise.all([
    collectPmonSnapshot(),
    collectDcgmSnapshot(config.dcgmExporterUrl),
  ]);
  if (!pmon.available && !dcgm) return out;

  const liveIds = new Set(runningContainers.map((c) => c.id));
  pruneMigCache(liveIds);

  // First pass: DCGM-MIG attribution. Only meaningful when DCGM is available
  // and reports MIG instances. Containers attached 1:1 to a MIG slice get
  // hardware-counter accuracy from the DCGM_FI_PROF_* metrics.
  const migAttributed = new Set<string>();
  if (dcgm && dcgm.migInstances.length > 0) {
    await attributeMigContainers(
      docker,
      runningContainers,
      dcgm,
      out,
      migAttributed,
    );
  }

  // Second pass: pmon attribution for everyone else.
  if (pmon.available && pmon.processes.length > 0) {
    await attributePmonContainers(
      config,
      pmon,
      runningContainers,
      migAttributed,
      out,
    );
  }

  if (process.env.GPU_DEBUG_LOG === "1") {
    log.info(
      `probe pmon=${pmon.available} dcgm=${!!dcgm} ` +
        `procs=${pmon.processes.length} attributed=${out.size} ` +
        `migAttributed=${migAttributed.size}`,
    );
    for (const [id, m] of out) {
      log.info(
        `  ${id} src=${m.source} usage=${m.usage} ` +
          `mem=${m.memoryUsed}/${m.memoryTotal}B indices=${m.indices.join(",")}`,
      );
    }
  }
  return out;
}

async function attributeMigContainers(
  docker: Dockerode | null,
  running: ContainerInfo[],
  dcgm: DcgmSnapshot,
  out: Map<string, GpuPerContainer>,
  migAttributed: Set<string>,
): Promise<void> {
  const migByUuid = new Map<string, DcgmMigInstance>();
  for (const inst of dcgm.migInstances) {
    if (inst.uuid) migByUuid.set(inst.uuid, inst);
  }
  if (migByUuid.size === 0) return;

  // Inspect calls run in parallel but bounded — same concurrency as docker
  // stats, since they share the daemon's request budget.
  const CONC = 10;
  for (let i = 0; i < running.length; i += CONC) {
    const batch = running.slice(i, i + CONC);
    const results = await Promise.all(
      batch.map(async (c) => {
        const uuids = await getContainerMigUuids(docker, c.id);
        if (uuids.length === 0) return null;
        const matched: DcgmMigInstance[] = [];
        for (const uuid of uuids) {
          const m = migByUuid.get(uuid);
          if (m) matched.push(m);
        }
        if (matched.length === 0) return null;
        return { containerId: c.id, instances: matched };
      }),
    );
    for (const r of results) {
      if (!r) continue;
      const metric = buildFromMig(r.instances);
      if (metric) {
        out.set(r.containerId, metric);
        migAttributed.add(r.containerId);
      }
    }
  }
}

function buildFromMig(instances: DcgmMigInstance[]): GpuPerContainer | null {
  if (instances.length === 0) return null;

  // Average SM across MIG slices the container holds. fb totals/used are
  // summed because the slices are disjoint memory partitions.
  let smSum = 0;
  let smCount = 0;
  let memUsed = 0;
  let memTotal = 0;
  const indices: string[] = [];
  for (const inst of instances) {
    if (inst.smActive !== null) {
      smSum += inst.smActive;
      smCount += 1;
    }
    if (inst.fbUsedMib !== null) memUsed += inst.fbUsedMib;
    if (inst.fbTotalMib !== null) memTotal += inst.fbTotalMib;
    const ci = inst.ciId !== null ? inst.ciId : 0;
    indices.push(`${inst.gpuIndex}:${inst.giId}:${ci}`);
  }
  return {
    usage: smCount > 0 ? round(smSum / smCount) : 0,
    memoryUsed: mibToBytes(memUsed),
    memoryTotal: mibToBytes(memTotal),
    indices: dedupeSorted(indices),
    source: "dcgm-mig",
  };
}

async function attributePmonContainers(
  config: AppConfig,
  pmon: PmonProbeResult,
  running: ContainerInfo[],
  migAttributed: Set<string>,
  out: Map<string, GpuPerContainer>,
): Promise<void> {
  const pids = pmon.processes.map((p) => p.pid);
  if (pids.length === 0) return;

  const pidToContainer = await lookupContainerIdsForPids(config.hostProcPath, pids);
  if (pidToContainer.size === 0) {
    log.debug("pmon saw GPU PIDs but none mapped to a container");
    return;
  }

  const grouped = new Map<string, ProcessGpuUsage[]>();
  for (const proc of pmon.processes) {
    const containerId = pidToContainer.get(proc.pid);
    if (!containerId) continue;
    if (migAttributed.has(containerId)) continue;
    let bucket = grouped.get(containerId);
    if (!bucket) {
      bucket = [];
      grouped.set(containerId, bucket);
    }
    bucket.push(proc);
  }

  // For each GPU index, count distinct compute containers occupying it.
  // "Compute" here means the PID showed up in --query-compute-apps, which
  // we know because memoryMib > 0. Graphics-only PIDs (Xorg, gnome-shell)
  // are excluded so a desktop session doesn't masquerade as a co-tenant.
  const computeContainersPerGpu = new Map<number, Set<string>>();
  for (const [containerId, procs] of grouped) {
    for (const p of procs) {
      if (p.memoryMib <= 0) continue;
      let bucket = computeContainersPerGpu.get(p.gpuIndex);
      if (!bucket) {
        bucket = new Set();
        computeContainersPerGpu.set(p.gpuIndex, bucket);
      }
      bucket.add(containerId);
    }
  }

  const liveIds = new Set(running.map((c) => c.id));
  for (const [containerId, procs] of grouped) {
    if (!liveIds.has(containerId)) continue;
    const metric = buildContainerMetric(procs, computeContainersPerGpu, pmon.hostUtilByGpu);
    if (metric) out.set(containerId, metric);
  }
}

function buildContainerMetric(
  procs: ProcessGpuUsage[],
  computeContainersPerGpu: Map<number, Set<string>>,
  hostUtilByGpu: Map<number, number>,
): GpuPerContainer | null {
  if (procs.length === 0) return null;

  let memUsed = 0;
  const memoryTotalByGpu = new Map<number, number>();
  const indexLabels: string[] = [];
  const gpusUsed = new Set<number>();
  // Track sm% only when the driver actually reported a number. A single
  // null among the PIDs is enough to know the driver is selectively
  // hiding data, but as long as some PIDs report we can still surface a
  // (lower-bound) measurement.
  const measuredSmByGpu = new Map<number, number>();
  let anyMeasured = false;

  for (const p of procs) {
    gpusUsed.add(p.gpuIndex);
    memUsed += p.memoryMib;
    if (p.memoryTotalMib > 0) memoryTotalByGpu.set(p.gpuIndex, p.memoryTotalMib);
    indexLabels.push(p.indexLabel);
    if (p.smPercent !== null) {
      anyMeasured = true;
      measuredSmByGpu.set(
        p.gpuIndex,
        (measuredSmByGpu.get(p.gpuIndex) ?? 0) + p.smPercent,
      );
    }
  }

  const memTotal = Array.from(memoryTotalByGpu.values()).reduce((a, b) => a + b, 0);
  const indices = dedupeSorted(indexLabels);
  const memUsedMib = Math.round(memUsed);

  // Path 1 — pmon path. Data-center GPUs (and any RTX where the driver
  // unexpectedly cooperates) land here.
  if (anyMeasured) {
    const vals = Array.from(measuredSmByGpu.values());
    const usage = vals.length > 0 ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    return {
      usage,
      memoryUsed: mibToBytes(memUsedMib),
      memoryTotal: mibToBytes(memTotal),
      indices,
      source: "pmon",
    };
  }

  // Path 2 — host-util-solo. RTX consumer GPUs hide per-PID SM%, but if
  // this container is the *only* compute tenant on every GPU it touches,
  // the host-level utilization for those GPUs is unambiguously its own.
  // Not an estimate: it's exact, because there's nobody else's work mixed
  // into the host counter.
  const isSolo = Array.from(gpusUsed).every(
    (g) => (computeContainersPerGpu.get(g)?.size ?? 0) === 1,
  );
  if (isSolo) {
    const utils: number[] = [];
    for (const g of gpusUsed) {
      const u = hostUtilByGpu.get(g);
      if (u !== undefined) utils.push(u);
    }
    if (utils.length > 0) {
      const usage = round(utils.reduce((a, b) => a + b, 0) / utils.length);
      return {
        usage,
        memoryUsed: mibToBytes(memUsedMib),
        memoryTotal: mibToBytes(memTotal),
        indices,
        source: "host-util-solo",
      };
    }
  }

  // Path 3 — vram-only. Multiple compute containers share at least one
  // GPU and the driver won't split SM% by PID. Refuse to fabricate a
  // value; the dashboard surfaces null as "—".
  return {
    usage: null,
    memoryUsed: mibToBytes(memUsedMib),
    memoryTotal: mibToBytes(memTotal),
    indices,
    source: "vram-only",
  };
}

function dedupeSorted(items: string[]): string[] {
  return Array.from(new Set(items)).sort();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function mibToBytes(value: number): number {
  return Math.round(value) * 1024 * 1024;
}
