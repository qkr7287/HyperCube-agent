import si from "systeminformation";
import { promises as fs } from "node:fs";
import os from "node:os";
import { createLogger } from "../logger.js";
import { readLoggedInUsers, readWtmpSessions } from "../utils/utmp.js";
import type { SystemInfoSubCommand } from "../types/index.js";

const log = createLogger("handler:system-info");

const VALID_SUB_COMMANDS = new Set<SystemInfoSubCommand>([
  "cpu_detail", "processes", "network_detail", "users", "users_history",
]);

const MAX_PROCESSES = 50;
const WTMP_PATHS = ["/host/var/log/wtmp", "/var/log/wtmp"] as const;
const USERS_HISTORY_DEFAULT_LIMIT = 100;
const USERS_HISTORY_MAX_LIMIT = 500;

export async function handleSystemInfo(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const subCommand = params.subCommand as SystemInfoSubCommand | undefined;

  if (!subCommand || !VALID_SUB_COMMANDS.has(subCommand)) {
    throw new Error(
      `Invalid subCommand: ${subCommand}. Valid: ${[...VALID_SUB_COMMANDS].join(", ")}`,
    );
  }

  log.info(`Collecting system info: ${subCommand}`);

  switch (subCommand) {
    case "cpu_detail":
      return await getCpuDetail();
    case "processes":
      return await getProcesses(params.sortBy as string | undefined);
    case "network_detail":
      return await getNetworkDetail();
    case "users":
      return await getUsers();
    case "users_history":
      return await getUsersHistory(params.limit);
  }
}

async function getCpuDetail(): Promise<Record<string, unknown>> {
  const [load, temp, cpu, loadAvg] = await Promise.all([
    si.currentLoad(),
    si.cpuTemperature().catch(() => null),
    si.cpu(),
    getLoadAvg(),
  ]);

  return {
    model: `${cpu.manufacturer} ${cpu.brand}`,
    speed: cpu.speed,
    cores: load.cpus.length,
    usage: round(load.currentLoad),
    perCore: load.cpus.map((c, i) => ({
      core: i,
      load: round(c.load),
    })),
    temperature: temp
      ? { main: temp.main, cores: temp.cores, max: temp.max }
      : null,
    loadAvg,
  };
}

async function getLoadAvg(): Promise<{ avg1: number; avg5: number; avg15: number }> {
  try {
    const content = await fs.readFile("/host/proc/loadavg", "utf-8");
    const parts = content.trim().split(/\s+/);
    return {
      avg1: parseFloat(parts[0]),
      avg5: parseFloat(parts[1]),
      avg15: parseFloat(parts[2]),
    };
  } catch {
    const [avg1, avg5, avg15] = os.loadavg();
    return { avg1, avg5, avg15 };
  }
}

async function getProcesses(
  sortBy?: string,
): Promise<Record<string, unknown>> {
  const procs = await si.processes();
  const sortField = sortBy === "mem" ? "memRss" : "cpuu";

  const sorted = procs.list
    .sort((a, b) => (b[sortField] as number) - (a[sortField] as number))
    .slice(0, MAX_PROCESSES);

  return {
    total: procs.all,
    running: procs.running,
    blocked: procs.blocked,
    list: sorted.map((p) => ({
      pid: p.pid,
      name: p.name,
      cpu: round(p.cpuu),
      mem: round(p.memRss / 1024 / 1024),
      state: p.state,
      user: p.user,
      command: p.command.slice(0, 200),
    })),
  };
}

async function getNetworkDetail(): Promise<Record<string, unknown>> {
  const [ifaces, stats, connections] = await Promise.all([
    si.networkInterfaces(),
    getAggregatedNetStats(),
    si.networkConnections().catch(() => []),
  ]);

  const ifaceList = Array.isArray(ifaces) ? ifaces : [ifaces];

  return {
    interfaces: ifaceList.map((i) => ({
      iface: i.iface,
      ip4: i.ip4,
      ip6: i.ip6,
      mac: i.mac,
      type: i.type,
      speed: i.speed,
      operstate: i.operstate,
    })),
    stats,
    connections: connections.length,
  };
}

async function getAggregatedNetStats(): Promise<{
  rx_bytes: number;
  tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
  rx_errors: number;
  tx_errors: number;
}> {
  const empty = {
    rx_bytes: 0, tx_bytes: 0,
    rx_packets: 0, tx_packets: 0,
    rx_errors: 0, tx_errors: 0,
  };
  try {
    const content = await fs.readFile("/host/proc/1/net/dev", "utf-8");
    const lines = content.split("\n").slice(2);
    const agg = { ...empty };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const iface = trimmed.slice(0, colonIdx).trim();
      if (iface === "lo") continue;
      const vals = trimmed.slice(colonIdx + 1).trim().split(/\s+/).map(Number);
      // /proc/net/dev: recv [bytes packets errs drop fifo frame compressed multicast] xmit [bytes packets errs drop fifo colls carrier compressed]
      agg.rx_bytes += vals[0] || 0;
      agg.rx_packets += vals[1] || 0;
      agg.rx_errors += vals[2] || 0;
      agg.tx_bytes += vals[8] || 0;
      agg.tx_packets += vals[9] || 0;
      agg.tx_errors += vals[10] || 0;
    }
    return agg;
  } catch {
    return empty;
  }
}

async function getUsers(): Promise<Record<string, unknown>> {
  try {
    const entries = await readLoggedInUsers();
    return {
      users: entries.map((u) => ({
        user: u.user,
        terminal: u.terminal,
        date: u.loginAt.toISOString().slice(0, 10),
        time: u.loginAt.toISOString().slice(11, 16),
        ip: u.ip || u.host,
        command: "",
      })),
    };
  } catch (err) {
    log.warn(`utmp read failed: ${(err as Error).message}`);
    return { users: [] };
  }
}

async function getUsersHistory(
  rawLimit: unknown,
): Promise<Record<string, unknown>> {
  const limit = clampLimit(rawLimit);

  let readErr: NodeJS.ErrnoException | null = null;
  for (const path of WTMP_PATHS) {
    try {
      const sessions = await readWtmpSessions(path);
      const total = sessions.length;
      const sliced = sessions.slice(0, limit).map((s) => ({
        user: s.user,
        terminal: s.terminal,
        host: s.host,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime ? s.endTime.toISOString() : null,
        durationSeconds: s.durationSeconds,
        active: s.active,
        ...(s.endReason && s.endReason !== "logout" ? { endReason: s.endReason } : {}),
      }));
      return {
        sessions: sliced,
        totalSessions: total,
        truncated: total > limit,
        source: "wtmp",
      };
    } catch (err) {
      readErr = err as NodeJS.ErrnoException;
      if (readErr.code !== "ENOENT") break;
    }
  }

  const reason =
    readErr?.code === "ENOENT"
      ? "wtmp not mounted"
      : `wtmp read failed: ${readErr?.message ?? "unknown error"}`;
  log.warn(`users_history unavailable: ${reason}`);
  return {
    sessions: [],
    totalSessions: 0,
    truncated: false,
    source: "wtmp",
    unavailable: true,
    reason,
  };
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return USERS_HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), USERS_HISTORY_MAX_LIMIT);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
