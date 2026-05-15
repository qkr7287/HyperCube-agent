import type Dockerode from "dockerode";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./types/index.js";
import { LvmWorkspaceManager, workspaceFromLabels } from "./workspace-lvm.js";

const log = createLogger("workspace:recovery");

const ACTIVE_STATES = new Set(["running", "restarting"]);

export async function recoverLvmWorkspaceMounts(
  docker: Dockerode | null,
  config: AppConfig,
): Promise<void> {
  if (!docker || !config.lvmWorkspace.enabled) return;

  const containers = await docker.listContainers({ all: true });
  const manager = new LvmWorkspaceManager(config.lvmWorkspace);
  let recovered = 0;

  for (const container of containers) {
    if (!ACTIVE_STATES.has(container.State ?? "")) continue;
    const workspace = workspaceFromLabels(container.Labels ?? {});
    if (!workspace) continue;

    try {
      await manager.ensureMounted(workspace);
      recovered += 1;
    } catch (err) {
      log.warn(
        `failed to recover workspace mount for ${container.Id}: ${(err as Error).message}`,
      );
    }
  }

  if (recovered > 0) {
    log.info(`Recovered ${recovered} LVM workspace mount(s).`);
  }
}
