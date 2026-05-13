import type Dockerode from "dockerode";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import type { AppConfig } from "../types/index.js";
import { lookupContainerIdByPid } from "../utils/gpu-cgroup.js";

const log = createLogger("handler:container-processes");

// CPU% needs Δjiffy / Δwall, so two samples 100ms apart. Anything shorter
// rounds to single-jiffy noise; anything longer ties up the dispatcher.
const CPU_SAMPLE_INTERVAL_MS = 100;
// Linux x86 default. /proc/<pid>/stat utime/stime are in clock ticks.
const CLK_TCK = 100;
// Bound concurrent /proc reads — high enough to stay fast on 1000+ PID
// containers, low enough that a stuck read can't exhaust file descriptors.
const PROC_READ_CONCURRENCY = 32;

const SORT_ALLOWED = new Set(["cpu", "mem"]);
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 20;

interface ContainerProcessesParams {
  containerId?: string;
  sortBy?: string;
  limit?: number;
}

interface PidStat {
  utime: number;
  stime: number;
  state: string;
}

interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
  cpu_percent: number;
  memory_rss: number;
  state: string;
  user: string;
}

export async function handleContainerProcesses(
  docker: Dockerode,
  config: AppConfig,
  rawParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = rawParams as ContainerProcessesParams;
  const containerId = params.containerId;
  if (!containerId || typeof containerId !== "string") {
    throw new Error("containerId is required");
  }
  const sortBy = SORT_ALLOWED.has(params.sortBy ?? "")
    ? (params.sortBy as "cpu" | "mem")
    : "cpu";
  const limit = clampLimit(params.limit);

  const container = docker.getContainer(containerId);
  let inspect;
  try {
    inspect = await container.inspect();
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404) throw new Error("container_not_found");
    throw err;
  }
  if (!inspect.State?.Running) {
    throw new Error("container_not_running");
  }
  const fullId = inspect.Id;
  const shortId = fullId.slice(0, 12);

  log.info(`processes container=${shortId} sortBy=${sortBy} limit=${limit}`);

  const pids = await collectContainerPids(docker, container, fullId, shortId, config.hostProcPath);
  if (pids.length === 0) {
    return {
      containerId: shortId,
      total: 0,
      processes: [],
    };
  }

  const sample1 = await sampleStats(config.hostProcPath, pids);
  const sample1At = Date.now();
  await sleep(CPU_SAMPLE_INTERVAL_MS);
  const sample2 = await sampleStats(config.hostProcPath, pids);
  const sample2At = Date.now();
  const elapsedSec = Math.max(0.001, (sample2At - sample1At) / 1000);

  const livePids = Array.from(sample2.keys());
  const metadata = await readMetadata(config.hostProcPath, livePids);

  const processes: ProcessInfo[] = [];
  for (const pid of livePids) {
    const s1 = sample1.get(pid);
    const s2 = sample2.get(pid);
    const meta = metadata.get(pid);
    if (!s2 || !meta) continue;
    const cpuPct = s1
      ? Math.max(
          0,
          ((s2.utime + s2.stime - s1.utime - s1.stime) / CLK_TCK / elapsedSec) * 100,
        )
      : 0; // PID appeared between samples — no baseline, report 0
    processes.push({
      pid,
      name: meta.name,
      command: meta.command,
      cpu_percent: round1(cpuPct),
      memory_rss: meta.rss,
      state: s2.state,
      user: meta.user,
    });
  }

  processes.sort((a, b) => {
    const diff = sortBy === "cpu" ? b.cpu_percent - a.cpu_percent : b.memory_rss - a.memory_rss;
    if (diff !== 0) return diff;
    return a.pid - b.pid; // tie-breaker for stable order
  });

  return {
    containerId: shortId,
    total: livePids.length,
    processes: processes.slice(0, limit),
  };
}

// ---- PID enumeration ----
//
// container.top() asks the daemon to run host ps inside the container's pid
// namespace — image-agnostic (no exec into the container) and very fast.
// Fall back to scanning /host/proc when top() fails (paused containers,
// permission edges, ps absent on the host).

