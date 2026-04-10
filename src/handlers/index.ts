import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type { CommandRequest, CommandResponse } from "../types/index.js";
import { handleGetLogs } from "./logs.js";
import { handleInspect } from "./inspect.js";
import { handleControl } from "./control.js";
import { handleSystemInfo } from "./system-info.js";

const log = createLogger("dispatcher");

const DOCKER_COMMANDS = new Set(["get_logs", "inspect", "control"]);

export async function dispatchCommand(
  docker: Dockerode | null,
  request: CommandRequest,
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
