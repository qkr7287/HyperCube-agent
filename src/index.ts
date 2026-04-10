import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { collectSystemMetrics } from "./collectors/system.js";
import { DockerCollector } from "./collectors/docker.js";
import { DeltaEngine } from "./sync/delta.js";
import { dispatchCommand } from "./handlers/index.js";
import { registerAgent, pollApproval } from "./transport/register.js";
import { AgentWebSocket } from "./transport/websocket.js";

const log = createLogger("agent");
const collectLog = createLogger("collector");
const abortController = new AbortController();
let collectTimer: ReturnType<typeof setInterval> | null = null;
let collecting = false;

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(`Starting HyperCube Agent (${config.agentHostname})`);

  // initialize docker client
  const dockerCollector = new DockerCollector(config.dockerSocket);
  const dockerAvailable = await dockerCollector.probe();
  if (!dockerAvailable) {
    log.warn("Docker not available. System metrics only. Will retry Docker every 30s.");
  }

  // register with backend
  const registration = await registerAgent(config);

  // wait for approval if pending
  let token = registration.token;
  if (registration.status === "pending" || !token) {
    token = await pollApproval(config, registration.id, abortController.signal);
  }

  // connect websocket
  const ws = new AgentWebSocket(config, registration.id, token);
  const deltaEngine = new DeltaEngine();

  ws.onReconnect = () => {
    log.info("Reconnected. Sending full snapshot on next cycle.");
    deltaEngine.reset();
  };

  ws.onCommand = (request) => {
    return dispatchCommand(dockerCollector.getDocker(), request);
  };

  // initial connection with retry
  await connectWithRetry(ws);

  // send first snapshot (no timeout — first systeminformation call can be slow)
  log.info("Sending initial snapshot...");
  await collectAndSend(config, ws, deltaEngine, dockerCollector);

  // start collection loop after first snapshot
  const collectTimeout = config.collectInterval * 3;
  log.info(`Collecting every ${config.collectInterval}ms (timeout: ${collectTimeout}ms)`);
  collectTimer = setInterval(() => {
    if (collecting) {
      log.debug("Previous collection still running. Skipping cycle.");
      return;
    }
    collecting = true;
    withTimeout(
      collectAndSend(config, ws, deltaEngine, dockerCollector),
      collectTimeout,
    )
      .catch((err) => {
        log.error(`Collection error: ${(err as Error).message}`);
      })
      .finally(() => {
        collecting = false;
      });
  }, config.collectInterval);
}

async function collectAndSend(
  config: ReturnType<typeof loadConfig>,
  ws: AgentWebSocket,
  deltaEngine: DeltaEngine,
  dockerCollector: DockerCollector,
): Promise<void> {
  if (!ws.isConnected) return;

  const now = new Date().toISOString();

  // collect system metrics
  try {
    const system = await collectSystemMetrics(config.agentHostname);
    const systemDelta = deltaEngine.computeSystemDelta(system);
    if (systemDelta) {
      ws.send({
        type: "system_metrics",
        data: systemDelta as unknown as Record<string, unknown>,
        timestamp: now,
      });
    }
  } catch (err) {
    collectLog.error(`System metrics failed: ${(err as Error).message}`);
  }

  // collect containers (skipped automatically when Docker unavailable)
  const containers = await dockerCollector.collectContainers();
  if (containers.length > 0) {
    const containersDelta = deltaEngine.computeContainersDelta(containers);
    if (containersDelta) {
      ws.send({
        type: "containers",
        data: { containers: containersDelta } as unknown as Record<string, unknown>,
        timestamp: now,
      });
    }

    // collect container metrics (only for running containers)
    const metrics = await dockerCollector.collectAllContainerMetrics(containers);
    const metricsDelta = deltaEngine.computeContainerMetricsDelta(metrics);
    if (metricsDelta) {
      for (const [, m] of Object.entries(metricsDelta)) {
        ws.send({
          type: "container_metrics",
          data: m as unknown as Record<string, unknown>,
          timestamp: now,
        });
      }
    }
  }
}

async function connectWithRetry(ws: AgentWebSocket): Promise<void> {
  while (true) {
    try {
      await ws.connect();
      return;
    } catch {
      log.warn("Initial connection failed. Retrying via backoff...");
      await sleep(3000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Collection timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// --- Graceful Shutdown ---

function shutdown(signal: string): void {
  log.info(`Received ${signal}. Shutting down...`);
  abortController.abort();
  if (collectTimer) clearInterval(collectTimer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  log.error(`Unhandled rejection: ${err}`);
});

// --- Start ---

main().catch((err) => {
  log.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
