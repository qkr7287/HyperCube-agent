import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import {
  INTERNAL_NETWORK_NAME,
  type NetworkPolicy,
  normalizeNetworkPolicy,
  supportedNetworkPolicyMessage,
} from "../network-policy.js";
import type { AppConfig, ProgressEmitter } from "../types/index.js";
import { collectGpuInventory } from "../utils/gpu-inventory.js";
import { assertVerifiedModelCachePath, resolveExistingCachePath } from "../utils/model-cache.js";

const log = createLogger("handler:create");

interface PortBinding {
  host: number;
  container: number;
  protocol?: "tcp" | "udp";
}

interface VolumeBinding {
  host: string;
  container: string;
  mode?: "rw" | "ro";
}

interface CreateParams {
  image: string;
  name: string;
  env?: Record<string, string>;
  ports?: PortBinding[];
  volumes?: VolumeBinding[];
  restart_policy?: string;
  pull_if_missing?: boolean;
  gpus?: GpuRequest[];
  modelMounts?: ModelMountRequest[];
  workspace?: WorkspaceParams;
  networkPolicy?: unknown;
}

interface GpuRequest {
  deviceId: string;
  kind?: string;
}

interface WorkspaceParams {
  kind?: string;
  token?: string;
  port?: number;
  baseUrl?: string;
}

interface ModelMountRequest {
  sourcePath?: string;
  mountPath?: string;
  readOnly?: boolean;
}

interface BuildCreateExtras {
  env?: Record<string, string>;
  ports?: PortBinding[];
  volumes?: VolumeBinding[];
  deviceRequests?: Dockerode.DeviceRequest[];
  network?: NetworkCreateExtras;
}

interface NetworkCreateExtras {
  networkMode: string;
  endpointsConfig?: Dockerode.EndpointsConfig;
}

interface WorkspaceCreateInfo {
  kind: string | null;
  hostPort: number;
  internalPort: number;
  baseUrl: string;
}

