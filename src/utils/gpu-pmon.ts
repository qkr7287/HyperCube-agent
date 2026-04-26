import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("gpu-pmon");

// pmon -c 1 sleeps ~1s by design (one sample over a 1s window). Anything
// shorter and we just get an empty snapshot. Race with a 1.5s wall to
// catch wedged drivers without killing healthy calls.
const PMON_TIMEOUT_MS = 1500;
// Lightweight queries don't sleep — keep the original 500ms ceiling.
const QUERY_TIMEOUT_MS = 500;
const MAX_BUFFER = 1 << 20;

export interface GpuTopologyEntry {
  index: number;
  uuid: string;
  memoryTotalMib: number;
}

export interface ProcessGpuUsage {
  pid: number;
  gpuIndex: number;
  // MIG instance ids when the GPU is partitioned. null on non-MIG systems.
  gi: number | null;
  ci: number | null;
  // null when pmon can't measure SM% for this PID. Distinct from 0 — see
  // GpuPerContainer doc for why this matters on consumer GPUs.
  smPercent: number | null;
  memoryMib: number;
  // Display label for payload `indices` field — "0" for plain GPUs,
  // "0:1:0" for MIG instances.
  indexLabel: string;
  memoryTotalMib: number;
}

export interface PmonProbeResult {
  available: boolean;
  // Per-process usage, joined across pmon and query-compute-apps.
  processes: ProcessGpuUsage[];
  // Topology for the host (memory totals) so callers can fill memory_total
  // even when no compute-apps are running on a given index.
  topology: GpuTopologyEntry[];
  // Live host GPU utilization (0-100) per index. Used as the fallback
  // signal on consumer GPUs where pmon can't report per-PID SM%.
  hostUtilByGpu: Map<number, number>;
}

type ProbeState = "unknown" | "active" | "none";
let probeState: ProbeState = "unknown";

export function clearPmonStateForTests(): void {
  probeState = "unknown";
}

export async function collectPmonSnapshot(): Promise<PmonProbeResult> {
  if (probeState === "none") {
    return emptyResult();
  }

  const queryGpu = await runQueryGpu();
  if (queryGpu.topology.length === 0) {
    // Either nvidia-smi is missing or it briefly returned an empty list.
    // Treat first-probe failure as terminal so we never re-probe.
    if (probeState === "unknown") {
      probeState = "none";
    }
    return emptyResult();
  }
  probeState = "active";

  const [pmonRows, computeApps] = await Promise.all([
    runPmon(),
    runComputeApps(),
  ]);

  const topology = queryGpu.topology;
  const uuidToIndex = new Map(topology.map((t) => [t.uuid, t.index]));
  const memoryTotalByIndex = new Map(topology.map((t) => [t.index, t.memoryTotalMib]));

  // Merge: pmon owns sm% + MIG ids, compute-apps owns precise VRAM + UUID.
  const memByPid = new Map<number, { mib: number; gpuIndex: number | null }>();
  for (const app of computeApps) {
    const idx = uuidToIndex.get(app.gpuUuid) ?? null;
    memByPid.set(app.pid, { mib: app.usedMemoryMib, gpuIndex: idx });
  }

  const processes: ProcessGpuUsage[] = [];
  for (const row of pmonRows) {
    const memInfo = memByPid.get(row.pid);
    const memoryMib = memInfo?.mib ?? 0;
    const memoryTotalMib = memoryTotalByIndex.get(row.gpuIndex) ?? 0;
    const indexLabel =
      row.gi !== null && row.ci !== null
        ? `${row.gpuIndex}:${row.gi}:${row.ci}`
        : String(row.gpuIndex);

    processes.push({
      pid: row.pid,
      gpuIndex: row.gpuIndex,
      gi: row.gi,
      ci: row.ci,
      smPercent: row.smPercent,
      memoryMib,
      indexLabel,
      memoryTotalMib,
    });
  }

  // PIDs visible in compute-apps but not in pmon — synthesize a row so we
  // still attribute memory to the container. smPercent stays null because
  // we genuinely don't know what it was, not because it was zero.
  for (const [pid, info] of memByPid) {
    if (processes.some((p) => p.pid === pid)) continue;
    if (info.gpuIndex === null) continue;
    processes.push({
      pid,
      gpuIndex: info.gpuIndex,
      gi: null,
      ci: null,
      smPercent: null,
      memoryMib: info.mib,
      indexLabel: String(info.gpuIndex),
      memoryTotalMib: memoryTotalByIndex.get(info.gpuIndex) ?? 0,
    });
  }

  return {
    available: true,
    processes,
    topology,
    hostUtilByGpu: queryGpu.hostUtilByGpu,
  };
}

function emptyResult(): PmonProbeResult {
  return {
    available: false,
    processes: [],
    topology: [],
    hostUtilByGpu: new Map(),
  };
}

