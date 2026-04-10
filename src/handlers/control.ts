import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type { ContainerAction } from "../types/index.js";

const log = createLogger("handler:control");

const VALID_ACTIONS = new Set<ContainerAction>([
  "start", "stop", "restart", "pause", "unpause", "kill", "remove",
]);

export async function handleControl(
  docker: Dockerode,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const containerId = params.containerId as string | undefined;
  const action = params.action as ContainerAction | undefined;
  const force = (params.force as boolean) ?? false;

  if (!containerId) {
    throw new Error("containerId is required");
  }
  if (!action || !VALID_ACTIONS.has(action)) {
    throw new Error(`Invalid action: ${action}. Valid: ${[...VALID_ACTIONS].join(", ")}`);
  }

  log.info(`${action} container ${containerId}`);

  const container = docker.getContainer(containerId);

  switch (action) {
    case "start":
      await container.start();
      break;
    case "stop":
      await container.stop();
      break;
    case "restart":
      await container.restart();
      break;
    case "pause":
      await container.pause();
      break;
    case "unpause":
      await container.unpause();
      break;
    case "kill":
      await container.kill();
      break;
    case "remove":
      await container.remove({ force });
      break;
  }

  return { containerId, action, success: true };
}