export async function handleCreateContainer(
  docker: Dockerode,
  params: Record<string, unknown>,
  emitProgress: ProgressEmitter,
  config: AppConfig,
): Promise<Record<string, unknown>> {
  const p = params as unknown as CreateParams;
  if (!p.image) throw new Error("image is required");
  if (!p.name) throw new Error("name is required");

  const networkPolicy = normalizeNetworkPolicy(p.networkPolicy);
  validateNetworkPolicyCombination(networkPolicy, p);

  log.info(`Creating container ${p.name} from ${p.image}`);

  // 1. check name conflict
  const existing = await findContainerByName(docker, p.name);
  if (existing) throw new Error(`name already exists: ${p.name}`);

  // 2. pull image if missing (with progress)
  const pullIfMissing = p.pull_if_missing ?? true;
  const hasMlOptions = hasMlWorkspaceOptions(p, networkPolicy);
  if (hasMlOptions) {
    await assertImagePresentForAirgapCreate(docker, p.image);
  } else if (pullIfMissing) {
    const hasImage = await imageExists(docker, p.image);
    if (!hasImage) {
      await pullWithProgress(docker, p.image, p.name, emitProgress);
    }
  }

  const gpuDeviceRequests = await buildGpuDeviceRequests(p.gpus);
  const workspace = buildWorkspaceCreateInfo(p, networkPolicy !== "host");
  const modelMounts = await buildModelMounts(config.modelCacheRoot, p.modelMounts);
  const network = await buildNetworkCreateExtras(docker, networkPolicy);

  // 3. create
  emitProgress({
    step: "creating",
    percent: null,
    message: `Creating container ${p.name}`,
    context: { image: p.image, containerName: p.name },
  });

  const createOpts = buildCreateOptions(p, {
    deviceRequests: gpuDeviceRequests,
    env: workspace?.env,
    ports: workspace?.ports,
    volumes: modelMounts,
    network,
  });
  let container;
  try {
    container = await docker.createContainer(createOpts);
  } catch (err) {
    throw new Error(`create failed: ${(err as Error).message}`);
  }

  // 4. start
  emitProgress({
    step: "starting",
    percent: null,
    message: `Starting container ${p.name}`,
    context: { image: p.image, containerName: p.name },
  });

  try {
    await container.start();
  } catch (err) {
    throw new Error(`start failed: ${(err as Error).message}`);
  }

  const info = await container.inspect();
  try {
    assertNetworkPolicyEnforced(info, networkPolicy);
  } catch (err) {
    await container.remove({ force: true }).catch((removeErr) => {
      log.warn(
        `failed to remove ${p.name} after network policy assertion failed: ${(removeErr as Error).message}`,
      );
    });
    throw err;
  }

  return {
    containerId: info.Id,
    name: info.Name.replace(/^\//, ""),
    image: p.image,
    state: info.State.Status,
    ...(workspace ? { workspace: workspace.response } : {}),
  };
}

function hasMlWorkspaceOptions(p: CreateParams, networkPolicy: NetworkPolicy): boolean {
  return (
    (p.gpus?.length ?? 0) > 0 ||
    (p.modelMounts?.length ?? 0) > 0 ||
    p.workspace !== undefined ||
    networkPolicy !== "none"
  );
}

async function assertImagePresentForAirgapCreate(
  docker: Dockerode,
  image: string,
): Promise<void> {
  const hasImage = await imageExists(docker, image);
  if (!hasImage) {
    throw new Error(
      `image not present locally: ${image}. ML workspace create is airgap-only and will not pull images.`,
    );
  }
}

function validateNetworkPolicyCombination(policy: NetworkPolicy, p: CreateParams): void {
  if (policy === "host" && (p.ports?.length ?? 0) > 0) {
    throw new Error(
      `networkPolicy host cannot be combined with port bindings. ${supportedNetworkPolicyMessage()}`,
    );
  }
}

async function buildNetworkCreateExtras(
  docker: Dockerode,
  policy: NetworkPolicy,
): Promise<NetworkCreateExtras | undefined> {
  if (policy === "none") return undefined;
  if (policy === "host") return { networkMode: "host" };

  const networkName = await ensureInternalNetwork(docker, INTERNAL_NETWORK_NAME);
  return {
    networkMode: networkName,
    endpointsConfig: {
      [networkName]: {},
    },
  };
}

async function ensureInternalNetwork(docker: Dockerode, name: string): Promise<string> {
  const existing = await findNetworkByName(docker, name);
  if (existing) {
    assertInternalNetwork(existing, name);
    return name;
  }

  try {
    await docker.createNetwork({
      Name: name,
      CheckDuplicate: true,
      Driver: "bridge",
      Internal: true,
      Labels: {
        "app.hypercube.role": "ml-workspace-internal",
        "app.hypercube.networkPolicy": "internal_only",
      },
    });
    log.info(`Created Docker internal network ${name}`);
  } catch (err) {
    if (!isDockerConflict(err)) {
      throw new Error(`failed to create internal Docker network ${name}: ${(err as Error).message}`);
    }
  }

  const created = await findNetworkByName(docker, name);
  if (!created) throw new Error(`failed to verify internal Docker network ${name} after create`);
  assertInternalNetwork(created, name);
  return name;
}

async function findNetworkByName(
  docker: Dockerode,
  name: string,
): Promise<Dockerode.NetworkInspectInfo | null> {
  const networks = await docker.listNetworks();
  return networks.find((network) => network.Name === name) ?? null;
}

function assertInternalNetwork(network: Dockerode.NetworkInspectInfo, name: string): void {
  if (!network.Internal) {
    throw new Error(
      `networkPolicy internal_only requires Docker network ${name} to be internal, but the existing network is not internal`,
    );
  }
}

function isDockerConflict(err: unknown): boolean {
  const e = err as { statusCode?: number; reason?: string; message?: string };
  return e.statusCode === 409 || /already exists|conflict/i.test(e.reason ?? e.message ?? "");
}

function assertNetworkPolicyEnforced(
  info: Dockerode.ContainerInspectInfo,
  policy: NetworkPolicy,
): void {
  if (policy !== "internal_only") return;

  const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
  if (!networks.includes(INTERNAL_NETWORK_NAME)) {
    throw new Error(
      `networkPolicy internal_only enforcement failed: container is not attached to ${INTERNAL_NETWORK_NAME}`,
    );
  }

  const extraNetworks = networks.filter((network) => network !== INTERNAL_NETWORK_NAME);
  if (extraNetworks.length > 0) {
    throw new Error(
      `networkPolicy internal_only enforcement failed: container attached to non-internal network(s): ${extraNetworks.join(", ")}`,
    );
  }
}

async function buildGpuDeviceRequests(
  gpus: GpuRequest[] | undefined,
): Promise<Dockerode.DeviceRequest[] | undefined> {
  if (!gpus || gpus.length === 0) return undefined;

  const requested = normalizeGpuRequests(gpus);
  const inventory = await collectGpuInventory();
  const available = new Set(
    inventory.gpus.flatMap((gpu) => gpu.slices.map((slice) => slice.deviceId)),
  );
  const missing = requested.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new Error(`requested GPU deviceId not available on host: ${missing.join(", ")}`);
  }

  return [
    {
      Driver: "nvidia",
      DeviceIDs: requested,
      Capabilities: [["gpu"]],
    },
  ];
}

