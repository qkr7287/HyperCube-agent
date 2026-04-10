import si from "systeminformation";
import { createLogger } from "../logger.js";
import type { SystemInfoSubCommand } from "../types/index.js";

const log = createLogger("handler:system-info");

const VALID_SUB_COMMANDS = new Set<SystemInfoSubCommand>([
  "cpu_detail", "processes", "network_detail", "users",
]);

const MAX_PROCESSES = 50;

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
  }
}

async function getCpuDetail(): Promise<Record<string, unknown>> {
  const [load, temp, cpu] = await Promise.all([
    si.currentLoad(),
    si.cpuTemperature().catch(() => null),
    si.cpu(),
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
  };
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
  const [ifaces, stats] = await Promise.all([
    si.networkInterfaces(),
    si.networkStats(),
  ]);

  const ifaceList = Array.isArray(ifaces) ? ifaces : [ifaces];
  const statList = Array.isArray(stats) ? stats : [stats];

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
    stats: statList.map((s) => ({
      iface: s.iface,
      rxBytes: s.rx_bytes,
      txBytes: s.tx_bytes,
      rxSec: round(s.rx_sec ?? 0),
      txSec: round(s.tx_sec ?? 0),
    })),
  };
}

async function getUsers(): Promise<Record<string, unknown>> {
  const users = await si.users();

  return {
    users: users.map((u) => ({
      user: u.user,
      terminal: u.tty,
      date: u.date,
      time: u.time,
      ip: u.ip,
      command: u.command,
    })),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
