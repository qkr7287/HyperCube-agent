import { readFile, access } from "node:fs/promises";

export interface CpuTopology {
  sockets: number;
  cores: number;
  threads: number;
  isHybrid: boolean;
  performanceCores: number;
  efficiencyCores: number;
}

// CPU topology is static per boot. Cache for the process lifetime.
let cached: CpuTopology | null = null;

export async function getCpuTopology(fallbackThreads: number): Promise<CpuTopology> {
  if (cached) return cached;
  cached = await readCpuTopology(fallbackThreads);
  return cached;
}

async function readCpuTopology(fallbackThreads: number): Promise<CpuTopology> {
  try {
    const cpuinfo = await readLinuxCpuInfo();
    const hybrid = await detectHybrid();
    return parseLinuxTopology(cpuinfo, hybrid);
  } catch {
    // Non-Linux (macOS/Windows Docker Desktop) — best-effort fallback.
    return {
      sockets: 1,
      cores: fallbackThreads,
      threads: fallbackThreads,
      isHybrid: false,
      performanceCores: fallbackThreads,
      efficiencyCores: 0,
    };
  }
}

async function readLinuxCpuInfo(): Promise<string> {
  // Prefer the explicit host bind mount; fall back to /proc which is the
  // host's /proc anyway when the container runs with pid: host.
  try {
    return await readFile("/host/proc/cpuinfo", "utf8");
  } catch {
    return await readFile("/proc/cpuinfo", "utf8");
  }
}

function parseLinuxTopology(cpuinfo: string, hybrid: HybridInfo): CpuTopology {
  const entries = cpuinfo
    .split(/\n\n+/)
    .filter((b) => b.trim().length > 0)
    .map((block) => {
      const kv: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const m = line.match(/^([^:]+?)\s*:\s*(.*)$/);
        if (m) kv[m[1].trim()] = m[2];
      }
      return kv;
    });

  const threads = entries.length;
  const sockets = new Set(entries.map((e) => e["physical id"] ?? "0")).size;
  // Multi-socket systems reuse core id 0..N per socket; key on the pair.
  const coreKeys = new Set(
    entries.map((e) => `${e["physical id"] ?? "0"}::${e["core id"] ?? "0"}`),
  );
  const cores = coreKeys.size;

  if (!hybrid.isHybrid) {
    return {
      sockets,
      cores,
      threads,
      isHybrid: false,
      performanceCores: cores,
      efficiencyCores: 0,
    };
  }

  // Intel hybrid: P-cores ship with SMT2, E-cores with SMT1.
  return {
    sockets,
    cores,
    threads,
    isHybrid: true,
    performanceCores: Math.round(hybrid.pThreads / 2),
    efficiencyCores: hybrid.eThreads,
  };
}

interface HybridInfo {
  isHybrid: boolean;
  pThreads: number;
  eThreads: number;
}

async function detectHybrid(): Promise<HybridInfo> {
  const [pExists, eExists] = await Promise.all([
    exists("/sys/devices/cpu_core"),
    exists("/sys/devices/cpu_atom"),
  ]);
  if (!pExists || !eExists) {
    return { isHybrid: false, pThreads: 0, eThreads: 0 };
  }
  const [pRange, eRange] = await Promise.all([
    readFile("/sys/devices/cpu_core/cpus", "utf8").catch(() => ""),
    readFile("/sys/devices/cpu_atom/cpus", "utf8").catch(() => ""),
  ]);
  return {
    isHybrid: true,
    pThreads: rangeCount(pRange),
    eThreads: rangeCount(eRange),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// "0-15,17,19-21" -> 16 + 1 + 3 = 20
function rangeCount(spec: string): number {
  return spec
    .trim()
    .split(",")
    .filter(Boolean)
    .reduce((sum, part) => {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return sum;
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      return sum + (end - start + 1);
    }, 0);
}
