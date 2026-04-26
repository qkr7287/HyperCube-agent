import { createLogger } from "../logger.js";

const log = createLogger("gpu-dcgm");

const FETCH_TIMEOUT_MS = 500;
// After a failed scrape, hold off for 30s before trying again. dcgm-exporter
// outages shouldn't tax the agent's tick budget, but should also recover on
// their own without restarting the agent.
const RETRY_BACKOFF_MS = 30_000;
// Short cache so the host-GPU and per-container paths can both call this
// in the same tick without scraping twice. 1s is well under the 2s default
// collect interval but long enough to dedupe within one cycle.
const CACHE_TTL_MS = 1_000;

let nextAttemptAt = 0;
let cached: { snapshot: DcgmSnapshot | null; at: number; key: string | null } = {
  snapshot: null,
  at: 0,
  key: null,
};

export interface DcgmHostGpu {
  gpuIndex: number;
  uuid: string | null;
  // Prefer SM_ACTIVE (profiling, hardware counter) over GPU_UTIL (sampling).
  // Both expressed as 0-100. null when the metric was missing.
  smActive: number | null;
  gpuUtil: number | null;
  fbUsedMib: number | null;
  fbTotalMib: number | null;
}

export interface DcgmMigInstance {
  gpuIndex: number;
  giId: number;
  ciId: number | null;
  uuid: string | null;
  smActive: number | null;
  fbUsedMib: number | null;
  fbTotalMib: number | null;
}

export interface DcgmSnapshot {
  hostGpus: DcgmHostGpu[];
  migInstances: DcgmMigInstance[];
}

export function clearDcgmStateForTests(): void {
  nextAttemptAt = 0;
  cached = { snapshot: null, at: 0, key: null };
}

