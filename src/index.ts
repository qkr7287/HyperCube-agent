import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { collectSystemMetrics } from "./collectors/system.js";
import { buildCapacityReport } from "./collectors/capacity.js";
import { DockerCollector } from "./collectors/docker.js";
import { collectGpuPerContainer } from "./collectors/gpu-per-container.js";
import { DockerEventSubscriber } from "./collectors/docker-events.js";
import { DeltaEngine } from "./sync/delta.js";
import { dispatchCommand } from "./handlers/index.js";
import { LogStreamRegistry } from "./streaming/log-stream-registry.js";
import { ExecRegistry } from "./streaming/exec-registry.js";
import { registerAgent } from "./transport/register.js";
import { AgentWebSocket } from "./transport/websocket.js";

const log = createLogger("agent");
const collectLog = createLogger("collector");
const abortController = new AbortController();
let collectTimer: ReturnType<typeof setInterval> | null = null;
let logRegistryRef: LogStreamRegistry | null = null;
let execRegistryRef: ExecRegistry | null = null;
let wsRef: AgentWebSocket | null = null;
let capacityTimer: ReturnType<typeof setInterval> | null = null;
let collecting = false;
let lastContainersFullSnapshotAt = 0;
let lastContainerMetricsFullSnapshotAt = 0;
const CONTAINERS_FULL_SNAPSHOT_INTERVAL_MS = 60_000;
const CONTAINER_METRICS_FULL_SNAPSHOT_INTERVAL_MS = 60_000;
const CAPACITY_REPORT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_COLLECT_CYCLE_MS = 60_000;
const HEAP_LOG_INTERVAL_MS = 60_000;

