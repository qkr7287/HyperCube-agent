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
// systeminformation.graphics() shells out to lspci/lshw which may hang
// indefinitely (or take seconds) when those binaries are missing or slow.
// Race the entire fallback against the same 500ms ceiling as nvidia-smi.
const GRAPHICS_FALLBACK_TIMEOUT_MS = 500;

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
// Once the systeminformation fallback returns (or times out), reuse its
// result for the rest of the process lifetime. Fallback values are static
// (memoryUsed/usage are 0, no temperature) so caching is safe — and it
// stops repeatedly invoking lspci/lshw on slim images where every call
// hangs until the cycle timeout fires.
let cachedFallback: GpuMetric[] | null = null;

// Process-lifetime probe state. The fallback path (systeminformation +
// lspci) is only needed on hosts that actually have NVIDIA hardware that
// nvidia-smi can't speak to, which is rare. Most hosts fall into:
//   - "nvidia": nvidia-smi works, call it every tick.
//   - "fallback": no nvidia-smi but systeminformation saw a GPU once
//     (e.g. iGPU). Return the cached value every tick thereafter, never
//     re-run nvidia-smi or the fallback.
//   - "none": neither path found anything. Short-circuit to [] forever.
type GpuProbe = "unknown" | "nvidia" | "fallback" | "none";
let probeState: GpuProbe = "unknown";

export function clearGpuTopologyCacheForTests(): void {
  cachedTopology = null;
  cachedFallback = null;
  probeState = "unknown";
}

export async function collectGpuMetrics(): Promise<GpuMetric[]> {
  // Fast paths: once we've classified the host, never re-probe.
  if (probeState === "none") return [];
  if (probeState === "fallback") return cachedFallback ?? [];

  // probeState is "unknown" or "nvidia"
  const nvidia = await collectNvidia();
  if (nvidia.length > 0) {
    probeState = "nvidia";
    rememberTopology(nvidia);
    return nvidia;
  }

  if (probeState === "nvidia") {
    // Host previously had a working nvidia-smi. A transient failure
    // shouldn't serve stale cached numbers or trip us into the
    // fallback — just skip this tick.
    return [];
  }

  // First probe on this host: try fallback once, then commit.
  const fallback = await collectGraphicsFallback();
  probeState = fallback.length === 0 ? "none" : "fallback";
  return fallback;
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
  if (cachedFallback !== null) return cachedFallback;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<GpuMetric[]>((resolve) => {
    timeoutHandle = setTimeout(() => {
      log.debug(`graphics fallback timed out after ${GRAPHICS_FALLBACK_TIMEOUT_MS}ms`);
      resolve([]);
    }, GRAPHICS_FALLBACK_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([runGraphicsFallback(), timeoutPromise]);
    cachedFallback = result;
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function runGraphicsFallback(): Promise<GpuMetric[]> {
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
