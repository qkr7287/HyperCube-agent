import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type { CommandRequest, CommandResponse, ProgressEmitter } from "../types/index.js";
import type { LogStreamRegistry } from "../streaming/log-stream-registry.js";
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
  "logs_subscribe",
  "logs_unsubscribe",
]);

export async function dispatchCommand(
  docker: Dockerode | null,
  request: CommandRequest,
  emitProgress: ProgressEmitter,
  logRegistry: LogStreamRegistry,
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
      case "logs_subscribe": {
        const result = await logRegistry.start(docker!, requestId, params);
        if (!result.success) {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: result.error ?? "logs_subscribe failed",
          };
        }
        log.info(`Command ${command} completed (${requestId})`);
        return {
          type: "command_response",
          requestId,
          success: true,
          data: result.data as unknown as Record<string, unknown>,
        };
      }
      case "logs_unsubscribe": {
        const streamId = (params as { streamId?: unknown }).streamId;
        if (typeof streamId !== "string" || streamId.length === 0) {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: "streamId is required",
          };
        }
        const existed = logRegistry.stop(streamId);
        log.info(`Command ${command} completed (${requestId}) existed=${existed}`);
        // Idempotent: report ended:true regardless of whether the stream
        // was active. Backend should treat unsubscribe as best-effort.
        return {
          type: "command_response",
          requestId,
          success: true,
          data: { ended: true, streamId },
        };
      }
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