function normalizeGpuRequests(gpus: GpuRequest[]): string[] {
  const out: string[] = [];
  for (const [index, gpu] of gpus.entries()) {
    if (!gpu || typeof gpu.deviceId !== "string" || gpu.deviceId.trim().length === 0) {
      throw new Error(`gpus[${index}].deviceId is required`);
    }
    out.push(gpu.deviceId.trim());
  }
  return Array.from(new Set(out));
}

function buildWorkspaceCreateInfo(
  p: CreateParams,
  publishPort: boolean,
): { env: Record<string, string>; ports: PortBinding[]; response: WorkspaceCreateInfo } | null {
  if (!p.workspace) return null;
  const rawPort = p.workspace.port;
  if (typeof rawPort !== "number" || !Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error("workspace.port is required and must be a TCP port number");
  }
  const port = rawPort;

  const existingPort = (p.ports ?? []).find(
    (candidate) => candidate.container === port && (candidate.protocol ?? "tcp") === "tcp",
  );
  const hostPort = existingPort?.host ?? port;
  const baseUrl = normalizeWorkspaceBaseUrl(p.workspace.baseUrl);
  const token = typeof p.workspace.token === "string" ? p.workspace.token : "";
  const kind = typeof p.workspace.kind === "string" ? p.workspace.kind : null;
  const ports =
    existingPort || !publishPort
      ? []
      : [{ host: hostPort, container: port, protocol: "tcp" as const }];

  return {
    env: {
      JUPYTER_TOKEN: token,
      JUPYTER_PORT: String(port),
      JUPYTER_BASE_URL: baseUrl,
      WORKSPACE_BASE_URL: baseUrl,
    },
    ports,
    response: {
      kind,
      hostPort,
      internalPort: port,
      baseUrl,
    },
  };
}

function normalizeWorkspaceBaseUrl(value: string | undefined): string {
  if (!value || value.trim().length === 0) return "/";
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function buildModelMounts(
  cacheRoot: string,
  modelMounts: ModelMountRequest[] | undefined,
): Promise<VolumeBinding[]> {
  if (!modelMounts || modelMounts.length === 0) return [];

  const out: VolumeBinding[] = [];
  for (const [index, mount] of modelMounts.entries()) {
    if (!mount || typeof mount.sourcePath !== "string" || mount.sourcePath.trim().length === 0) {
      throw new Error(`modelMounts[${index}].sourcePath is required`);
    }
    if (!mount.mountPath || typeof mount.mountPath !== "string" || !mount.mountPath.startsWith("/")) {
      throw new Error(`modelMounts[${index}].mountPath must be an absolute container path`);
    }
    await assertVerifiedModelCachePath(cacheRoot, mount.sourcePath);
    const resolvedSource = await resolveExistingCachePath(cacheRoot, mount.sourcePath);
    out.push({
      host: resolvedSource,
      container: mount.mountPath,
      mode: mount.readOnly === false ? "rw" : "ro",
    });
  }
  return out;
}

async function findContainerByName(
  docker: Dockerode,
  name: string,
): Promise<Dockerode.ContainerInfo | null> {
  const list = await docker.listContainers({ all: true });
  for (const c of list) {
    if (c.Names.some((n) => n.replace(/^\//, "") === name)) return c;
  }
  return null;
}

async function imageExists(docker: Dockerode, image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

async function pullWithProgress(
  docker: Dockerode,
  image: string,
  containerName: string,
  emitProgress: ProgressEmitter,
): Promise<void> {
  emitProgress({
    step: "pulling_image",
    percent: 0,
    message: `Pulling ${image}`,
    context: { image, containerName },
  });

  let stream;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    throw new Error(`image pull failed: ${(err as Error).message}`);
  }

  // aggregate per-layer progress to overall percent
  const layers: Record<string, { current: number; total: number }> = {};

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(new Error(`image pull failed: ${err.message}`));
        else resolve();
      },
      (event: Record<string, unknown>) => {
        const id = event.id as string | undefined;
        const status = event.status as string;
        const detail = event.progressDetail as { current?: number; total?: number } | undefined;

        if (id && detail?.total) {
          layers[id] = { current: detail.current ?? 0, total: detail.total };
        }

        const percent = calcOverallPercent(layers);
        emitProgress({
          step: "pulling_image",
          percent,
          message: id ? `${status}: ${id}` : status,
          context: { image, containerName },
        });
      },
    );
  });

  emitProgress({
    step: "pulling_image",
    percent: 100,
    message: `Pulled ${image}`,
    context: { image, containerName },
  });
}

