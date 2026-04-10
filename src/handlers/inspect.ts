import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("handler:inspect");

export async function handleInspect(
  docker: Dockerode,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const containerId = params.containerId as string | undefined;
  if (!containerId) {
    throw new Error("containerId is required");
  }

  log.info(`Inspecting container ${containerId}`);

  const container = docker.getContainer(containerId);
  const info = await container.inspect();

  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    created: info.Created,
    state: {
      status: info.State.Status,
      running: info.State.Running,
      paused: info.State.Paused,
      restarting: info.State.Restarting,
      oomKilled: info.State.OOMKilled,
      dead: info.State.Dead,
      pid: info.State.Pid,
      exitCode: info.State.ExitCode,
      startedAt: info.State.StartedAt,
      finishedAt: info.State.FinishedAt,
      health: info.State.Health ?? null,
    },
    image: info.Config.Image,
    config: {
      hostname: info.Config.Hostname,
      env: info.Config.Env,
      cmd: info.Config.Cmd,
      labels: info.Config.Labels,
      workingDir: info.Config.WorkingDir,
      entrypoint: info.Config.Entrypoint,
    },
    networkSettings: {
      ports: info.NetworkSettings.Ports,
      networks: info.NetworkSettings.Networks,
    },
    mounts: info.Mounts.map((m) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode,
      rw: m.RW,
    })),
    restartCount: info.RestartCount,
  };
}
