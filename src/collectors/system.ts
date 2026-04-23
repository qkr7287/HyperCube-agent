import si from "systeminformation";
import os from "node:os";
import { readLoggedInUsers } from "../utils/utmp.js";
import { getCpuTopology } from "../utils/cpu-topology.js";
import { collectGpuMetrics } from "../utils/gpu-topology.js";
import type { SystemMetrics } from "../types/index.js";

export async function collectSystemMetrics(hostname: string): Promise<SystemMetrics> {
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
      collectGpuMetrics().catch(() => []),
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
    },
    memory: {
      total: mem.total,
      used: mem.used,
      free: mem.free,
      usage: round((mem.used / mem.total) * 100),
    },
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
    gpu,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