export async function collectDcgmSnapshot(url: string | null): Promise<DcgmSnapshot | null> {
  if (!url) return null;
  const now = Date.now();
  if (cached.key === url && now - cached.at < CACHE_TTL_MS) {
    return cached.snapshot;
  }
  if (now < nextAttemptAt) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      log.debug(`dcgm fetch ${res.status} ${res.statusText}`);
      nextAttemptAt = Date.now() + RETRY_BACKOFF_MS;
      return null;
    }
    const text = await res.text();
    const snapshot = parseDcgmText(text);
    cached = { snapshot, at: Date.now(), key: url };
    return snapshot;
  } catch (err) {
    if (ac.signal.aborted) {
      log.debug(`dcgm fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    } else {
      log.debug(`dcgm fetch failed: ${(err as Error).message}`);
    }
    nextAttemptAt = Date.now() + RETRY_BACKOFF_MS;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface PromSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

// Minimal Prometheus text-format parser. Skips comment/help lines, ignores
// trailing timestamps, handles quoted label values with the standard
// escapes. Good enough for DCGM exporter output; not a general-purpose lib.
export function parsePrometheusText(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sample = parseSampleLine(line);
    if (sample) out.push(sample);
  }
  return out;
}

function parseSampleLine(line: string): PromSample | null {
  const braceStart = line.indexOf("{");
  let metric: string;
  let labels: Record<string, string> = {};
  let rest: string;

  if (braceStart === -1) {
    const space = line.indexOf(" ");
    if (space === -1) return null;
    metric = line.slice(0, space);
    rest = line.slice(space + 1).trim();
  } else {
    metric = line.slice(0, braceStart).trim();
    const braceEnd = findMatchingBrace(line, braceStart);
    if (braceEnd === -1) return null;
    labels = parseLabels(line.slice(braceStart + 1, braceEnd));
    rest = line.slice(braceEnd + 1).trim();
  }

  // Drop optional timestamp.
  const valueStr = rest.split(/\s+/)[0];
  const value = Number(valueStr);
  if (!metric || !Number.isFinite(value)) return null;
  return { metric, labels, value };
}

function findMatchingBrace(line: string, start: number): number {
  let inQuote = false;
  let escaped = false;
  for (let i = start + 1; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "}" && !inQuote) return i;
  }
  return -1;
}

function parseLabels(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (i >= body.length) break;
    const eq = body.indexOf("=", i);
    if (eq === -1) break;
    const key = body.slice(i, eq).trim();
    if (body[eq + 1] !== '"') break;
    let j = eq + 2;
    let value = "";
    while (j < body.length) {
      const ch = body[j];
      if (ch === "\\" && j + 1 < body.length) {
        const nxt = body[j + 1];
        value += nxt === "n" ? "\n" : nxt;
        j += 2;
        continue;
      }
      if (ch === '"') {
        j += 1;
        break;
      }
      value += ch;
      j += 1;
    }
    out[key] = value;
    i = j;
  }
  return out;
}

export function parseDcgmText(text: string): DcgmSnapshot {
  const samples = parsePrometheusText(text);

  const hostByIndex = new Map<number, DcgmHostGpu>();
  const migByKey = new Map<string, DcgmMigInstance>();

  function getHost(gpuIndex: number, uuid: string | null): DcgmHostGpu {
    let entry = hostByIndex.get(gpuIndex);
    if (!entry) {
      entry = {
        gpuIndex,
        uuid,
        smActive: null,
        gpuUtil: null,
        fbUsedMib: null,
        fbTotalMib: null,
      };
      hostByIndex.set(gpuIndex, entry);
    } else if (!entry.uuid && uuid) {
      entry.uuid = uuid;
    }
    return entry;
  }

  function getMig(
    gpuIndex: number,
    giId: number,
    ciId: number | null,
    uuid: string | null,
  ): DcgmMigInstance {
    const key = `${gpuIndex}:${giId}:${ciId ?? "-"}`;
    let entry = migByKey.get(key);
    if (!entry) {
      entry = {
        gpuIndex,
        giId,
        ciId,
        uuid,
        smActive: null,
        fbUsedMib: null,
        fbTotalMib: null,
      };
      migByKey.set(key, entry);
    } else if (!entry.uuid && uuid) {
      entry.uuid = uuid;
    }
    return entry;
  }

  for (const s of samples) {
    const gpuIndex = parseIntLabel(s.labels.gpu);
    if (gpuIndex === null) continue;
    const giId = parseIntLabel(s.labels.GPU_I_ID);
    const ciId = parseIntLabel(s.labels.GPU_C_ID);
    const uuid = s.labels.UUID || s.labels.GPU_I_UUID || null;

    if (giId !== null) {
      const mig = getMig(gpuIndex, giId, ciId, uuid);
      assignMigMetric(mig, s.metric, s.value);
    } else {
      const host = getHost(gpuIndex, uuid);
      assignHostMetric(host, s.metric, s.value);
    }
  }

  return {
    hostGpus: Array.from(hostByIndex.values()).sort((a, b) => a.gpuIndex - b.gpuIndex),
    migInstances: Array.from(migByKey.values()).sort((a, b) =>
      a.gpuIndex - b.gpuIndex || a.giId - b.giId,
    ),
  };
}

function assignHostMetric(target: DcgmHostGpu, metric: string, value: number): void {
  switch (metric) {
    case "DCGM_FI_PROF_SM_ACTIVE":
      // Reported as 0..1 ratio. Normalize to 0..100 for parity with the
      // pmon path and the existing host GPU field.
      target.smActive = clampPercent(value * 100);
      break;
    case "DCGM_FI_DEV_GPU_UTIL":
      target.gpuUtil = clampPercent(value);
      break;
    case "DCGM_FI_DEV_FB_USED":
      target.fbUsedMib = value;
      break;
    case "DCGM_FI_DEV_FB_TOTAL":
      target.fbTotalMib = value;
      break;
  }
}

function assignMigMetric(target: DcgmMigInstance, metric: string, value: number): void {
  switch (metric) {
    case "DCGM_FI_PROF_SM_ACTIVE":
      target.smActive = clampPercent(value * 100);
      break;
    case "DCGM_FI_DEV_FB_USED":
      target.fbUsedMib = value;
      break;
    case "DCGM_FI_DEV_FB_TOTAL":
      target.fbTotalMib = value;
      break;
  }
}

function parseIntLabel(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