async function collectContainerPids(
  _docker: Dockerode,
  container: Dockerode.Container,
  fullId: string,
  shortId: string,
  hostProcPath: string,
): Promise<number[]> {
  try {
    const top = await container.top();
    const titles = (top as { Titles?: string[] }).Titles ?? [];
    const rows = (top as { Processes?: string[][] }).Processes ?? [];
    const pidIdx = titles.indexOf("PID");
    if (pidIdx >= 0 && rows.length > 0) {
      const pids = rows
        .map((row) => parseInt(row[pidIdx] ?? "", 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (pids.length > 0) return pids;
    }
    log.debug("container.top() returned no usable rows; falling back to cgroup scan");
  } catch (err) {
    log.debug(`container.top() failed: ${(err as Error).message}; falling back to cgroup scan`);
  }
  return scanCgroupForPids(hostProcPath, fullId, shortId);
}

async function scanCgroupForPids(
  hostProcPath: string,
  _fullId: string,
  shortId: string,
): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(hostProcPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error("permission_denied");
    }
    throw err;
  }
  const allPids = entries
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);

  const owned: number[] = [];
  for (let i = 0; i < allPids.length; i += PROC_READ_CONCURRENCY) {
    const batch = allPids.slice(i, i + PROC_READ_CONCURRENCY);
    const ids = await Promise.all(
      batch.map((pid) => lookupContainerIdByPid(hostProcPath, pid)),
    );
    for (let j = 0; j < batch.length; j++) {
      if (ids[j] === shortId) owned.push(batch[j]);
    }
  }
  return owned;
}

// ---- /proc parsing ----

async function sampleStats(
  hostProcPath: string,
  pids: number[],
): Promise<Map<number, PidStat>> {
  const out = new Map<number, PidStat>();
  for (let i = 0; i < pids.length; i += PROC_READ_CONCURRENCY) {
    const batch = pids.slice(i, i + PROC_READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (pid) => {
        try {
          const text = await fs.readFile(path.join(hostProcPath, String(pid), "stat"), "utf-8");
          return [pid, parseStat(text)] as const;
        } catch {
          return [pid, null] as const;
        }
      }),
    );
    for (const [pid, stat] of results) {
      if (stat) out.set(pid, stat);
    }
  }
  return out;
}

interface PidMetadata {
  name: string;
  command: string;
  rss: number;
  user: string;
}

async function readMetadata(
  hostProcPath: string,
  pids: number[],
): Promise<Map<number, PidMetadata>> {
  const out = new Map<number, PidMetadata>();
  for (let i = 0; i < pids.length; i += PROC_READ_CONCURRENCY) {
    const batch = pids.slice(i, i + PROC_READ_CONCURRENCY);
    const results = await Promise.all(batch.map((pid) => readOneMetadata(hostProcPath, pid)));
    for (let j = 0; j < batch.length; j++) {
      const meta = results[j];
      if (meta) out.set(batch[j], meta);
    }
  }
  return out;
}

async function readOneMetadata(
  hostProcPath: string,
  pid: number,
): Promise<PidMetadata | null> {
  const dir = path.join(hostProcPath, String(pid));
  try {
    const [statusText, cmdlineBuf, commText] = await Promise.all([
      fs.readFile(path.join(dir, "status"), "utf-8").catch(() => ""),
      fs.readFile(path.join(dir, "cmdline")).catch(() => Buffer.alloc(0)),
      fs.readFile(path.join(dir, "comm"), "utf-8").catch(() => ""),
    ]);
    const rss = parseVmRss(statusText);
    const uid = parseUid(statusText);
    const command = parseCmdline(cmdlineBuf);
    const comm = commText.replace(/\n$/, "").trim();
    const name = comm || (command ? command.split(/\s+/)[0] : "");
    return { name, command: command || comm, rss, user: uid };
  } catch {
    return null;
  }
}

// /proc/<pid>/stat: pid (comm) state ppid ... utime stime
// comm may contain spaces and parens; the safe parse splits at the LAST `)`.
function parseStat(text: string): PidStat | null {
  const lastParen = text.lastIndexOf(")");
  if (lastParen < 0) return null;
  const after = text.slice(lastParen + 2).trim();
  const fields = after.split(/\s+/);
  // After comm, field 1 = state, ..., field 12 = utime, field 13 = stime.
  // (Indices 0-based starting from `state`.)
  if (fields.length < 14) return null;
  const state = fields[0] ?? "";
  const utime = parseInt(fields[11], 10);
  const stime = parseInt(fields[12], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utime, stime, state };
}

function parseVmRss(statusText: string): number {
  const match = statusText.match(/^VmRSS:\s+(\d+)\s*kB/m);
  if (!match) return 0;
  const kb = parseInt(match[1], 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function parseUid(statusText: string): string {
  const match = statusText.match(/^Uid:\s+(\d+)/m);
  return match ? match[1] : "0";
}

function parseCmdline(buf: Buffer): string {
  if (buf.length === 0) return "";
  // NULL-separated argv. Trailing NULL is normal. Some kernel threads leave
  // cmdline empty — caller falls back to comm.
  const stripped = buf[buf.length - 1] === 0 ? buf.subarray(0, buf.length - 1) : buf;
  return stripped.toString("utf-8").replace(/\0/g, " ").trim();
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || value === null) return LIMIT_DEFAULT;
  if (!Number.isFinite(value)) return LIMIT_DEFAULT;
  const n = Math.floor(value);
  if (n < LIMIT_MIN) return LIMIT_MIN;
  if (n > LIMIT_MAX) return LIMIT_MAX;
  return n;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
