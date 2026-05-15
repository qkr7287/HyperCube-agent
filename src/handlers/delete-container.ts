import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import { LvmWorkspaceManager, workspaceFromLabels } from "../workspace-lvm.js";
import type { AppConfig } from "../types/index.js";

const log = createLogger("handler:delete");

interface DeleteParams {
  containerId: string;
  force?: boolean;
  removeVolumes?: boolean;
}

export async function handleDeleteContainer(
  docker: Dockerode,
  params: Record<string, unknown>,
  config?: AppConfig,
): Promise<Record<string, unknown>> {
  const p = params as unknown as DeleteParams;
  if (!p.containerId) throw new Error("containerId is required");

  const force = p.force ?? false;
  const removeVolumes = p.removeVolumes ?? false;

  log.info(`Deleting container ${p.containerId} (force=${force})`);

  const container = docker.getContainer(p.containerId);

  let info;
  try {
    info = await container.inspect();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.toLowerCase().includes("no such container")) {
      throw new Error("container not found");
    }
    throw err;
  }

  if (info.State.Running && !force) {
    throw new Error("running container, set force=true to remove");
  }

  const workspace = workspaceFromLabels(info.Config?.Labels ?? {});
  await container.remove({ force, v: removeVolumes });

  if (workspace && config) {
    await new LvmWorkspaceManager(config.lvmWorkspace).cleanup(workspace);
  }

  return {
    containerId: info.Id,
    removed: true,
    ...(workspace ? { workspaceRemoved: Boolean(config), workspace } : {}),
  };
}
