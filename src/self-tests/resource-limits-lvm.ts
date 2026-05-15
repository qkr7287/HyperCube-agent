import assert from "node:assert/strict";
import type Dockerode from "dockerode";
import { handleCreateContainer, __test as createTest } from "../handlers/create-container.js";
import {
  LvmWorkspaceManager,
  parseDfOneGig,
  parseLvsThinPool,
  type LvmWorkspaceRequest,
  type PreparedLvmWorkspace,
} from "../workspace-lvm.js";
import {
  buildCapacityReport,
  collectHostCapacity,
  parseDfRoot,
  parseOsRelease,
} from "../collectors/capacity.js";
import type { AppConfig, ProgressEmitter } from "../types/index.js";
import type { CommandRunner } from "../utils/command-runner.js";

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
  lvmWorkspace: {
    enabled: true,
    volumeGroup: "vg0",
    thinPool: "thin_pool",
    mountRoot: "/var/lib/hypercube/workspaces",
    uid: 1000,
    gid: 100,
  },
};

const emitProgress: ProgressEmitter = () => undefined;

async function main(): Promise<void> {
  assertHostConfigAndSharedMountMapping();
  assertCapacityParsers();
  await assertCapacityReportSchema();
  await assertCapacityReportGracefulLvmFallback();
  await assertCapacityReportDisabledLvmDoesNotProbe();
  await assertLvmCommandOrder();
  await assertLvmRollbackOnMkfsFailure();
  await assertLvmRollbackOnMountFailure();
  await assertLvmEnsureMountedMountsMissingWorkspace();
  await assertLvmEnsureMountedSkipsAlreadyMountedWorkspace();
  await assertDockerCreateFailureRollback();
  await assertDockerStartFailureRollback();
  console.log("resource limits and LVM workspace self-test passed");
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
      labels: { "app.hypercube.workspace.id": "05eddec05865" },
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
  assert.equal(opts.Labels?.["app.hypercube.workspace.id"], "05eddec05865");
  assert.throws(
    () => createTest.buildSharedMounts([{ source: "/mnt/datasets:bad", target: "/datasets" }]),
    /absolute path without colon/,
  );
}

