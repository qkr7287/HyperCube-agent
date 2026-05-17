import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("cpu-temp");

const THERMAL_REL_DIR = "class/thermal";
const ZONE_PREFIX = "thermal_zone";

// Preferred zone types in order. x86_pkg_temp is the package-level sensor
// on modern Intel; coretemp aggregates per-core (max), k10temp is the AMD
// counterpart. Anything else is usually ACPI/chipset and unreliable as a
// "CPU" reading — we use it only as a last-resort fallback.
const PREFERRED_TYPES = ["x86_pkg_temp", "coretemp", "k10temp"];

let probedMissing = false;

export function resetCpuTempStateForTests(): void {
  probedMissing = false;
}

export async function getPackageTempC(hostSysPath: string): Promise<number | null> {
  if (probedMissing) return null;

  const baseDir = path.join(hostSysPath, THERMAL_REL_DIR);

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    if (!probedMissing) {
      log.debug(`thermal_zone unavailable at ${baseDir}: ${(err as Error).message}`);
      probedMissing = true;
    }
    return null;
  }

  const zones = entries.filter((e) => e.startsWith(ZONE_PREFIX));
  if (zones.length === 0) return null;

  const readings: Array<{ type: string; tempC: number }> = [];
  for (const zone of zones) {
    try {
      const [typeStr, tempStr] = await Promise.all([
        fs.readFile(path.join(baseDir, zone, "type"), "utf-8"),
        fs.readFile(path.join(baseDir, zone, "temp"), "utf-8"),
      ]);
      const type = typeStr.trim();
      const milliC = Number.parseInt(tempStr.trim(), 10);
      if (!Number.isFinite(milliC)) continue;
      // milli-celsius → °C, rounded to 0.1.
      readings.push({ type, tempC: Math.round(milliC / 100) / 10 });
    } catch {
      // ignore unreadable zone
    }
  }

  if (readings.length === 0) return null;

  for (const pref of PREFERRED_TYPES) {
    const match = readings.find((r) => r.type === pref);
    if (match) return match.tempC;
  }

  // No preferred sensor — return the hottest zone we found.
  return readings.reduce((max, r) => (r.tempC > max ? r.tempC : max), readings[0].tempC);
}
