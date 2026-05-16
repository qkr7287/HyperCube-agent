import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createLogger } from "./logger.js";
import { defaultCommandRunner, type CommandRunner } from "./utils/command-runner.js";
import type { WorkspaceQuotaConfig, WorkspaceQuotaInfo, WorkspaceUsage } from "./types/index.js";

const log = createLogger("workspace:quota");

// Container metadata labels written at create time so usage collection,
// teardown, and recovery can find the workspace without consulting backend
// state. Format mirrors the LVM-era labels but the values are quota-shaped.
export const WORKSPACE_LABELS = {
  managed: "app.hypercube.workspace.managed",
  shortId: "app.hypercube.workspace.shortId",
  path: "app.hypercube.workspace.path",
  projectId: "app.hypercube.workspace.projectId",
  hardGb: "app.hypercube.workspace.hardGb",
  mountTarget: "app.hypercube.workspace.mountTarget",
} as const;

const MANAGED_LABEL_VALUE = "xfs-prjquota";
const SAFE_SHORT_ID = /^[a-f0-9]{12}$/;
const MAX_WORKSPACE_SIZE_GB = 1_000_000;
// Project id space: keep above the 100000 boundary so we never collide with
// system-defined projects and below 24-bit so a single sha256(shortId) prefix
// fits without further hashing.
const PROJECT_ID_MIN = 100_000;
const PROJECT_ID_MAX = 16_777_215;
const PROJECT_ID_SPAN = PROJECT_ID_MAX - PROJECT_ID_MIN + 1;

const PROJECTS_MAPPING_FILE = ".projects";

export interface WorkspaceQuotaRequest {
  hardGb: number;
  mountTarget: string;
}

export interface PrepareContainerWorkspaceOptions {
  shortId: string;
  hardGb: number;
  mountTarget?: string;
}

export interface PreparedWorkspace {
  shortId: string;
  path: string;
  projectId: number;
  hardGb: number;
  mountTarget: string;
}

interface ProvisionState {
  workspacePath: string;
  projectId: number;
  directoryCreated: boolean;
  projectAttached: boolean;
  quotaSet: boolean;
  mappingAppended: boolean;
}

export class WorkspaceQuotaManager {
  constructor(
    private readonly config: WorkspaceQuotaConfig,
    private readonly runner: CommandRunner = defaultCommandRunner,
  ) {
    if (!path.isAbsolute(config.mountRoot)) {
      throw new Error("WORKSPACE_QUOTA_MOUNT must be an absolute path");
    }
  }

