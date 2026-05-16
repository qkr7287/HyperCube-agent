import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Dockerode from "dockerode";
import { handleCreateContainer, __test as createTest } from "../handlers/create-container.js";
import {
  WorkspaceQuotaManager,
  collectWorkspaceQuotaInfo,
  collectWorkspaceUsageFromLabels,
  labelsForPreparedWorkspace,
  parseDfSizeAvail,
  parseHumanSizeToGb,
  parseXfsQuotaUsedGb,
  prepareContainerWorkspace,
  projectIdFor,
  teardownContainerWorkspace,
  workspaceFromLabels,
  type PreparedWorkspace,
  type PrepareContainerWorkspaceOptions,
} from "../workspace-quota.js";
import {
  buildCapacityReport,
  collectHostCapacity,
  parseDfRoot,
  parseOsRelease,
} from "../collectors/capacity.js";
import type { AppConfig, ProgressEmitter, WorkspaceQuotaConfig } from "../types/index.js";
import type { CommandRunner } from "../utils/command-runner.js";

const ENABLED_QUOTA_CONFIG: WorkspaceQuotaConfig = {
  enabled: true,
  mountRoot: "/var/lib/hypercube/workspaces",
};

const DISABLED_QUOTA_CONFIG: WorkspaceQuotaConfig = {
  enabled: false,
  mountRoot: "/var/lib/hypercube/workspaces",
};

const config: AppConfig = {
  backendUrl: "http://backend.local/ws",
  backendApiUrl: "http://backend.local",
  agentHostname: "self-test-agent",
  collectInterval: 2,
  dockerSocket: "/var/run/docker.sock",
  advertiseIp: null,
  hostProcPath: "/proc",
  dcgmExporterUrl: null,
  gpuPerContainerEnabled: true,
  modelCacheRoot: "/tmp/hypercube-model-cache",
  workspaceQuota: ENABLED_QUOTA_CONFIG,
};

const emitProgress: ProgressEmitter = () => undefined;

async function main(): Promise<void> {
  assertHostConfigAndSharedMountMapping();
  assertParsers();
  await assertCapacityReportSchema();
  await assertCapacityReportDisabledQuotaDoesNotProbe();
  assertProjectIdDeterminismAndRange();
  await assertPrepareCommandOrder();
  await assertTeardownCommandOrder();
  await assertPrepareRollbackOnLimitFailure();
  await assertDockerCreateFailureRollback();
  await assertDockerStartFailureRollback();
  await assertWorkspaceUsageParsing();
  await assertWorkspaceUsageDisabledFallback();
  await maybeRunLiveContainerProof();
  console.log("resource limits and workspace quota self-test passed");
}

function assertHostConfigAndSharedMountMapping(): void {
  const sharedMounts = createTest.buildSharedMounts([
    { source: "/mnt/datasets", target: "/datasets", readOnly: true },
    { source: "/mnt/models", target: "/models" },
  ]);
  const opts = createTest.buildCreateOptions(
    {
      image: "img",
      name: "limits",
      hostConfig: {
        memory: 4_294_967_296,
        memorySwap: 4_294_967_296,
        cpuQuota: 200_000,
        cpuPeriod: 100_000,
        oomKillDisable: false,
      },
    },
    {
      volumes: sharedMounts,
      labels: { "app.hypercube.workspace.shortId": "05eddec05865" },
      hostConfig: {
        memory: 4_294_967_296,
        memorySwap: 4_294_967_296,
        cpuQuota: 200_000,
        cpuPeriod: 100_000,
        oomKillDisable: false,
      },
    },
  );

  assert.equal(opts.HostConfig?.Memory, 4_294_967_296);
  assert.equal(opts.HostConfig?.MemorySwap, 4_294_967_296);
  assert.equal(opts.HostConfig?.CpuQuota, 200_000);
  assert.equal(opts.HostConfig?.CpuPeriod, 100_000);
  assert.equal(opts.HostConfig?.OomKillDisable, false);
  assert.deepEqual(opts.HostConfig?.Binds, [
    "/mnt/datasets:/datasets:ro",
    "/mnt/models:/models:rw",
  ]);
  assert.equal(opts.Labels?.["app.hypercube.workspace.shortId"], "05eddec05865");
  assert.throws(
    () => createTest.buildSharedMounts([{ source: "/mnt/datasets:bad", target: "/datasets" }]),
    /absolute path without colon/,
  );
}

