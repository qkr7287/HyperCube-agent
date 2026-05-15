import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createLogger } from "./logger.js";
import { defaultCommandRunner, type CommandRunner } from "./utils/command-runner.js";
import type { LvmThinPoolInfo, LvmWorkspaceConfig, WorkspaceUsage } from "./types/index.js";

const log = createLogger("workspace:lvm");

export const WORKSPACE_LABELS = {
  managed: "app.hypercube.workspace.managed",
  id: "app.hypercube.workspace.id",
  device: "app.hypercube.workspace.device",
  mountPoint: "app.hypercube.workspace.mountPoint",
  sizeGb: "app.hypercube.workspace.sizeGb",
  mountTarget: "app.hypercube.workspace.mountTarget",
  volumeName: "app.hypercube.workspace.volumeName",
} as const;

const MANAGED_LABEL_VALUE = "lvm-thin";
const SAFE_LVM_NAME = /^[A-Za-z0-9_.+-]+$/;
const SAFE_WORKSPACE_ID = /^[a-f0-9]{12}$/;
const MAX_WORKSPACE_SIZE_GB = 1_000_000;

export interface LvmWorkspaceRequest {
  sizeGb: number;
  mountTarget: string;
}

export interface PreparedLvmWorkspace {
  id: string;
  volumeName: string;
  device: string;
  mountPoint: string;
  mountTarget: string;
  sizeGb: number;
}

interface ProvisionState {
  mountPoint: string;
  volumeRef: string;
  mounted: boolean;
  volumeCreated: boolean;
  directoryCreated: boolean;
}

export class LvmWorkspaceManager {
  constructor(
    private readonly config: LvmWorkspaceConfig,
    private readonly runner: CommandRunner = defaultCommandRunner,
  ) {
    validateLvmName(config.volumeGroup, "LVM_WORKSPACE_VG");
    validateLvmName(config.thinPool, "LVM_WORKSPACE_THIN_POOL");
    if (!path.isAbsolute(config.mountRoot)) {
      throw new Error("LVM_WORKSPACE_MOUNT_ROOT must be an absolute path");
    }
  }

