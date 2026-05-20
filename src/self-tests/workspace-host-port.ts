import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Dockerode from "dockerode";
import { handleCreateContainer } from "../handlers/create-container.js";
import { handleHostPortScan } from "../handlers/host-port-scan.js";
import type { AppConfig, ProgressEmitter } from "../types/index.js";

const config: AppConfig = {
  backendUrl: "http://backend.local/ws",
  backendApiUrl: "http://backend.local",
  agentHostname: "self-test-agent",
  collectInterval: 2,
  dockerSocket: "/var/run/docker.sock",
  advertiseIp: null,
  hostProcPath: "/proc",
  hostSysPath: "/sys",
  dcgmExporterUrl: null,
  gpuPerContainerEnabled: true,
  modelCacheRoot: "/tmp/hypercube-model-cache",
  workspaceQuota: { enabled: false, mountRoot: "/var/lib/hypercube/workspaces" },
};

const emit: ProgressEmitter = () => undefined;

function fakeDocker(): {
  docker: Dockerode;
  state: { createOptions?: Dockerode.ContainerCreateOptions };
} {
  const state: { createOptions?: Dockerode.ContainerCreateOptions } = {};
  const docker = {
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({ Id: "sha256:img" }) }),
    listNetworks: async () => [],
    createContainer: async (options: Dockerode.ContainerCreateOptions) => {
      state.createOptions = options;
      return {
        start: async () => undefined,
        inspect: async () =>
          ({
            Id: "container-1",
            Name: `/${options.name ?? "ws"}`,
            State: { Status: "running" },
            NetworkSettings: { Networks: { bridge: {} } },
          }) as unknown as Dockerode.ContainerInspectInfo,
        remove: async () => undefined,
      };
    },
  } as unknown as Dockerode;
  return { docker, state };
}

async function main(): Promise<void> {
  // --- Issue 1: explicit workspace.hostPort publishes on that host port ---
  const explicit = fakeDocker();
  const explicitResult = await handleCreateContainer(
    explicit.docker,
    {
      image: "img",
      name: "ws-a",
      workspace: { kind: "jupyter", token: "t", port: 8888, baseUrl: "/ws", hostPort: 8889 },
    },
    emit,
    config,
  );
  assert.deepEqual(
    explicit.state.createOptions?.HostConfig?.PortBindings?.["8888/tcp"],
    [{ HostPort: "8889" }],
    "explicit hostPort must publish 8888 on host 8889",
  );
  assert.equal((explicitResult.workspace as { hostPort: number }).hostPort, 8889);
  assert.equal((explicitResult.workspace as { internalPort: number }).internalPort, 8888);

  // --- Issue 1: no hostPort → host port mirrors the container port (legacy) ---
  const mirror = fakeDocker();
  await handleCreateContainer(
    mirror.docker,
    {
      image: "img",
      name: "ws-b",
      workspace: { kind: "jupyter", token: "t", port: 8888, baseUrl: "/ws" },
    },
    emit,
    config,
  );
  assert.deepEqual(
    mirror.state.createOptions?.HostConfig?.PortBindings?.["8888/tcp"],
    [{ HostPort: "8888" }],
    "absent hostPort must mirror the container port",
  );

  // --- Issue 1: invalid hostPort is rejected ---
  await assert.rejects(
    () =>
      handleCreateContainer(
        fakeDocker().docker,
        {
          image: "img",
          name: "ws-c",
          workspace: { kind: "jupyter", token: "t", port: 8888, baseUrl: "/ws", hostPort: 70000 },
        },
        emit,
        config,
      ),
    /workspace\.hostPort must be a TCP port number/,
  );

  // --- Issue 2: host_port_scan reports only TCP LISTEN ports ---
  const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-proc-"));
  try {
    await fs.mkdir(path.join(procRoot, "net"), { recursive: true });
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1", // LISTEN 8888
      "   1: 0100007F:1388 0100007F:E0F0 01 00000000:00000000 00:00000000 00000000  1000        0 2", // ESTABLISHED 5000 — excluded
      "   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3", // LISTEN 22
    ].join("\n");
    await fs.writeFile(path.join(procRoot, "net", "tcp"), `${tcp}\n`);

    const scan = await handleHostPortScan({ ...config, hostProcPath: procRoot });
    assert.deepEqual(
      scan.ports,
      [
        { port: 22, proto: "tcp" },
        { port: 8888, proto: "tcp" },
      ],
      "host_port_scan must return sorted TCP LISTEN ports only",
    );

    // tcp6 absent → handled without throwing.
    const scanNoV6 = await handleHostPortScan({ ...config, hostProcPath: procRoot });
    assert.equal((scanNoV6.ports as unknown[]).length, 2);
  } finally {
    await fs.rm(procRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("workspace host-port + host_port_scan self-test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
