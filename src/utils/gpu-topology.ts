import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import type { GpuMetric } from "../types/index.js";

const execFileAsync = promisify(execFile);
const log = createLogger("gpu");

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
  "--format=csv,noheader,nounits",
];
const NVIDIA_SMI_TIMEOUT_MS = 500;

// Virtual / software display adapters that systeminformation reports
// alongside real GPUs. Filtered out of the fallback output.
const VIRTUAL_ADAPTER_KEYWORDS = [
  "Microsoft Basic Display",
  "llvmpipe",
  "VirtualBox",
  "VMware SVGA",
  "Parallels",
  "Basic Render",
  "Software Adapter",
];

// Process-lifetime cache for static topology fields only. Dynamic values
// (usage/memoryUsed/temperature) are NOT cached — a tick without fresh
// nvidia-smi data falls back to [] rather than returning stale numbers.
interface GpuTopologyEntry {
  index: number;
  vendor: string;
  model: string;
  memoryTotal: number;
}

let cachedTopology: GpuTopologyEntry[] | null = null;

export function clearGpuTopologyCacheForTests(): void {
  cachedTopology = null;
}

export async function collectGpuMetrics(): Promise<GpuMetric[]> {
  const nvidia = await collectNvidia();
  if (nvidia.length > 0) {
    rememberTopology(nvidia);
    return nvidia;
  }
  return collectGraphicsFallback();
}

async function collectNvidia(): Promise<GpuMetric[]> {
  let stdout: string;
  try {
    const result = await execFileAsync("nvidia-smi", NVIDIA_SMI_ARGS, {
      timeout: NVIDIA_SMI_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    // ENOENT / timeout / non-zero exit / permission denied — stay silent.
    // Logging at debug only so GPU-free servers don't spam the log.
    log.debug(`nvidia-smi unavailable: ${(err as Error).message}`);
    return [];
  }
  return parseNvidiaSmiCsv(stdout);
}

// Exposed for unit tests. Kept as a thin alias so the parser itself stays
// private and the test surface is explicit.
export function parseNvidiaSmiCsvForTests(stdout: string): GpuMetric[] {
  return parseNvidiaSmiCsv(stdout);
}

function parseNvidiaSmiCsv(stdout: string): GpuMetric[] {
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: GpuMetric[] = [];
  for (const row of rows) {
    const fields = row.split(",").map((f) => f.trim());
    if (fields.length < 6) continue;

    const index = Number(fields[0]);
    const name = fields[1];
    const memoryTotalMib = Number(fields[2]);
    const memoryUsedMib = Number(fields[3]);
    const usage = Number(fields[4]);
    const temperature = Number(fields[5]);

    if (
      !Number.isFinite(index) ||
      !name ||
      !Number.isFinite(memoryTotalMib) ||
      !Number.isFinite(memoryUsedMib) ||
      !Number.isFinite(usage)
    ) {
      continue;
    }

    const metric: GpuMetric = {
      index,
      vendor: "NVIDIA",
      model: name,
      memoryTotal: mibToBytes(memoryTotalMib),
      memoryUsed: mibToBytes(memoryUsedMib),
      usage,
    };
    if (Number.isFinite(temperature)) {
      metric.temperature = temperature;
    }
    parsed.push(metric);
  }

  parsed.sort((a, b) => a.index - b.index);
  return parsed;
}

function rememberTopology(rows: GpuMetric[]): void {
  cachedTopology = rows.map((r) => ({
    index: r.index,
    vendor: r.vendor,
    model: r.model,
    memoryTotal: r.memoryTotal,
  }));
}

async function collectGraphicsFallback(): Promise<GpuMetric[]> {
  try {
    const mod = (await import("systeminformation")) as unknown as {
      default?: { graphics: () => Promise<{ controllers?: unknown[] }> };
      graphics?: () => Promise<{ controllers?: unknown[] }>;
    };
    const graphicsFn = mod.default?.graphics ?? mod.graphics;
    if (!graphicsFn) return [];
    const graphics = await graphicsFn();
    const controllers = Array.isArray(graphics?.controllers) ? graphics.controllers : [];

    const mapped: GpuMetric[] = [];
    controllers.forEach((raw, idx) => {
      const controller = raw as Record<string, unknown>;
      const modelStr =
        (typeof controller.model === "string" ? controller.model : "") ||
        (typeof controller.name === "string" ? controller.name : "");
      if (!modelStr) return;
      if (VIRTUAL_ADAPTER_KEYWORDS.some((kw) => modelStr.includes(kw))) return;

      const vendorStr =
        typeof controller.vendor === "string" && controller.vendor.length > 0
          ? controller.vendor
          : "Unknown";
      const vram = typeof controller.vram === "number" ? controller.vram : 0;

      mapped.push({
        index: idx,
        vendor: vendorStr,
        model: modelStr,
        memoryTotal: vram > 0 ? mibToBytes(vram) : 0,
        memoryUsed: 0,
        usage: 0,
      });
    });
    return mapped;
  } catch (err) {
    log.debug(`graphics fallback failed: ${(err as Error).message}`);
    return [];
  }
}

function mibToBytes(value: number): number {
  return value * 1024 * 1024;
}
