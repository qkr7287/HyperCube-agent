import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type { ProgressEmitter } from "../types/index.js";

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
}

export async function handleCreateContainer(
  docker: Dockerode,
  params: Record<string, unknown>,
  emitProgress: ProgressEmitter,
): Promise<Record<string, unknown>> {
  const p = params as unknown as CreateParams;
  if (!p.image) throw new Error("image is required");
  if (!p.name) throw new Error("name is required");

  log.info(`Creating container ${p.name} from ${p.image}`);

  // 1. check name conflict
  const existing = await findContainerByName(docker, p.name);
  if (existing) throw new Error(`name already exists: ${p.name}`);

  // 2. pull image if missing (with progress)
  const pullIfMissing = p.pull_if_missing ?? true;
  if (pullIfMissing) {
    const hasImage = await imageExists(docker, p.image);
    if (!hasImage) {
      await pullWithProgress(docker, p.image, p.name, emitProgress);
    }
  }

  // 3. create
  emitProgress({
    step: "creating",
    percent: null,
    message: `Creating container ${p.name}`,
    context: { image: p.image, containerName: p.name },
  });

  const createOpts = buildCreateOptions(p);
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

  return {
    containerId: info.Id,
    name: info.Name.replace(/^\//, ""),
    image: p.image,
    state: info.State.Status,
  };
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

function buildCreateOptions(p: CreateParams): Dockerode.ContainerCreateOptions {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};

  for (const port of p.ports ?? []) {
    const key = `${port.container}/${port.protocol ?? "tcp"}`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(port.host) }];
  }

  const binds: string[] = [];
  for (const v of p.volumes ?? []) {
    binds.push(`${v.host}:${v.container}:${v.mode ?? "rw"}`);
  }

  const envArr: string[] = [];
  for (const [k, v] of Object.entries(p.env ?? {})) {
    envArr.push(`${k}=${v}`);
  }

  return {
    name: p.name,
    Image: p.image,
    Env: envArr,
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: binds,
      PortBindings: portBindings,
      RestartPolicy: { Name: p.restart_policy ?? "unless-stopped" },
    },
  };
}