interface QueryGpuResult {
  topology: GpuTopologyEntry[];
  hostUtilByGpu: Map<number, number>;
}

async function runQueryGpu(): Promise<QueryGpuResult> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=index,uuid,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
      ],
      {
        timeout: QUERY_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      },
    );
    return parseQueryGpu(stdout);
  } catch (err) {
    log.debug(`query-gpu failed: ${(err as Error).message}`);
    return { topology: [], hostUtilByGpu: new Map() };
  }
}

export function parseQueryGpu(stdout: string): QueryGpuResult {
  const topology: GpuTopologyEntry[] = [];
  const hostUtilByGpu = new Map<number, number>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 3) continue;
    const index = Number(cols[0]);
    const uuid = cols[1];
    const memoryTotalMib = Number(cols[2]);
    if (!Number.isFinite(index) || !uuid || !Number.isFinite(memoryTotalMib)) continue;
    topology.push({ index, uuid, memoryTotalMib });
    if (cols.length >= 4) {
      const util = Number(cols[3]);
      if (Number.isFinite(util)) hostUtilByGpu.set(index, util);
    }
  }
  topology.sort((a, b) => a.index - b.index);
  return { topology, hostUtilByGpu };
}

interface PmonRow {
  pid: number;
  gpuIndex: number;
  gi: number | null;
  ci: number | null;
  smPercent: number | null;
}

async function runPmon(): Promise<PmonRow[]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["pmon", "-c", "1", "-s", "u"],
      {
        timeout: PMON_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      },
    );
    return parsePmon(stdout);
  } catch (err) {
    log.debug(`pmon failed: ${(err as Error).message}`);
    return [];
  }
}

// Exposed for unit tests.
export function parsePmon(stdout: string): PmonRow[] {
  const lines = stdout.split(/\r?\n/);
  // pmon emits two header lines. The first names the columns; we use it to
  // detect MIG mode (presence of `gi`/`ci` columns shifts every offset).
  let columnNames: string[] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#") && /\bgpu\b/i.test(line) && /\bpid\b/i.test(line)) {
      columnNames = line
        .replace(/^#/, "")
        .trim()
        .split(/\s+/)
        .map((c) => c.toLowerCase());
      break;
    }
  }
  if (!columnNames) return [];

  const idxGpu = columnNames.indexOf("gpu");
  const idxPid = columnNames.indexOf("pid");
  const idxSm = columnNames.indexOf("sm");
  const idxGi = columnNames.indexOf("gi");
  const idxCi = columnNames.indexOf("ci");
  if (idxGpu < 0 || idxPid < 0 || idxSm < 0) return [];

  const out: PmonRow[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(/\s+/);
    if (cols.length <= idxSm) continue;

    const gpuIndex = Number(cols[idxGpu]);
    const pid = Number(cols[idxPid]);
    if (!Number.isFinite(gpuIndex) || !Number.isFinite(pid) || pid <= 0) continue;
    // pmon prints "-" for SM% that the driver can't (or won't) report.
    // GeForce/RTX cards always produce "-" because NVIDIA blocks per-PID
    // utilization at the driver level. Distinguishing null from 0 lets the
    // attribution layer fall back to host-util-solo instead of silently
    // reporting "container is using 0% GPU".
    const smRaw = cols[idxSm];
    let smPercent: number | null;
    if (smRaw === "-" || smRaw === undefined) {
      smPercent = null;
    } else {
      const n = Number(smRaw);
      if (!Number.isFinite(n)) continue;
      smPercent = n;
    }

    const gi = idxGi >= 0 ? parseMigId(cols[idxGi]) : null;
    const ci = idxCi >= 0 ? parseMigId(cols[idxCi]) : null;
    out.push({ pid, gpuIndex, gi, ci, smPercent });
  }
  return out;
}

function parseMigId(value: string | undefined): number | null {
  if (!value || value === "-") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface ComputeAppRow {
  pid: number;
  usedMemoryMib: number;
  gpuUuid: string;
}

async function runComputeApps(): Promise<ComputeAppRow[]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-compute-apps=pid,used_memory,gpu_uuid",
        "--format=csv,noheader,nounits",
      ],
      {
        timeout: QUERY_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      },
    );
    return parseComputeApps(stdout);
  } catch (err) {
    log.debug(`query-compute-apps failed: ${(err as Error).message}`);
    return [];
  }
}

export function parseComputeApps(stdout: string): ComputeAppRow[] {
  const out: ComputeAppRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const usedMemoryMib = Number(cols[1]);
    const gpuUuid = cols[2];
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!Number.isFinite(usedMemoryMib) || !gpuUuid) continue;
    out.push({ pid, usedMemoryMib, gpuUuid });
  }
  return out;
}
