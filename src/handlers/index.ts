import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type {
  AppConfig,
  CommandRequest,
  CommandResponse,
  ProgressEmitter,
} from "../types/index.js";
import type { LogStreamRegistry } from "../streaming/log-stream-registry.js";
import type { ExecRegistry } from "../streaming/exec-registry.js";
import { handleGetLogs } from "./logs.js";
import { handleInspect } from "./inspect.js";
import { handleControl } from "./control.js";
import { handleSystemInfo } from "./system-info.js";
import { handleCreateContainer } from "./create-container.js";
import { handleUpdateContainer } from "./update-container.js";
import { handleImageInspect } from "./image-inspect.js";
import { handlePrepareModelAssets } from "./prepare-model-assets.js";
import { handleQueryModelCache } from "./query-model-cache.js";
import { handleDeleteContainer } from "./delete-container.js";
import { handleComposeUp } from "./compose-up.js";
import { handleComposeDown } from "./compose-down.js";
import { handleContainerProcesses } from "./container-processes.js";
import { handleHostPortScan } from "./host-port-scan.js";

const log = createLogger("dispatcher");

const DOCKER_COMMANDS = new Set([
  "get_logs",
  "inspect",
  "image_inspect",
  "control",
  "create_container",
  "update_container",
  "delete_container",
  "compose_up",
  "compose_down",
  "logs_subscribe",
  "logs_unsubscribe",
  "container_processes",
  "exec_open",
  "exec_input",
  "exec_resize",
  "exec_close",
]);

export async function dispatchCommand(
  docker: Dockerode | null,
  request: CommandRequest,
  emitProgress: ProgressEmitter,
  logRegistry: LogStreamRegistry,
  execRegistry: ExecRegistry,
  config: AppConfig,
  agentToken: string,
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
      case "image_inspect":
        data = await handleImageInspect(docker!, params);
        break;
      case "control":
        data = await handleControl(docker!, params);
        break;
      case "system_info":
        data = await handleSystemInfo(params);
        break;
      case "create_container":
        data = await handleCreateContainer(docker!, params, emitProgress, config);
        break;
      case "update_container":
        data = await handleUpdateContainer(docker!, params);
        break;
      case "prepare_model_assets":
        data = await handlePrepareModelAssets(config, agentToken, requestId, params, emitProgress);
        break;
      case "query_model_cache":
        data = await handleQueryModelCache(config, params);
        break;
      case "host_port_scan":
        data = await handleHostPortScan(config);
        break;
      case "delete_container":
        data = await handleDeleteContainer(docker!, params, config);
        break;
      case "compose_up":
        data = await handleComposeUp(docker!, params, emitProgress);
        break;
      case "compose_down":
        data = await handleComposeDown(docker!, params);
        break;
      case "container_processes":
        data = await handleContainerProcesses(docker!, config, params);
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
      case "exec_open": {
        const result = await execRegistry.start(docker!, requestId, params);
        if (!result.success) {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: result.error ?? "exec_open failed",
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
      case "exec_input": {
        const execId = (params as { execId?: unknown }).execId;
        const data = (params as { data?: unknown }).data;
        if (typeof execId !== "string" || execId.length === 0) {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: "execId is required",
          };
        }
        if (typeof data !== "string") {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: "data is required (base64 string)",
          };
        }
        const result = execRegistry.write(execId, data);
        return {
          type: "command_response",
          requestId,
          success: result.success,
          data: result.data as unknown as Record<string, unknown> | undefined,
          error: result.error,
        };
      }
      case "exec_resize": {
        const execId = (params as { execId?: unknown }).execId;
        const cols = (params as { cols?: unknown }).cols;
        const rows = (params as { rows?: unknown }).rows;
        if (typeof execId !== "string" || execId.length === 0) {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: "execId is required",
          };
        }
        if (typeof cols !== "number" || typeof rows !== "number") {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: "cols and rows are required (numbers)",
          };
        }
        const result = await execRegistry.resize(execId, cols, rows);
        return {
          type: "command_response",
          requestId,
          success: result.success,
          data: result.data as unknown as Record<string, unknown> | undefined,
          error: result.error,
        };
      }
      case "exec_close": {
        const execId = (params as { execId?: unknown }).execId;
        if (typeof execId !== "string" || execId.length === 0) {
          return {
            type: "command_response",
            requestId,
            success: false,
            error: "execId is required",
          };
        }
        // User/UI-initiated close → reason="kill". Idempotent.
        const result = await execRegistry.stop(execId, "kill");
        log.info(`Command ${command} completed (${requestId})`);
        return {
          type: "command_response",
          requestId,
          success: true,
          data: result.data as unknown as Record<string, unknown>,
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