function assertCapacityParsers(): void {
  assert.deepEqual(parseLvsThinPool(" 3000.00,14.40\n"), {
    sizeGb: 3000,
    usedPct: 14.4,
  });
  assert.deepEqual(
    parseDfOneGig(
      "Filesystem     1G-blocks  Used Available Use% Mounted on\n/dev/vg0/cid 10 2 8 20% /var/lib/hypercube/workspaces/abc\n",
    ),
    { totalGb: 10, usedGb: 2, availableGb: 8, usedPct: 20 },
  );
  assert.deepEqual(
    parseDfRoot("Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n"),
    { filesystem: "ext4", rootTotalGb: 100, rootUsedGb: 10 },
  );
  assert.equal(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"\n'), "Ubuntu 22.04.4 LTS");
}

async function assertCapacityReportSchema(): Promise<void> {
  const runner = new FakeRunner(null, {
    "df -B1G -T /": "Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n",
    "lvs --noheadings --units g --nosuffix --separator , -o LV_SIZE,Data_percent vg0/thin_pool": "3000.00,14.40\n",
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
  assert.equal(report.data.disk.lvm.available, true);
  assert.equal(report.data.disk.lvm.thinPoolSizeGb, 3000);
  assert.equal(report.data.disk.lvm.thinPoolUsedGb, 432);
  assert.equal(report.data.disk.lvm.usedPct, 14.4);
  assert.equal(report.data.disk.lvm.alert, "ok");
  assert.equal(report.data.os.cgroupVersion, "v2");
  assert.equal(typeof report.data.agent.nodeVersion, "string");
}

async function assertCapacityReportGracefulLvmFallback(): Promise<void> {
  const runner = new FakeRunner("lvs", {
    "df -B1G -T /": "Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n",
    "stat -fc %T /sys/fs/cgroup": "tmpfs\n",
  });
  const capacity = await collectHostCapacity(config, runner);
  assert.equal(capacity.disk.lvm.available, false);
  assert.equal(capacity.disk.lvm.thinPoolSizeGb, null);
  assert.equal(capacity.disk.lvm.alert, null);
  assert.equal(capacity.os.cgroupVersion, "v1");
}

async function assertCapacityReportDisabledLvmDoesNotProbe(): Promise<void> {
  const runner = new FakeRunner(null, {
    "df -B1G -T /": "Filesystem Type 1G-blocks Used Available Use% Mounted on\n/dev/sda1 ext4 100 10 90 10% /\n",
    "lvs --noheadings --units g --nosuffix --separator , -o LV_SIZE,Data_percent vg0/thin_pool": "3000.00,14.40\n",
    "stat -fc %T /sys/fs/cgroup": "cgroup2fs\n",
  });
  const capacity = await collectHostCapacity(
    {
      ...config,
      lvmWorkspace: {
        ...config.lvmWorkspace,
        enabled: false,
      },
    },
    runner,
  );
  assert.equal(capacity.disk.lvm.available, false);
  assert.equal(capacity.disk.lvm.thinPoolSizeGb, null);
  assert.equal(capacity.disk.lvm.alert, null);
  assert.equal(
    runner.calls.some((call) => call[0] === "lvs"),
    false,
  );
}

async function assertLvmCommandOrder(): Promise<void> {
  const runner = new FakeRunner();
  const manager = new LvmWorkspaceManager(config.lvmWorkspace, runner);
  const workspace = await manager.prepare({ sizeGb: 10, mountTarget: "/workspace" }, "05eddec05865");
  assert.equal(workspace.device, "/dev/vg0/cid_05eddec05865");
  assert.deepEqual(runner.calls.map((call) => call.join(" ")), [
    "mkdir -p /var/lib/hypercube/workspaces/05eddec05865",
    "lvcreate -V 10G -T vg0/thin_pool -n cid_05eddec05865",
    "dmsetup mknodes",
    "mkfs.ext4 -F /dev/vg0/cid_05eddec05865",
    "mount /dev/vg0/cid_05eddec05865 /var/lib/hypercube/workspaces/05eddec05865",
    "chown 1000:100 /var/lib/hypercube/workspaces/05eddec05865",
  ]);
}

async function assertLvmRollbackOnMkfsFailure(): Promise<void> {
  const runner = new FakeRunner("mkfs.ext4");
  const manager = new LvmWorkspaceManager(config.lvmWorkspace, runner);
  await assert.rejects(
    () => manager.prepare({ sizeGb: 10, mountTarget: "/workspace" }, "05eddec05865"),
    /workspace LVM provision failed/,
  );
  assert.deepEqual(runner.calls.map((call) => call.join(" ")), [
    "mkdir -p /var/lib/hypercube/workspaces/05eddec05865",
    "lvcreate -V 10G -T vg0/thin_pool -n cid_05eddec05865",
    "dmsetup mknodes",
    "mkfs.ext4 -F /dev/vg0/cid_05eddec05865",
    "lvremove -f vg0/cid_05eddec05865",
    "rmdir /var/lib/hypercube/workspaces/05eddec05865",
  ]);
}

async function assertLvmRollbackOnMountFailure(): Promise<void> {
  const runner = new FakeRunner("mount");
  const manager = new LvmWorkspaceManager(config.lvmWorkspace, runner);
  await assert.rejects(
    () => manager.prepare({ sizeGb: 10, mountTarget: "/workspace" }, "05eddec05865"),
    /workspace LVM provision failed/,
  );
  assert.deepEqual(runner.calls.map((call) => call.join(" ")), [
    "mkdir -p /var/lib/hypercube/workspaces/05eddec05865",
    "lvcreate -V 10G -T vg0/thin_pool -n cid_05eddec05865",
    "dmsetup mknodes",
    "mkfs.ext4 -F /dev/vg0/cid_05eddec05865",
    "mount /dev/vg0/cid_05eddec05865 /var/lib/hypercube/workspaces/05eddec05865",
    "lvremove -f vg0/cid_05eddec05865",
    "rmdir /var/lib/hypercube/workspaces/05eddec05865",
  ]);
}

async function assertLvmEnsureMountedMountsMissingWorkspace(): Promise<void> {
  const runner = new FakeRunner("findmnt");
  const manager = new LvmWorkspaceManager(config.lvmWorkspace, runner);
  await manager.ensureMounted({
    volumeName: "cid_05eddec05865",
    device: "/dev/vg0/cid_05eddec05865",
    mountPoint: "/var/lib/hypercube/workspaces/05eddec05865",
  });
  assert.deepEqual(runner.calls.map((call) => call.join(" ")), [
    "mkdir -p /var/lib/hypercube/workspaces/05eddec05865",
    "dmsetup mknodes",
    "findmnt -rn --target /var/lib/hypercube/workspaces/05eddec05865",
    "mount /dev/vg0/cid_05eddec05865 /var/lib/hypercube/workspaces/05eddec05865",
    "chown 1000:100 /var/lib/hypercube/workspaces/05eddec05865",
  ]);
}

async function assertLvmEnsureMountedSkipsAlreadyMountedWorkspace(): Promise<void> {
  const runner = new FakeRunner(null, {
    "findmnt -rn --target /var/lib/hypercube/workspaces/05eddec05865":
      "/var/lib/hypercube/workspaces/05eddec05865\n",
  });
  const manager = new LvmWorkspaceManager(config.lvmWorkspace, runner);
  await manager.ensureMounted({
    volumeName: "cid_05eddec05865",
    device: "/dev/vg0/cid_05eddec05865",
    mountPoint: "/var/lib/hypercube/workspaces/05eddec05865",
  });
  assert.deepEqual(runner.calls.map((call) => call.join(" ")), [
    "mkdir -p /var/lib/hypercube/workspaces/05eddec05865",
    "dmsetup mknodes",
    "findmnt -rn --target /var/lib/hypercube/workspaces/05eddec05865",
    "chown 1000:100 /var/lib/hypercube/workspaces/05eddec05865",
  ]);
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
          workspace: { sizeGb: 10, mountTarget: "/workspace" },
        },
        emitProgress,
        config,
        { workspaceManager: manager, workspaceId: () => "05eddec05865" },
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
          workspace: { sizeGb: 10, mountTarget: "/workspace" },
        },
        emitProgress,
        config,
        { workspaceManager: manager, workspaceId: () => "05eddec05865" },
      ),
    /start failed/,
  );
  assert.equal(docker.state.removed, true);
  assert.equal(manager.cleaned, true);
}

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly failCommand: string | null = null,
    private readonly outputs: Record<string, string> = {},
  ) {}

  async run(command: string, args: readonly string[] = []) {
    this.calls.push([command, ...args]);
    if (command === this.failCommand) {
      const err = new Error(`${command} boom`) as NodeJS.ErrnoException & { stderr?: string };
      err.stderr = `${command} boom`;
      throw err;
    }
    const key = [command, ...args].join(" ");
    return { stdout: this.outputs[key] ?? this.outputs[command] ?? "", stderr: "" };
  }
}

class FakeWorkspaceManager extends LvmWorkspaceManager {
  cleaned = false;

  constructor() {
    super(config.lvmWorkspace, new FakeRunner());
  }

  override async prepare(
    request: LvmWorkspaceRequest,
    workspaceId = "05eddec05865",
  ): Promise<PreparedLvmWorkspace> {
    return {
      id: workspaceId,
      volumeName: `cid_${workspaceId}`,
      device: `/dev/vg0/cid_${workspaceId}`,
      mountPoint: `/var/lib/hypercube/workspaces/${workspaceId}`,
      mountTarget: request.mountTarget,
      sizeGb: request.sizeGb,
    };
  }

  override async cleanup(): Promise<void> {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
