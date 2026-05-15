import os from "node:os";
import { promises as fs } from "node:fs";
import si from "systeminformation";
import { collectGpuInventory } from "../utils/gpu-inventory.js";
import { defaultCommandRunner, type CommandRunner } from "../utils/command-runner.js";
import { collectLvmThinPoolInfo } from "../workspace-lvm.js";
import type { AppConfig, CapacityReportData, CapacityReportMessage } from "../types/index.js";

export async function buildCapacityReport(
  config: AppConfig,
  agentId: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CapacityReportMessage> {
  return {
    type: "capacity_report",
    agentId,
    timestamp: new Date().toISOString(),
    data: await collectHostCapacity(config, runner),
  };
}

export async function collectHostCapacity(
  config: AppConfig,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CapacityReportData> {
  const cpus = os.cpus();
  const [disk, network, gpu, distro, cgroupVersion, lvm, agentVersion] = await Promise.all([
    collectRootDisk(runner),
    collectPrimaryNetwork(runner),
    collectGpuCapacity(),
    readDistro(),
    collectCgroupVersion(runner),
    collectLvmThinPoolInfo(config.lvmWorkspace, runner),
    readAgentVersion(),
  ]);

  return {
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model ?? null,
      architecture: process.arch,
    },
    memory: {
      totalMb: Math.round(os.totalmem() / 1024 / 1024),
    },
    disk: {
      rootTotalGb: disk.rootTotalGb,
      rootUsedGb: disk.rootUsedGb,
      filesystem: disk.filesystem,
      lvm,
    },
    network,
    gpu,
    os: {
      distro,
      kernel: os.release(),
      cgroupVersion,
    },
    agent: {
      version: agentVersion,
      nodeVersion: process.version,
    },
  };
}

async function readAgentVersion(): Promise<string> {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const parsed = JSON.parse(await fs.readFile(packageUrl, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function collectRootDisk(runner: CommandRunner): Promise<{
  rootTotalGb: number | null;
  rootUsedGb: number | null;
  filesystem: string | null;
}> {
  try {
    const { stdout } = await runner.run("df", ["-B1G", "-T", "/"], {
      timeoutMs: 2_000,
      maxBuffer: 256 * 1024,
    });
    return parseDfRoot(stdout);
  } catch {
    return { rootTotalGb: null, rootUsedGb: null, filesystem: null };
  }
}

export function parseDfRoot(stdout: string): {
  rootTotalGb: number | null;
  rootUsedGb: number | null;
  filesystem: string | null;
} {
  const rows = stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) return { rootTotalGb: null, rootUsedGb: null, filesystem: null };
  const cols = rows[1].split(/\s+/);
  if (cols.length < 6) return { rootTotalGb: null, rootUsedGb: null, filesystem: null };
  return {
    filesystem: cols[1] || null,
    rootTotalGb: parseNumeric(cols[2]),
    rootUsedGb: parseNumeric(cols[3]),
  };
}

async function collectPrimaryNetwork(runner: CommandRunner): Promise<{
  primaryInterface: string | null;
  speedMbps: number | null;
}> {
  try {
    const iface = await si.networkInterfaces("default");
    const item = Array.isArray(iface) ? iface[0] : iface;
    const name = item?.iface || null;
    const siSpeed = typeof item?.speed === "number" && item.speed > 0 ? item.speed : null;
    if (!name) return { primaryInterface: null, speedMbps: null };
    return {
      primaryInterface: name,
      speedMbps: siSpeed ?? await collectEthtoolSpeed(name, runner),
    };
  } catch {
    return { primaryInterface: null, speedMbps: null };
  }
}

async function collectEthtoolSpeed(iface: string, runner: CommandRunner): Promise<number | null> {
  try {
    const { stdout } = await runner.run("ethtool", [iface], {
      timeoutMs: 2_000,
      maxBuffer: 256 * 1024,
    });
    const match = /^\s*Speed:\s*(\d+)Mb\/s\s*$/im.exec(stdout);
    if (!match) return null;
    const speed = Number(match[1]);
    return Number.isFinite(speed) ? speed : null;
  } catch {
    return null;
  }
}

async function collectGpuCapacity(): Promise<CapacityReportData["gpu"]> {
  try {
    const inventory = await collectGpuInventory();
    return {
      count: inventory.gpus.length,
      devices: inventory.gpus.map((gpu) => ({
        index: gpu.index,
        model: gpu.model,
        memoryMb: gpu.totalMemoryMb,
        migEnabled: gpu.migEnabled,
      })),
    };
  } catch {
    return { count: 0, devices: [] };
  }
}

async function readDistro(): Promise<string | null> {
  for (const candidate of ["/host/etc/os-release", "/etc/os-release"]) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      const parsed = parseOsRelease(content);
      if (parsed) return parsed;
    } catch {
      // try next source
    }
  }
  return null;
}

export function parseOsRelease(content: string): string | null {
  const pretty = content
    .split(/\r?\n/)
    .find((line) => line.startsWith("PRETTY_NAME="));
  if (!pretty) return null;
  return pretty
    .slice("PRETTY_NAME=".length)
    .trim()
    .replace(/^"|"$/g, "");
}

async function collectCgroupVersion(runner: CommandRunner): Promise<"v1" | "v2" | "unknown"> {
  try {
    const { stdout } = await runner.run("stat", ["-fc", "%T", "/sys/fs/cgroup"], {
      timeoutMs: 2_000,
      maxBuffer: 64 * 1024,
    });
    const fsType = stdout.trim();
    if (fsType === "cgroup2fs") return "v2";
    if (fsType === "tmpfs" || fsType === "cgroup") return "v1";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function parseNumeric(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/[gG]$/, "").replace(/%$/, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