function assertParsers(): void {
  assert.deepEqual(
    parseDfSizeAvail("1G-blocks Avail\n2000 1850\n"),
    { totalGb: 2000, freeGb: 1850 },
  );
  assert.equal(parseHumanSizeToGb("100M"), 100 / 1024);
  assert.equal(parseHumanSizeToGb("1.5G"), 1.5);
  assert.equal(parseHumanSizeToGb("2T"), 2048);
  assert.equal(parseHumanSizeToGb("abc"), null);
  const usedReport = "#100456 100M 100G 100G 00 [--------]\n";
  const usedGb = parseXfsQuotaUsedGb(usedReport, 100456);
  assert.ok(usedGb !== null);
  assert.equal(Math.round(((usedGb as number) ?? 0) * 1000), Math.round((100 / 1024) * 1000));
  assert.deepEqual(
    parseDfRoot("Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n"),
    { filesystem: "ext4", rootTotalGb: 100, rootUsedGb: 10 },
  );
  assert.equal(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"\n'), "Ubuntu 22.04.4 LTS");
}

async function assertCapacityReportSchema(): Promise<void> {
  const runner = new FakeRunner(null, {
    "df -B1G -T /": "Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n",
    "df -B1G --output=size,avail /var/lib/hypercube/workspaces": "1G-blocks Avail\n2000 1850\n",
    "xfs_quota -x -c state /var/lib/hypercube/workspaces":
      "Project quota state on /var/lib/hypercube/workspaces (/dev/loop0)\nAccounting: ON\nEnforcement: ON\n",
    "findmnt -no OPTIONS /var/lib/hypercube/workspaces": "rw,relatime,attr2,inode64,prjquota\n",
    "stat -fc %T /sys/fs/cgroup": "cgroup2fs\n",
  });
  const report = await buildCapacityReport(config, "agent-1", runner);
  assert.equal(report.type, "capacity_report");
  assert.equal(report.agentId, "agent-1");
  assert.match(report.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(report.data.cpu.cores > 0);
  assert.equal(report.data.memory.totalMb > 0, true);
  assert.equal(report.data.disk.rootTotalGb, 100);
  assert.equal(report.data.disk.rootUsedGb, 10);
  assert.equal(report.data.disk.filesystem, "ext4");
  assert.equal(report.data.disk.workspaceQuota.available, true);
  assert.equal(report.data.disk.workspaceQuota.mountPath, "/var/lib/hypercube/workspaces");
  assert.equal(report.data.disk.workspaceQuota.totalGb, 2000);
  assert.equal(report.data.disk.workspaceQuota.freeGb, 1850);
  assert.equal(report.data.disk.workspaceQuota.hardEnforced, true);
  assert.equal(report.data.os.cgroupVersion, "v2");
}

async function assertCapacityReportDisabledQuotaDoesNotProbe(): Promise<void> {
  const runner = new FakeRunner(null, {
    "df -B1G -T /": "Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n",
    "stat -fc %T /sys/fs/cgroup": "tmpfs\n",
  });
  const capacity = await collectHostCapacity(
    {
      ...config,
      workspaceQuota: DISABLED_QUOTA_CONFIG,
    },
    runner,
  );
  assert.equal(capacity.disk.workspaceQuota.available, false);
  assert.equal(capacity.disk.workspaceQuota.mountPath, null);
  assert.equal(capacity.disk.workspaceQuota.totalGb, null);
  assert.equal(capacity.disk.workspaceQuota.freeGb, null);
  assert.equal(capacity.disk.workspaceQuota.hardEnforced, false);
  assert.equal(
    runner.calls.some((call) => call[0] === "xfs_quota"),
    false,
  );
  assert.equal(
    runner.calls.some(
      (call) => call[0] === "df" && call.includes("/var/lib/hypercube/workspaces"),
    ),
    false,
  );
}

function assertProjectIdDeterminismAndRange(): void {
  const a = projectIdFor("05eddec05865");
  const b = projectIdFor("05eddec05865");
  assert.equal(a, b);
  assert.ok(a >= 100_000 && a <= 16_777_215, `projectId out of range: ${a}`);

  const others = new Set<number>();
  for (let i = 0; i < 200; i += 1) {
    const id = projectIdFor(`a${i.toString(16).padStart(11, "0")}`);
    assert.ok(id >= 100_000 && id <= 16_777_215);
    others.add(id);
  }
  assert.ok(others.size > 190, `unexpected projectId collision rate: ${200 - others.size}`);
}

async function assertPrepareCommandOrder(): Promise<void> {
  const runner = new FakeRunner();
  // The production manager uses path.posix.join so the tests stage tmp
  // directories with the same separator. fs.mkdir on Windows accepts forward
  // slashes just fine, so this also runs the same in CI on either platform.
  const tmpRoot = posixTmpDir(await fs.mkdtemp(path.join(os.tmpdir(), "hc-quota-prepare-")));
  try {
    const manager = new WorkspaceQuotaManager({ enabled: true, mountRoot: tmpRoot }, runner);
    const ws = await manager.prepare({ shortId: "05eddec05865", hardGb: 10 });
    assert.equal(ws.shortId, "05eddec05865");
    assert.equal(ws.path, `${tmpRoot}/05eddec05865`);
    assert.equal(ws.hardGb, 10);
    assert.equal(ws.mountTarget, "/workspace");
    assert.ok(ws.projectId >= 100_000 && ws.projectId <= 16_777_215);

    const calls = runner.calls.map((call) => call.join(" "));
    assert.deepEqual(calls, [
      `xfs_quota -x -c project -s -p ${tmpRoot}/05eddec05865 ${ws.projectId} ${tmpRoot}`,
      // xfs_quota's `limit` subcommand takes block sizes with explicit
      // suffixes (g = GiB) and writes the cap into XFS in bytes. setquota's
      // -P bsoft/bhard arguments are 1 KiB blocks, which silently inflates
      // the limit by 1024×; see issue #16 unit-bug post-mortem.
      `xfs_quota -x -c limit -p bsoft=10g bhard=10g ${ws.projectId} ${tmpRoot}`,
    ]);
    const mapping = await fs.readFile(`${tmpRoot}/.projects`, "utf-8");
    assert.equal(mapping, `${ws.projectId}:hc-05eddec05865\n`);
    const created = await fs.stat(`${tmpRoot}/05eddec05865`);
    assert.equal(created.isDirectory(), true);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function assertTeardownCommandOrder(): Promise<void> {
  const runner = new FakeRunner();
  const tmpRoot = posixTmpDir(await fs.mkdtemp(path.join(os.tmpdir(), "hc-quota-teardown-")));
  try {
    const workspacePath = `${tmpRoot}/05eddec05865`;
    await fs.mkdir(workspacePath, { recursive: true });
    const expectedId = projectIdFor("05eddec05865");
    await fs.writeFile(`${tmpRoot}/.projects`, `${expectedId}:hc-05eddec05865\n`, "utf-8");
    const manager = new WorkspaceQuotaManager({ enabled: true, mountRoot: tmpRoot }, runner);
    await manager.teardown({ shortId: "05eddec05865" });
    assert.deepEqual(
      runner.calls.map((call) => call.join(" ")),
      [
        `xfs_quota -x -c limit -p bsoft=0 bhard=0 ${expectedId} ${tmpRoot}`,
        `xfs_quota -x -c project -C -p ${workspacePath} ${expectedId} ${tmpRoot}`,
      ],
    );
    await assert.rejects(fs.stat(workspacePath), { code: "ENOENT" });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function assertPrepareRollbackOnLimitFailure(): Promise<void> {
  // Fail specifically on the `xfs_quota limit` call so the rollback path
  // exercises project detach + workspace directory cleanup. Project attach
  // and limit set both run through `xfs_quota`, so we match on the inner
  // -c argument rather than the command name.
  const failOnLimit = (command: string, args: readonly string[]): boolean =>
    command === "xfs_quota" && args.some((arg) => arg.startsWith("limit "));
  const runner = new FakeRunner(failOnLimit);
  const tmpRoot = posixTmpDir(await fs.mkdtemp(path.join(os.tmpdir(), "hc-quota-rollback-")));
  try {
    const manager = new WorkspaceQuotaManager({ enabled: true, mountRoot: tmpRoot }, runner);
    await assert.rejects(
      () => manager.prepare({ shortId: "05eddec05865", hardGb: 10 }),
      /workspace quota provision failed/,
    );
    const calls = runner.calls.map((call) => call.join(" "));
    assert.ok(calls.some((line) => line.startsWith("xfs_quota -x -c project -s -p ")));
    assert.ok(calls.some((line) => line.includes("limit -p bsoft=10g bhard=10g")));
    assert.ok(calls.some((line) => line.startsWith("xfs_quota -x -c project -C -p ")));
    await assert.rejects(fs.stat(`${tmpRoot}/05eddec05865`), { code: "ENOENT" });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function posixTmpDir(dir: string): string {
  // path.posix.join keeps a single \\ → / replacement readable.
  return dir.split(path.sep).join("/");
}

async function assertDockerCreateFailureRollback(): Promise<void> {
  const manager = new FakeWorkspaceManager();
  const docker = fakeDocker({ createFails: true });
  await assert.rejects(
    () =>
      handleCreateContainer(
        docker.docker,
        {
          image: "img",
          name: "create-fails",
          workspace: { hardGb: 10, mountTarget: "/workspace" },
        },
        emitProgress,
        config,
        { workspaceManager: manager, workspaceShortId: () => "05eddec05865" },
      ),
    /create failed/,
  );
  assert.equal(docker.state.removed, false);
  assert.equal(manager.cleaned, true);
}

async function assertDockerStartFailureRollback(): Promise<void> {
  const manager = new FakeWorkspaceManager();
  const docker = fakeDocker({ startFails: true });
  await assert.rejects(
    () =>
      handleCreateContainer(
        docker.docker,
        {
          image: "img",
          name: "start-fails",
          workspace: { hardGb: 10, mountTarget: "/workspace" },
        },
        emitProgress,
        config,
        { workspaceManager: manager, workspaceShortId: () => "05eddec05865" },
      ),
    /start failed/,
  );
  assert.equal(docker.state.removed, true);
  assert.equal(manager.cleaned, true);
}

async function assertWorkspaceUsageParsing(): Promise<void> {
  const projectId = projectIdFor("05eddec05865");
  const reportOutput = `#${projectId} 150M 200G 200G 00 [--------]\n`;
  const runner = new FakeRunner(null, {
    [`xfs_quota -x -c report -h -p -N /var/lib/hypercube/workspaces`]: reportOutput,
  });
  const labels = labelsForPreparedWorkspace({
    shortId: "05eddec05865",
    path: "/var/lib/hypercube/workspaces/05eddec05865",
    projectId,
    hardGb: 200,
    mountTarget: "/workspace",
  });
  const usage = await collectWorkspaceUsageFromLabels(labels, ENABLED_QUOTA_CONFIG, runner);
  assert.ok(usage);
  assert.equal(usage?.projectId, projectId);
  assert.equal(usage?.hardGb, 200);
  // 150M = 150/1024 GiB ≈ 0.146; round1 → 0.1.
  assert.equal(usage?.usedGb, 0.1);
  assert.equal(usage?.availableGb, 199.9);
  assert.equal(usage?.usedPct, 0.1);
}

async function assertWorkspaceUsageDisabledFallback(): Promise<void> {
  const projectId = projectIdFor("05eddec05865");
  const labels = labelsForPreparedWorkspace({
    shortId: "05eddec05865",
    path: "/var/lib/hypercube/workspaces/05eddec05865",
    projectId,
    hardGb: 100,
    mountTarget: "/workspace",
  });
  const runner = new FakeRunner();
  const usage = await collectWorkspaceUsageFromLabels(labels, DISABLED_QUOTA_CONFIG, runner);
  assert.equal(usage?.hardGb, 100);
  assert.equal(usage?.usedGb, 0);
  assert.equal(usage?.availableGb, 100);
  assert.equal(usage?.usedPct, 0);
  assert.equal(runner.calls.length, 0);
}

// Live container proof. Only the operator-driven runbook
// (docs/runbooks/workspace-quota-full-validation.md §3 in the HyperCube
// core repo) executes a real busybox + dd. This self-test stays a fast
// in-process unit suite so CI can run it without a real prjquota mount.
async function maybeRunLiveContainerProof(): Promise<void> {
  const liveEnabled = (process.env.WORKSPACE_QUOTA_ENABLED ?? "false").toLowerCase() === "true";
  if (!liveEnabled) return;
  console.log(
    "WORKSPACE_QUOTA_ENABLED=true detected: live busybox + dd is operator-driven via the core runbook, not this self-test.",
  );
}

type FakeRunnerFailMatcher = string | ((command: string, args: readonly string[]) => boolean);

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly failCommand: FakeRunnerFailMatcher | null = null,
    private readonly outputs: Record<string, string> = {},
  ) {}

  async run(command: string, args: readonly string[] = []) {
    this.calls.push([command, ...args]);
    const shouldFail =
      typeof this.failCommand === "function"
        ? this.failCommand(command, args)
        : command === this.failCommand;
    if (shouldFail) {
      const err = new Error(`${command} boom`) as NodeJS.ErrnoException & { stderr?: string };
      err.stderr = `${command} boom`;
      throw err;
    }
    const key = [command, ...args].join(" ");
    return { stdout: this.outputs[key] ?? this.outputs[command] ?? "", stderr: "" };
  }
}

class FakeWorkspaceManager extends WorkspaceQuotaManager {
  cleaned = false;

  constructor() {
    super(ENABLED_QUOTA_CONFIG, new FakeRunner());
  }

  override async prepare(opts: PrepareContainerWorkspaceOptions): Promise<PreparedWorkspace> {
    const shortId = opts.shortId;
    return {
      shortId,
      path: `/var/lib/hypercube/workspaces/${shortId}`,
      projectId: projectIdFor(shortId),
      hardGb: opts.hardGb,
      mountTarget: opts.mountTarget ?? "/workspace",
    };
  }

  override async teardown(): Promise<void> {
    this.cleaned = true;
  }
}

function fakeDocker(options: { createFails?: boolean; startFails?: boolean } = {}): {
  docker: Dockerode;
  state: { createOptions?: Dockerode.ContainerCreateOptions; removed: boolean };
} {
  const state = { createOptions: undefined as Dockerode.ContainerCreateOptions | undefined, removed: false };
  const docker = {
    listContainers: async () => [],
    getImage: () => ({
      inspect: async () => ({ Id: "sha256:image" }),
    }),
    createContainer: async (createOptions: Dockerode.ContainerCreateOptions) => {
      state.createOptions = createOptions;
      if (options.createFails) throw new Error("boom");
      return {
        start: async () => {
          if (options.startFails) throw new Error("boom");
        },
        inspect: async () => ({
          Id: "container-start-fails",
          Name: "/start-fails",
          State: { Status: "running" },
          NetworkSettings: { Networks: { bridge: {} } },
        }),
        remove: async () => {
          state.removed = true;
        },
      };
    },
    pull: async () => ({}),
    modem: {
      followProgress: () => undefined,
    },
  } as unknown as Dockerode;
  return { docker, state };
}

export {
  prepareContainerWorkspace,
  teardownContainerWorkspace,
  workspaceFromLabels,
  collectWorkspaceQuotaInfo,
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