function startHeapWatch(): void {
  setInterval(() => {
    const m = process.memoryUsage();
    const heapMb = (m.heapUsed / 1_048_576).toFixed(0);
    const rssMb = (m.rss / 1_048_576).toFixed(0);
    const heapTotalMb = (m.heapTotal / 1_048_576).toFixed(0);
    log.info(`mem heap=${heapMb}/${heapTotalMb}MB rss=${rssMb}MB`);
  }, HEAP_LOG_INTERVAL_MS).unref();
}

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(`Starting HyperCube Agent (${config.agentHostname})`);
  startHeapWatch();

  const dockerCollector = new DockerCollector(config.dockerSocket);
  dockerCollector.setWorkspaceQuotaConfig(config.workspaceQuota);
  const dockerAvailable = await dockerCollector.probe();
  if (!dockerAvailable) {
    log.warn("Docker not available. System metrics only. Will retry Docker every 30s.");
  }

  const registration = await registerAgent(config);
  const token = registration.token;
  if (!token) {
    throw new Error(
      `Registration response missing token (status=${registration.status}). Backend must auto-approve.`,
    );
  }

  const ws = new AgentWebSocket(config, registration.id, token);
  wsRef = ws;
  const deltaEngine = new DeltaEngine();
  const logRegistry = new LogStreamRegistry((msg) => ws.send(msg));
  logRegistryRef = logRegistry;
  const execRegistry = new ExecRegistry((msg) => ws.send(msg));
  execRegistryRef = execRegistry;

  let eventSubscriber: DockerEventSubscriber | null = null;
  const startEventSubscriber = (): void => {
    const dockerClient = dockerCollector.getDocker();
    if (!dockerClient) return;
    if (eventSubscriber) {
      eventSubscriber.stop();
      eventSubscriber = null;
    }
    eventSubscriber = new DockerEventSubscriber(dockerClient, (events) => {
      if (!ws.isConnected || events.length === 0) return;
      ws.send({
        type: "container_events",
        data: { events } as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    });
    eventSubscriber.start();
  };

  ws.onReconnect = () => {
    log.info("Reconnected. Sending full snapshot on next cycle.");
    deltaEngine.reset();
    lastContainersFullSnapshotAt = 0;
    lastContainerMetricsFullSnapshotAt = 0;
    void sendCapacityReport(config, registration.id, ws);
    startEventSubscriber();
  };

  ws.onCommand = (request) => {
    if (request.command === "request_capacity") {
      return sendCapacityReport(config, registration.id, ws)
        .then((report) => ({
          type: "command_response" as const,
          requestId: request.requestId,
          success: true,
          data: { sent: true, capacity: report.data as unknown as Record<string, unknown> },
        }))
        .catch((err) => ({
          type: "command_response" as const,
          requestId: request.requestId,
          success: false,
          error: (err as Error).message,
        }));
    }
    return dispatchCommand(
      dockerCollector.getDocker(),
      request,
      (progress) => {
        ws.sendProgress({
          type: "command_progress",
          requestId: request.requestId,
          ...progress,
        });
      },
      logRegistry,
      execRegistry,
      config,
      token,
    );
  };

  ws.onClose = () => {
    logRegistry.closeAll(null);
    void execRegistry.closeAll(null);
  };

  await connectWithRetry(ws);
  await sendCapacityReport(config, registration.id, ws).catch((err) => {
    log.warn(`Initial capacity_report skipped: ${(err as Error).message}`);
  });
  capacityTimer = setInterval(() => {
    void sendCapacityReport(config, registration.id, ws).catch((err) => {
      log.warn(`capacity_report failed: ${(err as Error).message}`);
    });
  }, CAPACITY_REPORT_INTERVAL_MS);

  startEventSubscriber();

  log.info("Sending initial snapshot...");
  try {
    await Promise.race([
      collectAndSend(config, ws, deltaEngine, dockerCollector),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("initial snapshot timeout")), 1_000),
      ),
    ]);
  } catch (err) {
    log.warn(`Initial snapshot skipped: ${(err as Error).message}`);
  }

  log.info(`Collecting every ${config.collectInterval}ms`);
  let consecutiveSkips = 0;
  collectTimer = setInterval(() => {
    if (collecting) {
      consecutiveSkips++;
      if (consecutiveSkips === 1 || consecutiveSkips % 30 === 0) {
        log.debug(`Previous collection still running. Skipping (${consecutiveSkips} consecutive).`);
      }
      return;
    }
    if (consecutiveSkips > 0) {
      log.info(`Cycle resumed after ${consecutiveSkips} skipped tick(s).`);
      consecutiveSkips = 0;
    }
    collecting = true;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`cycle exceeded ${MAX_COLLECT_CYCLE_MS}ms`)),
        MAX_COLLECT_CYCLE_MS,
      );
    });
    Promise.race([
      collectAndSend(config, ws, deltaEngine, dockerCollector),
      timeoutPromise,
    ])
      .catch((err) => {
        const msg = (err as Error).message;
        if (msg.startsWith("cycle exceeded")) {
          log.warn(`Collection ${msg} - abandoning to keep loop alive`);
        } else {
          log.error(`Collection error: ${msg}`);
        }
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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

  try {
    const system = await collectSystemMetrics(
      config.agentHostname,
      config.dcgmExporterUrl,
      config.workspaceQuota,
    );
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

    const nowMs = Date.now();
    if (nowMs - lastContainersFullSnapshotAt >= CONTAINERS_FULL_SNAPSHOT_INTERVAL_MS) {
      ws.send({
        type: "containers",
        data: { containers } as unknown as Record<string, unknown>,
        timestamp: now,
      });
      lastContainersFullSnapshotAt = nowMs;
    }

    const runningContainers = containers.filter((c) => c.state === "running");
    const gpuMap = await collectGpuPerContainer(
      config,
      dockerCollector.getDocker(),
      runningContainers,
    );
    const metrics = await dockerCollector.collectAllContainerMetrics(containers, gpuMap);
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

    if (nowMs - lastContainerMetricsFullSnapshotAt >= CONTAINER_METRICS_FULL_SNAPSHOT_INTERVAL_MS) {
      for (const [, m] of Object.entries(metrics)) {
        ws.send({
          type: "container_metrics",
          data: m as unknown as Record<string, unknown>,
          timestamp: now,
        });
      }
      lastContainerMetricsFullSnapshotAt = nowMs;
    }
  }
}

async function sendCapacityReport(
  config: ReturnType<typeof loadConfig>,
  agentId: string,
  ws: AgentWebSocket,
) {
  const report = await buildCapacityReport(config, agentId);
  ws.send(report);
  return report;
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

function shutdown(signal: string): void {
  log.info(`Received ${signal}. Shutting down...`);
  abortController.abort();
  if (collectTimer) clearInterval(collectTimer);
  if (capacityTimer) clearInterval(capacityTimer);
  if (logRegistryRef) {
    logRegistryRef.closeAll("agent_shutdown");
  }
  if (execRegistryRef) {
    void execRegistryRef.closeAll("kill");
  }
  setTimeout(() => {
    try {
      wsRef?.close();
    } catch {
      // ignore
    }
    process.exit(0);
  }, 150);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  log.error(`Unhandled rejection: ${err}`);
});
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

main().catch((err) => {
  log.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
