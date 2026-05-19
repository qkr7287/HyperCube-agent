import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("cpu-power");

// Linux exposes per-package RAPL energy counters here. AMD chips on
// kernels >= 5.8 use the same intel-rapl path (the directory name predates
// AMD support and was never renamed).
const RAPL_REL_DIR = "class/powercap/intel-rapl";
const DOMAIN_REGEX = /^intel-rapl:\d+$/;
const UJ_PER_J = 1_000_000;

interface PrevSample {
  totalEnergyUj: number;
  ts: number;
}

// Module-level state: the energy counter is monotonic, so we need the
// previous reading to derive Watts. First call returns null (no baseline);
// every subsequent call returns the average power since the previous call.
let prev: PrevSample | null = null;
// Once we've classified the host as "no RAPL" stay silent — readdir would
// otherwise log a warning every collection tick on CPU-only / virtualized
// hosts. Re-classification happens at next process restart.
let probedMissing = false;

export function resetCpuPowerStateForTests(): void {
  prev = null;
  probedMissing = false;
}

export async function getPackagePowerW(hostSysPath: string): Promise<number | null> {
  if (probedMissing) return null;

  const total = await readTotalPackageEnergy(hostSysPath);
  const now = Date.now();

  if (total === null) {
    prev = null;
    return null;
  }

  const previous = prev;
  prev = { totalEnergyUj: total, ts: now };

  if (!previous) return null;

  const dtSec = (now - previous.ts) / 1000;
  if (dtSec <= 0) return null;

  const deltaUj = total - previous.totalEnergyUj;
  // Counter wrapped (32/64-bit overflow) or a domain disappeared and the
  // summed total shrank. Either way we can't trust this sample — drop it
  // and let the next interval establish a fresh baseline.
  if (deltaUj < 0) return null;

  const watts = deltaUj / UJ_PER_J / dtSec;
  return Math.round(watts * 10) / 10;
}

async function readTotalPackageEnergy(hostSysPath: string): Promise<number | null> {
  const baseDir = path.join(hostSysPath, RAPL_REL_DIR);

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    if (!probedMissing) {
      log.debug(`RAPL unavailable at ${baseDir}: ${(err as Error).message}`);
      probedMissing = true;
    }
    return null;
  }

  const domainDirs = entries.filter((e) => DOMAIN_REGEX.test(e));
  if (domainDirs.length === 0) return null;

  let total = 0;
  let anyValid = false;
  for (const dir of domainDirs) {
    try {
      const raw = await fs.readFile(path.join(baseDir, dir, "energy_uj"), "utf-8");
      const v = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(v)) {
        total += v;
        anyValid = true;
      }
    } catch {
      // EPERM (kernel >= 5.10 restricts to root) or domain gone — skip.
      // A missing domain just means the sum is incomplete this tick.
    }
  }

  return anyValid ? total : null;
}