function calcOverallPercent(
  layers: Record<string, { current: number; total: number }>,
): number | null {
  const values = Object.values(layers);
  if (values.length === 0) return null;
  const total = values.reduce((s, l) => s + l.total, 0);
  const current = values.reduce((s, l) => s + l.current, 0);
  if (total === 0) return null;
  return Math.min(99, Math.round((current / total) * 100));
}

function buildCreateOptions(
  p: CreateParams,
  extras: BuildCreateExtras = {},
): Dockerode.ContainerCreateOptions {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};

  for (const port of [...(p.ports ?? []), ...(extras.ports ?? [])]) {
    const key = `${port.container}/${port.protocol ?? "tcp"}`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(port.host) }];
  }

  const binds: string[] = [];
  for (const v of [...(p.volumes ?? []), ...(extras.volumes ?? [])]) {
    binds.push(`${v.host}:${v.container}:${v.mode ?? "rw"}`);
  }

  const envArr: string[] = [];
  const env = { ...(p.env ?? {}), ...(extras.env ?? {}) };
  if (extras.deviceRequests && extras.deviceRequests.length > 0) {
    const visibleDevices = extras.deviceRequests
      .flatMap((req) => req.DeviceIDs ?? [])
      .join(",");
    if (visibleDevices && env.NVIDIA_VISIBLE_DEVICES === undefined) {
      env.NVIDIA_VISIBLE_DEVICES = visibleDevices;
    }
    if (env.NVIDIA_DRIVER_CAPABILITIES === undefined) {
      env.NVIDIA_DRIVER_CAPABILITIES = "compute,utility";
    }
  }
  for (const [k, v] of Object.entries(env)) {
    envArr.push(`${k}=${v}`);
  }

  const hostConfig: Dockerode.HostConfig = {
    Binds: binds,
    RestartPolicy: { Name: p.restart_policy ?? "unless-stopped" },
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(extras.deviceRequests ? { DeviceRequests: extras.deviceRequests } : {}),
    ...(extras.network ? { NetworkMode: extras.network.networkMode } : {}),
  };

  const createOptions: Dockerode.ContainerCreateOptions = {
    name: p.name,
    Image: p.image,
    Env: envArr,
    ExposedPorts: exposedPorts,
    HostConfig: hostConfig,
  };

  if (extras.network?.endpointsConfig) {
    createOptions.NetworkingConfig = {
      EndpointsConfig: extras.network.endpointsConfig,
    };
  }

  return createOptions;
}

export const __test = {
  normalizeNetworkPolicy,
  hasMlWorkspaceOptions: (
    p: { gpus?: unknown[]; modelMounts?: unknown[]; workspace?: unknown },
    networkPolicy: NetworkPolicy,
  ) => hasMlWorkspaceOptions(p as CreateParams, networkPolicy),
};
