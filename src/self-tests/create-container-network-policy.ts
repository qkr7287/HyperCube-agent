import assert from "node:assert/strict";
import type Dockerode from "dockerode";
import { handleCreateContainer, __test } from "../handlers/create-container.js";
import { INTERNAL_NETWORK_NAME, normalizeNetworkPolicy } from "../network-policy.js";
import type { AppConfig, ProgressEmitter } from "../types/index.js";

interface FakeDockerState {
  createOptions?: Dockerode.ContainerCreateOptions;
  createdNetworkOptions?: Dockerode.NetworkCreateOptions;
  inspectInfo?: Dockerode.ContainerInspectInfo;
  networks: Dockerode.NetworkInspectInfo[];
  removed: boolean;
}

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
  assert.equal(normalizeNetworkPolicy(undefined), "none");
  assert.equal(normalizeNetworkPolicy(null), "none");
  assert.equal(normalizeNetworkPolicy(""), "none");
  assert.equal(normalizeNetworkPolicy("  none  "), "none");
  assert.equal(normalizeNetworkPolicy("internal_only"), "internal_only");
  assert.equal(normalizeNetworkPolicy("host"), "host");
  assert.throws(() => normalizeNetworkPolicy("external"), /supported: none, internal_only, host/);
  assert.throws(() => normalizeNetworkPolicy(1), /supported: none, internal_only, host/);

  assert.equal(
    __test.hasMlWorkspaceOptions({}, normalizeNetworkPolicy("")),
    false,
  );
  assert.equal(
    __test.hasMlWorkspaceOptions({}, normalizeNetworkPolicy("internal_only")),
    true,
  );

  await assert.rejects(
    () =>
      handleCreateContainer(
        fakeDocker().docker,
        { image: "img", name: "bad-policy", networkPolicy: "external" },
        emitProgress,
        config,
      ),
    /networkPolicy external is not supported by this agent\. supported: none, internal_only, host/,
  );

  const emptyPolicy = fakeDocker();
  await handleCreateContainer(
    emptyPolicy.docker,
    { image: "img", name: "empty-policy", networkPolicy: "" },
    emitProgress,
    config,
  );
  assert.equal(emptyPolicy.state.createdNetworkOptions, undefined);
  assert.equal(emptyPolicy.state.createOptions?.HostConfig?.NetworkMode, undefined);
  assert.equal(emptyPolicy.state.createOptions?.NetworkingConfig, undefined);

  const internalOnly = fakeDocker();
  const internalResult = await handleCreateContainer(
    internalOnly.docker,
    {
      image: "img",
      name: "internal-policy",
      networkPolicy: "internal_only",
      workspace: { kind: "jupyter", token: "token", port: 8888, baseUrl: "/workspaces/test" },
    },
    emitProgress,
    config,
  );
  assert.equal(internalResult.name, "internal-policy");
  assert.equal(internalOnly.state.createdNetworkOptions?.Name, INTERNAL_NETWORK_NAME);
  assert.equal(internalOnly.state.createdNetworkOptions?.Internal, true);
  assert.equal(internalOnly.state.createOptions?.HostConfig?.NetworkMode, INTERNAL_NETWORK_NAME);
  assert.deepEqual(
    Object.keys(internalOnly.state.createOptions?.NetworkingConfig?.EndpointsConfig ?? {}),
    [INTERNAL_NETWORK_NAME],
  );
  assert.deepEqual(internalOnly.state.createOptions?.HostConfig?.PortBindings?.["8888/tcp"], [
    { HostPort: "8888" },
  ]);
  assert.deepEqual(Object.keys(internalOnly.state.inspectInfo?.NetworkSettings?.Networks ?? {}), [
    INTERNAL_NETWORK_NAME,
  ]);

  await assert.rejects(
    () =>
      handleCreateContainer(
        fakeDocker([fakeNetwork(INTERNAL_NETWORK_NAME, false)]).docker,
        { image: "img", name: "bad-existing-network", networkPolicy: "internal_only" },
        emitProgress,
        config,
      ),
    /existing network is not internal/,
  );

  const hostPolicy = fakeDocker();
  const hostResult = await handleCreateContainer(
    hostPolicy.docker,
    {
      image: "img",
      name: "host-policy",
      networkPolicy: "host",
      workspace: { kind: "jupyter", token: "token", port: 8888, baseUrl: "/workspaces/host" },
    },
    emitProgress,
    config,
  );
  assert.equal((hostResult.workspace as { hostPort: number }).hostPort, 8888);
  assert.equal(hostPolicy.state.createOptions?.HostConfig?.NetworkMode, "host");
  assert.equal(hostPolicy.state.createOptions?.HostConfig?.PortBindings, undefined);

  await assert.rejects(
    () =>
      handleCreateContainer(
        fakeDocker().docker,
        {
          image: "img",
          name: "host-with-ports",
          networkPolicy: "host",
          ports: [{ host: 8888, container: 8888 }],
        },
        emitProgress,
        config,
      ),
    /networkPolicy host cannot be combined with port bindings/,
  );

  console.log("create_container networkPolicy self-test passed");
}

function fakeDocker(initialNetworks: Dockerode.NetworkInspectInfo[] = []): {
  docker: Dockerode;
  state: FakeDockerState;
} {
  const state: FakeDockerState = {
    networks: [...initialNetworks],
    removed: false,
  };

  const docker = {
    listContainers: async () => [],
    getImage: () => ({
      inspect: async () => ({ Id: "sha256:image" }),
    }),
    listNetworks: async () => state.networks,
    createNetwork: async (options: Dockerode.NetworkCreateOptions) => {
      state.createdNetworkOptions = options;
      const network = fakeNetwork(options.Name, options.Internal === true);
      state.networks.push(network);
      return {
        id: network.Id,
        inspect: async () => network,
      };
    },
    createContainer: async (options: Dockerode.ContainerCreateOptions) => {
      state.createOptions = options;
      const networkNames = inspectNetworkNames(options);
      return {
        start: async () => undefined,
        inspect: async () => {
          state.inspectInfo = fakeContainerInspect(options.name ?? "container", networkNames);
          return state.inspectInfo;
        },
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

function inspectNetworkNames(options: Dockerode.ContainerCreateOptions): string[] {
  const endpoints = Object.keys(options.NetworkingConfig?.EndpointsConfig ?? {});
  if (endpoints.length > 0) return endpoints;
  if (options.HostConfig?.NetworkMode) return [options.HostConfig.NetworkMode];
  return ["bridge"];
}

function fakeNetwork(name: string, internal: boolean): Dockerode.NetworkInspectInfo {
  return {
    Name: name,
    Id: `network-${name}`,
    Created: "2026-05-13T00:00:00Z",
    Scope: "local",
    Driver: "bridge",
    EnableIPv6: false,
    Internal: internal,
    Attachable: false,
    Ingress: false,
    ConfigOnly: false,
  };
}

function fakeContainerInspect(name: string, networkNames: string[]): Dockerode.ContainerInspectInfo {
  return {
    Id: `container-${name}`,
    Name: `/${name}`,
    State: { Status: "running" },
    NetworkSettings: {
      Networks: Object.fromEntries(networkNames.map((network) => [network, {}])),
    },
  } as Dockerode.ContainerInspectInfo;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