  async prepare(request: LvmWorkspaceRequest, workspaceId = newWorkspaceId()): Promise<PreparedLvmWorkspace> {
    if (!this.config.enabled) {
      throw new Error("LVM workspace provisioning is disabled on this agent");
    }
    validateWorkspaceId(workspaceId);
    const req = normalizeLvmWorkspaceRequest(request);
    if (!req) {
      throw new Error("workspace.sizeGb is required for LVM workspace provisioning");
    }
    const volumeName = `cid_${workspaceId}`;
    let device = `/dev/${this.config.volumeGroup}/${volumeName}`;
    const volumeRef = `${this.config.volumeGroup}/${volumeName}`;
    const mountPoint = path.posix.join(this.config.mountRoot, workspaceId);
    const state: ProvisionState = {
      mountPoint,
      volumeRef,
      mounted: false,
      volumeCreated: false,
      directoryCreated: false,
    };

    try {
      await this.runner.run("mkdir", ["-p", mountPoint]);
      state.directoryCreated = true;

      await this.runner.run("lvcreate", [
        "-V",
        `${req.sizeGb}G`,
        "-T",
        `${this.config.volumeGroup}/${this.config.thinPool}`,
        "-n",
        volumeName,
      ], { timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
      state.volumeCreated = true;
      await this.runBestEffort("dmsetup", ["mknodes"]);
      device = await resolveVolumeDevicePath(device, this.config.volumeGroup, volumeName);

      await this.runner.run("mkfs.ext4", ["-F", device], {
        timeoutMs: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      await this.runner.run("mount", [device, mountPoint], {
        timeoutMs: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      state.mounted = true;

      await this.runner.run("chown", [`${this.config.uid}:${this.config.gid}`, mountPoint], {
        timeoutMs: 10_000,
      });

      return {
        id: workspaceId,
        volumeName,
        device,
        mountPoint,
        mountTarget: req.mountTarget,
        sizeGb: req.sizeGb,
      };
    } catch (err) {
      await this.rollback(state);
      throw new Error(`workspace LVM provision failed: ${formatCommandError(err)}`);
    }
  }

  async cleanup(workspace: Pick<PreparedLvmWorkspace, "mountPoint" | "volumeName">): Promise<void> {
    const volumeRef = `${this.config.volumeGroup}/${workspace.volumeName}`;
    const errors: string[] = [];

    await this.runCleanup("umount", [workspace.mountPoint], errors);
    await this.runCleanup("lvremove", ["-f", volumeRef], errors);
    await this.runCleanup("rmdir", [workspace.mountPoint], errors);

    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
  }

  async ensureMounted(workspace: Pick<PreparedLvmWorkspace, "device" | "mountPoint" | "volumeName">): Promise<void> {
    validateLvmName(workspace.volumeName, "workspace volume label");
    validateAbsoluteHostPath(workspace.mountPoint, "workspace mountPoint label");
    await this.runner.run("mkdir", ["-p", workspace.mountPoint]);
    await this.runBestEffort("dmsetup", ["mknodes"]);

    if (!(await this.isMounted(workspace.mountPoint))) {
      const device = await resolveVolumeDevicePath(
        workspace.device,
        this.config.volumeGroup,
        workspace.volumeName,
      );
      await this.runner.run("mount", [device, workspace.mountPoint], {
        timeoutMs: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    }

    await this.runner.run("chown", [`${this.config.uid}:${this.config.gid}`, workspace.mountPoint], {
      timeoutMs: 10_000,
    });
  }

  private async rollback(state: ProvisionState): Promise<void> {
    const errors: string[] = [];
    if (state.mounted) {
      await this.runCleanup("umount", [state.mountPoint], errors);
    }
    if (state.volumeCreated) {
      await this.runCleanup("lvremove", ["-f", state.volumeRef], errors);
    }
    if (state.directoryCreated) {
      await this.runCleanup("rmdir", [state.mountPoint], errors);
    }
    if (errors.length > 0) {
      log.warn(`rollback completed with cleanup errors: ${errors.join("; ")}`);
    }
  }

  private async runCleanup(command: string, args: readonly string[], errors: string[]): Promise<void> {
    try {
      await this.runner.run(command, args, { timeoutMs: 10_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (err) {
      if (isIgnorableCleanupError(err)) return;
      errors.push(`${command} ${args.join(" ")} failed: ${formatCommandError(err)}`);
    }
  }

  private async runBestEffort(command: string, args: readonly string[]): Promise<void> {
    try {
      await this.runner.run(command, args, { timeoutMs: 10_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (err) {
      log.debug(`${command} ${args.join(" ")} failed: ${formatCommandError(err)}`);
    }
  }

  private async isMounted(mountPoint: string): Promise<boolean> {
    try {
      await this.runner.run("findmnt", ["-rn", "--target", mountPoint], {
        timeoutMs: 2_000,
        maxBuffer: 64 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function newWorkspaceId(): string {
  return randomBytes(6).toString("hex");
}

export function normalizeLvmWorkspaceRequest(raw: unknown): LvmWorkspaceRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { sizeGb?: unknown; mountTarget?: unknown };
  if (value.sizeGb === undefined || value.sizeGb === null) return null;

  const sizeGb = Number(value.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb <= 0 || sizeGb > MAX_WORKSPACE_SIZE_GB) {
    throw new Error(`workspace.sizeGb must be an integer in range 1..${MAX_WORKSPACE_SIZE_GB}`);
  }

  const mountTarget =
    typeof value.mountTarget === "string" && value.mountTarget.trim().length > 0
      ? value.mountTarget.trim()
      : "/workspace";
  validateMountTarget(mountTarget);
  return { sizeGb, mountTarget };
}

export function labelsForPreparedWorkspace(workspace: PreparedLvmWorkspace): Record<string, string> {
  return {
    [WORKSPACE_LABELS.managed]: MANAGED_LABEL_VALUE,
    [WORKSPACE_LABELS.id]: workspace.id,
    [WORKSPACE_LABELS.device]: workspace.device,
    [WORKSPACE_LABELS.mountPoint]: workspace.mountPoint,
    [WORKSPACE_LABELS.sizeGb]: String(workspace.sizeGb),
    [WORKSPACE_LABELS.mountTarget]: workspace.mountTarget,
    [WORKSPACE_LABELS.volumeName]: workspace.volumeName,
  };
}

export function workspaceFromLabels(labels: Record<string, string> | undefined): PreparedLvmWorkspace | null {
  if (!labels || labels[WORKSPACE_LABELS.managed] !== MANAGED_LABEL_VALUE) return null;
  const id = labels[WORKSPACE_LABELS.id];
  const volumeName = labels[WORKSPACE_LABELS.volumeName];
  const device = labels[WORKSPACE_LABELS.device];
  const mountPoint = labels[WORKSPACE_LABELS.mountPoint];
  const sizeGb = Number(labels[WORKSPACE_LABELS.sizeGb]);
  const mountTarget = labels[WORKSPACE_LABELS.mountTarget] || "/workspace";

  if (!id || !volumeName || !device || !mountPoint || !Number.isInteger(sizeGb) || sizeGb <= 0) {
    return null;
  }
  validateWorkspaceId(id);
  validateLvmName(volumeName, "workspace volume label");
  validateAbsoluteHostPath(mountPoint, "workspace mountPoint label");
  validateMountTarget(mountTarget);

  return {
    id,
    volumeName,
    device,
    mountPoint,
    mountTarget,
    sizeGb,
  };
}

export async function collectWorkspaceUsageFromLabels(
  labels: Record<string, string> | undefined,
  runner: CommandRunner = defaultCommandRunner,
): Promise<WorkspaceUsage | undefined> {
  const workspace = workspaceFromLabels(labels);
  if (!workspace) return undefined;
  try {
    const { stdout } = await runner.run("df", ["-B1G", workspace.mountPoint], {
      timeoutMs: 2_000,
      maxBuffer: 256 * 1024,
    });
    const parsed = parseDfOneGig(stdout);
    if (!parsed) return undefined;
    return {
      device: workspace.device,
      mountPoint: workspace.mountPoint,
      sizeGb: workspace.sizeGb,
      usedGb: parsed.usedGb,
      availableGb: parsed.availableGb,
      usedPct: parsed.usedPct,
    };
  } catch (err) {
    log.debug(`workspace df failed for ${workspace.mountPoint}: ${(err as Error).message}`);
    return undefined;
  }
}

export async function collectLvmThinPoolInfo(
  config: LvmWorkspaceConfig,
  runner: CommandRunner = defaultCommandRunner,
): Promise<LvmThinPoolInfo> {
  validateLvmName(config.volumeGroup, "LVM_WORKSPACE_VG");
  validateLvmName(config.thinPool, "LVM_WORKSPACE_THIN_POOL");
  if (!config.enabled) {
    return {
      available: false,
      vg: config.volumeGroup,
      thinPool: config.thinPool,
      thinPoolSizeGb: null,
      thinPoolUsedGb: null,
      usedPct: null,
      alert: null,
    };
  }
  try {
    const { stdout } = await runner.run("lvs", [
      "--noheadings",
      "--units",
      "g",
      "--nosuffix",
      "--separator",
      ",",
      "-o",
      "LV_SIZE,Data_percent",
      `${config.volumeGroup}/${config.thinPool}`,
    ], { timeoutMs: 5_000, maxBuffer: 512 * 1024 });
    const parsed = parseLvsThinPool(stdout);
    return {
      available: true,
      vg: config.volumeGroup,
      thinPool: config.thinPool,
      thinPoolSizeGb: parsed.sizeGb,
      thinPoolUsedGb:
        parsed.sizeGb !== null && parsed.usedPct !== null
          ? round1((parsed.sizeGb * parsed.usedPct) / 100)
          : null,
      usedPct: parsed.usedPct,
      alert: alertForThinPool(parsed.usedPct),
    };
  } catch {
    return {
      available: false,
      vg: config.volumeGroup,
      thinPool: config.thinPool,
      thinPoolSizeGb: null,
      thinPoolUsedGb: null,
      usedPct: null,
      alert: null,
    };
  }
}

export function parseLvsThinPool(stdout: string): { sizeGb: number | null; usedPct: number | null } {
  const line = stdout.split(/\r?\n/).map((row) => row.trim()).find(Boolean);
  if (!line) return { sizeGb: null, usedPct: null };
  const [rawSize, rawPct] = line.split(",").map((part) => part.trim());
  const sizeGb = parseNumeric(rawSize);
  const usedPct = parseNumeric(rawPct);
  return {
    sizeGb: sizeGb === null ? null : round1(sizeGb),
    usedPct: usedPct === null ? null : round1(usedPct),
  };
}

export function parseDfOneGig(stdout: string): {
  totalGb: number;
  usedGb: number;
  availableGb: number;
  usedPct: number;
} | null {
  const rows = stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) return null;
  const cols = rows[1].split(/\s+/);
  if (cols.length < 5) return null;
  const totalGb = parseNumeric(cols[1]);
  const usedGb = parseNumeric(cols[2]);
  const availableGb = parseNumeric(cols[3]);
  const usedPct = parseNumeric(cols[4]);
  if (totalGb === null || usedGb === null || availableGb === null || usedPct === null) return null;
  return {
    totalGb,
    usedGb,
    availableGb,
    usedPct,
  };
}

function validateWorkspaceId(id: string): void {
  if (!SAFE_WORKSPACE_ID.test(id)) {
    throw new Error("workspace id must match ^[a-f0-9]{12}$");
  }
}

async function resolveVolumeDevicePath(
  preferred: string,
  vg: string,
  lv: string,
): Promise<string> {
  if (await pathExists(preferred)) return preferred;
  const mapperPath = `/dev/mapper/${escapeDeviceMapperName(vg)}-${escapeDeviceMapperName(lv)}`;
  if (await pathExists(mapperPath)) return mapperPath;
  return preferred;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function escapeDeviceMapperName(name: string): string {
  return name.replace(/-/g, "--");
}

function validateLvmName(value: string, name: string): void {
  if (!SAFE_LVM_NAME.test(value) || value.includes("/") || value === "." || value === "..") {
    throw new Error(`${name} contains unsafe characters`);
  }
}

function validateMountTarget(value: string): void {
  validateAbsoluteHostPath(value, "workspace.mountTarget");
}

function validateAbsoluteHostPath(value: string, name: string): void {
  if (!value.startsWith("/") || value.includes("\n") || value.includes("\0") || value.includes(":")) {
    throw new Error(`${name} must be an absolute path without colon or control characters`);
  }
}

function parseNumeric(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/%$/, "").replace(/[gG]$/, "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function alertForThinPool(usedPct: number | null): "ok" | "warn" | "critical" | null {
  if (usedPct === null) return null;
  if (usedPct >= 90) return "critical";
  if (usedPct >= 80) return "warn";
  return "ok";
}

function isIgnorableCleanupError(err: unknown): boolean {
  const message = formatCommandError(err).toLowerCase();
  return (
    message.includes("not mounted") ||
    message.includes("no mount point specified") ||
    message.includes("no such file") ||
    message.includes("not found") ||
    message.includes("failed to find logical volume")
  );
}

function formatCommandError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  const output = `${e.stderr ?? ""} ${e.stdout ?? ""}`.trim();
  return output || e.message || String(err);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function ensureWorkspaceMountRoot(config: LvmWorkspaceConfig): Promise<void> {
  await fs.mkdir(config.mountRoot, { recursive: true });
}

export const __test = {
  MANAGED_LABEL_VALUE,
  validateMountTarget,
  validateLvmName,
};
