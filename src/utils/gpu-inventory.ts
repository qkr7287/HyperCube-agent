import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("gpu-inventory");

const NVIDIA_SMI_TIMEOUT_MS = 1_500;
const MAX_BUFFER = 2 * 1024 * 1024;

const GPU_QUERY_ARGS = [
  "--query-gpu=index,name,uuid,pci.bus_id,memory.total,mig.mode.current",
  "--format=csv,noheader,nounits",
] as const;

export interface GpuInventorySlice {
  deviceId: string;
  kind: "full" | "mig";
  uuid: string;
  profileName?: string;
  totalMemoryMb: number | null;
}

export interface GpuInventoryGpu {
  index: number;
  vendor: "NVIDIA";
  model: string;
  name: string;
  uuid: string;
  pcieBus: string;
  totalMemoryMb: number;
  migCapable: boolean;
  migEnabled: boolean;
  slices: GpuInventorySlice[];
}

export interface GpuInventory extends Record<string, unknown> {
  vendor: "NVIDIA";
  gpus: GpuInventoryGpu[];
}

interface BaseGpuRow {
  index: number;
  model: string;
  uuid: string;
  pcieBus: string;
  totalMemoryMb: number;
  migMode: string;
}

interface NvidiaListGpu {
  index: number;
  uuid: string;
  migDevices: NvidiaListMigDevice[];
}

interface NvidiaListMigDevice {
  uuid: string;
  profileName: string;
}

export async function collectGpuInventory(): Promise<GpuInventory> {
  const baseRows = await queryBaseGpuRows();
  const migByGpu = parseNvidiaSmiList(await queryNvidiaSmiList());

  const gpus = baseRows.map((gpu) => {
    const fromList = migByGpu.get(gpu.uuid);
    const migEnabled = isMigEnabled(gpu.migMode, fromList);
    const migCapable = isMigCapable(gpu.migMode, fromList);
    const migDevices = fromList?.migDevices ?? [];
    const slices =
      migEnabled
        ? migDevices.map((mig) => ({
            deviceId: mig.uuid,
            kind: "mig" as const,
            uuid: mig.uuid,
            profileName: mig.profileName,
            totalMemoryMb: memoryMbFromMigProfile(mig.profileName),
          }))
        : [
            {
              deviceId: gpu.uuid,
              kind: "full" as const,
              uuid: gpu.uuid,
              totalMemoryMb: gpu.totalMemoryMb,
            },
          ];

    return {
      index: gpu.index,
      vendor: "NVIDIA" as const,
      model: gpu.model,
      name: gpu.model,
      uuid: gpu.uuid,
      pcieBus: gpu.pcieBus,
      totalMemoryMb: gpu.totalMemoryMb,
      migCapable,
      migEnabled,
      slices,
    };
  });

  gpus.sort((a, b) => a.index - b.index);
  return { vendor: "NVIDIA", gpus };
}

export function parseGpuQueryCsvForTests(stdout: string): BaseGpuRow[] {
  return parseGpuQueryCsv(stdout);
}

export function parseNvidiaSmiListForTests(stdout: string): Map<string, NvidiaListGpu> {
  return parseNvidiaSmiList(stdout);
}

async function queryBaseGpuRows(): Promise<BaseGpuRow[]> {
  const stdout = await runNvidiaSmi([...GPU_QUERY_ARGS]);
  return parseGpuQueryCsv(stdout);
}

async function queryNvidiaSmiList(): Promise<string> {
  try {
    return await runNvidiaSmi(["-L"]);
  } catch (err) {
    log.debug(`nvidia-smi -L failed: ${(err as Error).message}`);
    return "";
  }
}

async function runNvidiaSmi(args: string[]): Promise<string> {
  const candidates = process.platform === "win32"
    ? ["nvidia-smi", "nvidia-smi.exe"]
    : ["nvidia-smi"];
  let sawEnoent = false;
  let lastMessage = "";

  for (const command of candidates) {
    try {
      const result = await execFileAsync(command, args, {
        timeout: NVIDIA_SMI_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      });
      return result.stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      lastMessage = e.message;
      if (e.code === "ENOENT") {
        sawEnoent = true;
        continue;
      }
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      if (/no devices were found|couldn't communicate with the nvidia driver/i.test(output)) {
        return "";
      }
      log.debug(`${command} failed: ${e.message}`);
      throw new Error(`nvidia-smi query failed: ${e.message}`);
    }
  }

  // nvidia-smi binary not installed → treat the host as "no GPUs" rather
  // than an error. Mirrors how "no devices were found" / driver-unreachable
  // are handled above, and stops backend gpu_inventory polls from logging
  // an ERROR every cycle on CPU-only hosts.
  if (sawEnoent) {
    log.debug("nvidia-smi not installed; reporting empty GPU inventory");
    return "";
  }
  throw new Error(lastMessage || "nvidia-smi not available");
}

function parseGpuQueryCsv(stdout: string): BaseGpuRow[] {
  const rows: BaseGpuRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 5) continue;

    const index = Number(cols[0]);
    const model = cols[1];
    const uuid = cols[2];
    const pcieBus = cols[3];
    const totalMemoryMb = Number(cols[4]);
    const migMode = cols[5] ?? "N/A";

    if (
      !Number.isFinite(index) ||
      !model ||
      !uuid ||
      !Number.isFinite(totalMemoryMb)
    ) {
      continue;
    }

    rows.push({ index, model, uuid, pcieBus, totalMemoryMb, migMode });
  }
  return rows.sort((a, b) => a.index - b.index);
}

function parseNvidiaSmiList(stdout: string): Map<string, NvidiaListGpu> {
  const byGpu = new Map<string, NvidiaListGpu>();
  let current: NvidiaListGpu | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const gpuMatch = /^GPU\s+(\d+):\s+.+?\(UUID:\s+(GPU-[^)]+)\)/.exec(line);
    if (gpuMatch) {
      current = {
        index: Number(gpuMatch[1]),
        uuid: gpuMatch[2],
        migDevices: [],
      };
      byGpu.set(current.uuid, current);
      continue;
    }

    const migMatch = /^MIG\s+(.+?)\s+Device\s+\d+:\s+\(UUID:\s+(MIG-[^)]+)\)/.exec(line);
    if (migMatch && current) {
      current.migDevices.push({
        profileName: migMatch[1].trim(),
        uuid: migMatch[2],
      });
    }
  }

  return byGpu;
}

function isMigEnabled(mode: string, fromList: NvidiaListGpu | undefined): boolean {
  const normalized = mode.toLowerCase();
  return normalized.includes("enabled") || (fromList?.migDevices.length ?? 0) > 0;
}

function isMigCapable(mode: string, fromList: NvidiaListGpu | undefined): boolean {
  const normalized = mode.toLowerCase();
  if (normalized.includes("enabled") || normalized.includes("disabled")) return true;
  return (fromList?.migDevices.length ?? 0) > 0;
}

function memoryMbFromMigProfile(profileName: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*gb/i.exec(profileName);
  if (!match) return null;
  const gb = Number(match[1]);
  if (!Number.isFinite(gb)) return null;
  return Math.round(gb * 1024);
}