  async prepare(opts: PrepareContainerWorkspaceOptions): Promise<PreparedWorkspace> {
    if (!this.config.enabled) {
      throw new Error("Workspace quota provisioning is disabled on this agent");
    }
    const shortId = normalizeShortId(opts.shortId);
    const hardGb = normalizeHardGb(opts.hardGb);
    const mountTarget = normalizeMountTarget(opts.mountTarget);
    const projectId = projectIdFor(shortId);
    const workspacePath = workspacePathFor(this.config.mountRoot, shortId);

    const state: ProvisionState = {
      workspacePath,
      projectId,
      directoryCreated: false,
      projectAttached: false,
      quotaSet: false,
      mappingAppended: false,
    };

    try {
      await fs.mkdir(workspacePath, { recursive: true });
      state.directoryCreated = true;

      await this.runner.run(
        "xfs_quota",
        ["-x", "-c", `project -s -p ${workspacePath} ${projectId}`, this.config.mountRoot],
        { timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
      );
      state.projectAttached = true;

      await this.runQuota(projectId, hardGb);
      state.quotaSet = true;

      await this.appendProjectMapping(projectId, shortId);
      state.mappingAppended = true;

      return { shortId, path: workspacePath, projectId, hardGb, mountTarget };
    } catch (err) {
      await this.rollback(state);
      throw new Error(`workspace quota provision failed: ${formatCommandError(err)}`);
    }
  }

  async teardown(opts: { shortId: string }): Promise<void> {
    const shortId = normalizeShortId(opts.shortId);
    const projectId = projectIdFor(shortId);
    const workspacePath = workspacePathFor(this.config.mountRoot, shortId);
    const errors: string[] = [];

    if (this.config.enabled) {
      await this.runCleanup(
        "setquota",
        ["-P", String(projectId), "0", "0", "0", "0", this.config.mountRoot],
        errors,
      );
      await this.runCleanup(
        "xfs_quota",
        ["-x", "-c", `project -C -p ${workspacePath} ${projectId}`, this.config.mountRoot],
        errors,
      );
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (err) {
      errors.push(`rm -rf ${workspacePath} failed: ${formatCommandError(err)}`);
    }

    await this.removeProjectMapping(projectId).catch((err) => {
      log.debug(`projects mapping prune failed: ${formatCommandError(err)}`);
    });

    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
  }

  private async runQuota(projectId: number, hardGb: number): Promise<void> {
    const hardBytes = String(BigInt(hardGb) * BigInt(1024) * BigInt(1024) * BigInt(1024));
    await this.runner.run(
      "setquota",
      ["-P", String(projectId), hardBytes, hardBytes, "0", "0", this.config.mountRoot],
      { timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
    );
  }

  private async appendProjectMapping(projectId: number, shortId: string): Promise<void> {
    const mappingPath = path.posix.join(this.config.mountRoot, PROJECTS_MAPPING_FILE);
    const entry = `${projectId}:hc-${shortId}\n`;
    try {
      await fs.appendFile(mappingPath, entry, { encoding: "utf-8", mode: 0o644 });
    } catch (err) {
      // Mapping is purely cosmetic (so xfs_quota report -h shows hc-<shortId>);
      // don't fail the whole provision if /var/lib/hypercube/workspaces is RO
      // or the agent lacks write permission. Log and continue.
      log.warn(`projects mapping append failed: ${formatCommandError(err)}`);
    }
  }

  private async removeProjectMapping(projectId: number): Promise<void> {
    const mappingPath = path.posix.join(this.config.mountRoot, PROJECTS_MAPPING_FILE);
    let content: string;
    try {
      content = await fs.readFile(mappingPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const prefix = `${projectId}:`;
    const kept = content
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith(prefix));
    const next = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
    await fs.writeFile(mappingPath, next, { encoding: "utf-8", mode: 0o644 });
  }

  private async rollback(state: ProvisionState): Promise<void> {
    const errors: string[] = [];
    if (state.quotaSet) {
      await this.runCleanup(
        "setquota",
        ["-P", String(state.projectId), "0", "0", "0", "0", this.config.mountRoot],
        errors,
      );
    }
    if (state.projectAttached) {
      await this.runCleanup(
        "xfs_quota",
        [
          "-x",
          "-c",
          `project -C -p ${state.workspacePath} ${state.projectId}`,
          this.config.mountRoot,
        ],
        errors,
      );
    }
    if (state.directoryCreated) {
      try {
        await fs.rm(state.workspacePath, { recursive: true, force: true });
      } catch (err) {
        errors.push(`rm -rf ${state.workspacePath} failed: ${formatCommandError(err)}`);
      }
    }
    if (state.mappingAppended) {
      await this.removeProjectMapping(state.projectId).catch((err) => {
        errors.push(`projects mapping rollback failed: ${formatCommandError(err)}`);
      });
    }
    if (errors.length > 0) {
      log.warn(`rollback completed with cleanup errors: ${errors.join("; ")}`);
    }
  }

  private async runCleanup(command: string, args: readonly string[], errors: string[]): Promise<void> {
    try {
      await this.runner.run(command, args, { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      if (isIgnorableCleanupError(err)) return;
      errors.push(`${command} ${args.join(" ")} failed: ${formatCommandError(err)}`);
    }
  }
}

// Module-level convenience that mirrors the handoff signature
// (`prepareContainerWorkspace`, `teardownContainerWorkspace`) for callers
// that just want the default runner. Tests can still construct the manager
// directly to inject a fake runner.
export async function prepareContainerWorkspace(
  opts: PrepareContainerWorkspaceOptions,
  config: WorkspaceQuotaConfig,
  runner: CommandRunner = defaultCommandRunner,
): Promise<PreparedWorkspace> {
  return new WorkspaceQuotaManager(config, runner).prepare(opts);
}

export async function teardownContainerWorkspace(
  opts: { shortId: string },
  config: WorkspaceQuotaConfig,
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  return new WorkspaceQuotaManager(config, runner).teardown(opts);
}

// Stable [100_000, 16_777_215] mapping. sha256 first 24 bits modulo the
// span. The output range matches the XFS project id space used by
// `xfs_quota project` without colliding with system-reserved ids (<100k).
export function projectIdFor(shortId: string): number {
  const normalized = normalizeShortId(shortId);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
  const n = parseInt(digest, 16);
  return PROJECT_ID_MIN + (n % PROJECT_ID_SPAN);
}

export function workspacePathFor(mountRoot: string, shortId: string): string {
  return path.posix.join(mountRoot, normalizeShortId(shortId));
}

export function labelsForPreparedWorkspace(workspace: PreparedWorkspace): Record<string, string> {
  return {
    [WORKSPACE_LABELS.managed]: MANAGED_LABEL_VALUE,
    [WORKSPACE_LABELS.shortId]: workspace.shortId,
    [WORKSPACE_LABELS.path]: workspace.path,
    [WORKSPACE_LABELS.projectId]: String(workspace.projectId),
    [WORKSPACE_LABELS.hardGb]: String(workspace.hardGb),
    [WORKSPACE_LABELS.mountTarget]: workspace.mountTarget,
  };
}

export function workspaceFromLabels(labels: Record<string, string> | undefined): PreparedWorkspace | null {
  if (!labels || labels[WORKSPACE_LABELS.managed] !== MANAGED_LABEL_VALUE) return null;
  const shortId = labels[WORKSPACE_LABELS.shortId];
  const workspacePath = labels[WORKSPACE_LABELS.path];
  const projectId = Number(labels[WORKSPACE_LABELS.projectId]);
  const hardGb = Number(labels[WORKSPACE_LABELS.hardGb]);
  const mountTarget = labels[WORKSPACE_LABELS.mountTarget] || "/workspace";

  if (!shortId || !workspacePath || !Number.isInteger(projectId) || !Number.isInteger(hardGb) || hardGb <= 0) {
    return null;
  }
  try {
    normalizeShortId(shortId);
    normalizeMountTarget(mountTarget);
    validateAbsoluteHostPath(workspacePath, "workspace.path label");
  } catch {
    return null;
  }

  return { shortId, path: workspacePath, projectId, hardGb, mountTarget };
}

export async function collectWorkspaceQuotaInfo(
  config: WorkspaceQuotaConfig,
  runner: CommandRunner = defaultCommandRunner,
): Promise<WorkspaceQuotaInfo> {
  if (!config.enabled) {
    return {
      available: false,
      mountPath: null,
      totalGb: null,
      freeGb: null,
      hardEnforced: false,
    };
  }

  let totalGb: number | null = null;
  let freeGb: number | null = null;
  try {
    const { stdout } = await runner.run(
      "df",
      ["-B1G", "--output=size,avail", config.mountRoot],
      { timeoutMs: 5_000, maxBuffer: 256 * 1024 },
    );
    const parsed = parseDfSizeAvail(stdout);
    totalGb = parsed.totalGb;
    freeGb = parsed.freeGb;
  } catch (err) {
    log.debug(`df ${config.mountRoot} failed: ${formatCommandError(err)}`);
    return {
      available: false,
      mountPath: config.mountRoot,
      totalGb: null,
      freeGb: null,
      hardEnforced: false,
    };
  }

  const hardEnforced = await detectHardEnforcement(config.mountRoot, runner);
  return {
    available: true,
    mountPath: config.mountRoot,
    totalGb,
    freeGb,
    hardEnforced,
  };
}

async function detectHardEnforcement(mountRoot: string, runner: CommandRunner): Promise<boolean> {
  let stateOk = false;
  try {
    await runner.run("xfs_quota", ["-x", "-c", "state", mountRoot], {
      timeoutMs: 5_000,
      maxBuffer: 256 * 1024,
    });
    stateOk = true;
  } catch {
    stateOk = false;
  }
  if (!stateOk) return false;
  try {
    const { stdout } = await runner.run("findmnt", ["-no", "OPTIONS", mountRoot], {
      timeoutMs: 2_000,
      maxBuffer: 64 * 1024,
    });
    return /(^|,)prjquota(,|$)/.test(stdout.trim());
  } catch {
    return false;
  }
}

export async function collectWorkspaceUsageFromLabels(
  labels: Record<string, string> | undefined,
  config: WorkspaceQuotaConfig,
  runner: CommandRunner = defaultCommandRunner,
): Promise<WorkspaceUsage | undefined> {
  const workspace = workspaceFromLabels(labels);
  if (!workspace) return undefined;
  if (!config.enabled) {
    // Hard-cap is configured at create time; without enabled tooling we
    // cannot measure usage. Still emit the contract shape so the frontend
    // KPI renders a denominator without a live xfs_quota call.
    return {
      path: workspace.path,
      projectId: workspace.projectId,
      hardGb: workspace.hardGb,
      usedGb: 0,
      availableGb: workspace.hardGb,
      usedPct: 0,
    };
  }
  try {
    const { stdout } = await runner.run(
      "xfs_quota",
      ["-x", "-c", `report -h -p -N ${config.mountRoot}`],
      { timeoutMs: 5_000, maxBuffer: 1024 * 1024 },
    );
    const usedGb = parseXfsQuotaUsedGb(stdout, workspace.projectId) ?? 0;
    const availableGb = Math.max(workspace.hardGb - usedGb, 0);
    const usedPct = workspace.hardGb > 0
      ? round1((usedGb / workspace.hardGb) * 100)
      : 0;
    return {
      path: workspace.path,
      projectId: workspace.projectId,
      hardGb: workspace.hardGb,
      usedGb: round1(usedGb),
      availableGb: round1(availableGb),
      usedPct,
    };
  } catch (err) {
    log.debug(`xfs_quota report failed for project ${workspace.projectId}: ${formatCommandError(err)}`);
    return undefined;
  }
}

// `xfs_quota -x -c "report -h -p -N <mount>"` emits one line per project:
//   <project_or_id>  <used_human>  <soft>  <hard>  ...
// `-N` strips the column header, `-h` produces human sizes (`100M`, `1.5G`).
// We match either the bare projectId or `#<projectId>` (xfsprogs uses both
// depending on whether the projects mapping file is loaded).
export function parseXfsQuotaUsedGb(stdout: string, projectId: number): number | null {
  const idStr = String(projectId);
  const hashIdStr = `#${projectId}`;
  const projectName = `hc-`;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const head = cols[0];
    const matchesId =
      head === idStr ||
      head === hashIdStr ||
      head.startsWith(projectName) && cols.includes(idStr);
    if (!matchesId) continue;
    const usedGb = parseHumanSizeToGb(cols[1]);
    if (usedGb !== null) return usedGb;
  }
  return null;
}

export function parseHumanSizeToGb(token: string): number | null {
  if (!token) return null;
  const cleaned = token.trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMGTP]?)$/i.exec(cleaned);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  switch (unit) {
    case "":
    case "B":
      return value / (1024 * 1024 * 1024);
    case "K":
      return value / (1024 * 1024);
    case "M":
      return value / 1024;
    case "G":
      return value;
    case "T":
      return value * 1024;
    case "P":
      return value * 1024 * 1024;
  }
  return null;
}

export function parseDfSizeAvail(stdout: string): { totalGb: number | null; freeGb: number | null } {
  const rows = stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) return { totalGb: null, freeGb: null };
  const cols = rows[1].split(/\s+/);
  if (cols.length < 2) return { totalGb: null, freeGb: null };
  return {
    totalGb: parseNumeric(cols[0]),
    freeGb: parseNumeric(cols[1]),
  };
}

function normalizeShortId(shortId: string): string {
  if (typeof shortId !== "string") {
    throw new Error("shortId must be a string");
  }
  const lower = shortId.trim().toLowerCase().slice(0, 12);
  if (!SAFE_SHORT_ID.test(lower)) {
    throw new Error("shortId must match ^[a-f0-9]{12}$");
  }
  return lower;
}

function normalizeHardGb(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_WORKSPACE_SIZE_GB) {
    throw new Error(`workspace.hardGb must be an integer in range 1..${MAX_WORKSPACE_SIZE_GB}`);
  }
  return n;
}

function normalizeMountTarget(value: string | undefined): string {
  const target = typeof value === "string" && value.trim().length > 0 ? value.trim() : "/workspace";
  validateAbsoluteHostPath(target, "workspace.mountTarget");
  return target;
}

function validateAbsoluteHostPath(value: string, name: string): void {
  if (!value.startsWith("/") || value.includes("\n") || value.includes("\0") || value.includes(":")) {
    throw new Error(`${name} must be an absolute path without colon or control characters`);
  }
}

function parseNumeric(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/[gG]$/, "").replace(/%$/, "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isIgnorableCleanupError(err: unknown): boolean {
  const message = formatCommandError(err).toLowerCase();
  return (
    message.includes("no such file") ||
    message.includes("not found") ||
    message.includes("does not exist")
  );
}

function formatCommandError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  const output = `${e.stderr ?? ""} ${e.stdout ?? ""}`.trim();
  return output || e.message || String(err);
}

// Optional normaliser used by create_container payloads. Accepts the backend
// contract `{ hardGb, mountTarget }`; rejects everything else so a malformed
// payload fails fast at the agent instead of producing a no-op container.
export function normalizeWorkspaceQuotaRequest(raw: unknown): WorkspaceQuotaRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { hardGb?: unknown; mountTarget?: unknown };
  if (value.hardGb === undefined || value.hardGb === null) return null;
  const hardGb = normalizeHardGb(value.hardGb);
  const mountTarget = normalizeMountTarget(
    typeof value.mountTarget === "string" ? value.mountTarget : undefined,
  );
  return { hardGb, mountTarget };
}

export const __test = {
  MANAGED_LABEL_VALUE,
  PROJECT_ID_MIN,
  PROJECT_ID_MAX,
  normalizeShortId,
  normalizeHardGb,
  normalizeMountTarget,
};
