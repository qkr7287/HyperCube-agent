import si from "systeminformation";
import os from "node:os";
import { readLoggedInUsers } from "../utils/utmp.js";
import { getCpuTopology } from "../utils/cpu-topology.js";
import { collectGpuMetrics } from "../utils/gpu-topology.js";
import type { SystemMetrics } from "../types/index.js";

export async function collectSystemMetrics(
  hostname: string,
  dcgmExporterUrl: string | null = null,
): Promise<SystemMetrics> {
  const [load, cpu, mem, disk, netIfaces, netStats, netConns, dockerInfo, procs, logins, gpu] =
    await Promise.all([
      si.currentLoad(),
      si.cpu(),
      si.mem(),
      si.fsSize(),
      si.networkInterfaces("default"),
      // systeminformation v5: networkStats() does NOT treat "default" as a
      // magic string (unlike networkInterfaces). Passing "default" literally
      // looks up an iface named "default", fails, and returns rx/tx = 0.
      // Call with no args so the library resolves the default iface itself.
      si.networkStats(),
      si.networkConnections(),
      si.dockerInfo().catch(() => null),
      si.processes().catch(() => ({ all: 0, running: 0 })),
      readLoggedInUsers().catch(() => []),
      collectGpuMetrics(dcgmExporterUrl).catch(() => []),
    ]);

  const topology = await getCpuTopology(load.cpus.length);
  const modelBase = `${cpu.manufacturer} ${cpu.brand}`.trim();
  const cpuModel =
    topology.sockets > 1 ? `${modelBase} × ${topology.sockets}` : modelBase;

  const rootDisk = disk.find((d) => d.mount === "/" || d.mount === "C:\\") ?? disk[0];

  const ifaceNames = Array.isArray(netIfaces)
    ? netIfaces.map((i) => i.iface)
    : [netIfaces.iface];

  const netStat = Array.isArray(netStats) ? netStats[0] : netStats;

  return {
    hostname,
    os: `${os.type()} ${os.release()}`,
    uptime: os.uptime(),
    cpu: {
      model: cpuModel,
      sockets: topology.sockets,
      cores: topology.cores,
      threads: topology.threads,
      isHybrid: topology.isHybrid,
      performanceCores: topology.performanceCores,
      efficiencyCores: topology.efficiencyCores,
      usage: round(load.currentLoad),
      perCore: load.cpus.map((c) => round(c.load)),
      ...(os.platform() === "linux" ? { loadAvg1m: round(os.loadavg()[0]) } : {}),
    },
    memory: buildMemoryInfo(mem),
    disk: rootDisk
      ? {
          total: rootDisk.size,
          used: rootDisk.used,
          free: rootDisk.available,
          usage: round(rootDisk.use),
        }
      : { total: 0, used: 0, free: 0, usage: 0 },
    network: {
      interfaces: ifaceNames,
      connections: netConns.length,
      rx: netStat?.rx_bytes ?? 0,
      tx: netStat?.tx_bytes ?? 0,
    },
    docker: dockerInfo
      ? {
          version: dockerInfo.serverVersion ?? "unknown",
          containers: dockerInfo.containers ?? 0,
          images: dockerInfo.images ?? 0,
        }
      : { version: "unavailable", containers: 0, images: 0 },
    processes: {
      total: procs.all,
      running: procs.running,
    },
    logins: {
      total: logins.length,
      active: logins.length,
    },
    gpu: gpu.map(annotateGpuMemoryPercent),
  };
}

function buildMemoryInfo(mem: si.Systeminformation.MemData): {
  total: number;
  available: number;
  used: number;
  free: number;
  usage: number;
} {
  const total = mem.total;
  // si.mem().available maps to MemAvailable on Linux and to OS-native
  // "available" on Windows/macOS. Fallback to (total - free) only when the
  // library couldn't read it — accuracy degrades but at least we don't crash.
  const available =
    typeof mem.available === "number" && mem.available > 0
      ? mem.available
      : Math.max(total - mem.free, 0);
  const used = Math.max(total - available, 0);
  const usage = total > 0 ? round((used / total) * 100) : 0;
  return { total, available, used, free: mem.free, usage };
}

function annotateGpuMemoryPercent(g: import("../types/index.js").GpuMetric) {
  if (g.memoryTotal > 0) {
    return { ...g, memoryPercent: round((g.memoryUsed / g.memoryTotal) * 100) };
  }
  return g;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
