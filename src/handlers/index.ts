import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type { CommandRequest, CommandResponse, ProgressEmitter } from "../types/index.js";
import { handleGetLogs } from "./logs.js";
import { handleInspect } from "./inspect.js";
import { handleControl } from "./control.js";
import { handleSystemInfo } from "./system-info.js";
import { handleCreateContainer } from "./create-container.js";
import { handleDeleteContainer } from "./delete-container.js";
import { handleComposeUp } from "./compose-up.js";
import { handleComposeDown } from "./compose-down.js";

const log = createLogger("dispatcher");

const DOCKER_COMMANDS = new Set([
  "get_logs",
  "inspect",
  "control",
  "create_container",
  "delete_container",
  "compose_up",
  "compose_down",
]);

export async function dispatchCommand(
  docker: Dockerode | null,
  request: CommandRequest,
  emitProgress: ProgressEmitter,
): Promise<CommandResponse> {
  const { requestId, command, params } = request;

  try {
    if (DOCKER_COMMANDS.has(command) && !docker) {
      return {
        type: "command_response",
        requestId,
        success: false,
        error: "Docker is not available on this agent.",
      };
    }

    log.info(`Executing command: ${command} (${requestId})`);

    let data: Record<string, unknown>;

    switch (command) {
      case "get_logs":
        data = await handleGetLogs(docker!, params);
        break;
      case "inspect":
        data = await handleInspect(docker!, params);
        break;
      case "control":
        data = await handleControl(docker!, params);
        break;
      case "system_info":
        data = await handleSystemInfo(params);
        break;
      case "create_container":
        data = await handleCreateContainer(docker!, params, emitProgress);
        break;
      case "delete_container":
        data = await handleDeleteContainer(docker!, params);
        break;
      case "compose_up":
        data = await handleComposeUp(docker!, params, emitProgress);
        break;
      case "compose_down":
        data = await handleComposeDown(docker!, params);
        break;
      default:
        return {
          type: "command_response",
          requestId,
          success: false,
          error: `Unknown command: ${command}`,
        };
    }

    log.info(`Command ${command} completed (${requestId})`);
    return { type: "command_response", requestId, success: true, data };
  } catch (err) {
    const message = (err as Error).message;
    log.error(`Command ${command} failed (${requestId}): ${message}`);
    return {
      type: "command_response",
      requestId,
      success: false,
      error: message,
    };
  }
}
