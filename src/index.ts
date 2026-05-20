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
import type { CommandResponse } from "./types/index.js";

const log = createLogger("agent");
const collectLog = createLogger("collector");
const abortController = new AbortController();
let collectTimer: ReturnType<typeof setInterval> | null = null;
let capacityTimer: ReturnType<typeof setInterval> | null = null;
let logRegistryRef: LogStreamRegistry | null = null;
let execRegistryRef: ExecRegistry | null = null;
let wsRef: AgentWebSocket | null = null;
let collecting = false;
let lastContainersFullSnapshotAt = 0;
let lastContainerMetricsFullSnapshotAt = 0;
const CONTAINERS_FULL_SNAPSHOT_INTERVAL_MS = 60_000;
const CONTAINER_METRICS_FULL_SNAPSHOT_INTERVAL_MS = 60_000;
// Hard ceiling per collection cycle. Sized to be 2-3x the worst-case cost
// of dockerode stats over many containers (server 16 has ~72 containers
// where collectAllContainerMetrics takes ~15s). The ceiling exists only as
// a safety net against truly stuck calls (e.g. lspci hanging on a slim
// image). A normally slow tick is still allowed to finish.
const MAX_COLLECT_CYCLE_MS = 60_000;

const HEAP_LOG_INTERVAL_MS = 60_000;

// Host capacity is near-static; an hourly refresh keeps the backend's
// workspace-quota handshake state current without spamming the socket.
const CAPACITY_REPORT_INTERVAL_MS = 60 * 60 * 1000;

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

  // initialize docker client
  const dockerCollector = new DockerCollector(config.dockerSocket);
  const dockerAvailable = await dockerCollector.probe();
  if (!dockerAvailable) {
    log.warn("Docker not available. System metrics only. Will retry Docker every 30s.");
  }

  // register with backend (auto-approved — token returned immediately)
  const registration = await registerAgent(config);
  const token = registration.token;
  if (!token) {
    throw new Error(
      `Registration response missing token (status=${registration.status}). Backend must auto-approve.`,
    );
  }

  // connect websocket
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
    void sendCapacityReport(config, registration.id, ws).catch((err) => {
      log.warn(`capacity_report on reconnect skipped: ${(err as Error).message}`);
    });
    startEventSubscriber();
  };

  ws.onCommand = (request) => {
    // request_capacity is handled here rather than dispatchCommand: the
    // capacity report is an index-level concern (it shares the ws-send path
    // and the hourly timer) and the backend gates quota provisioning on it.
    if (request.command === "request_capacity") {
      return sendCapacityReport(config, registration.id, ws)
        .then((): CommandResponse => ({
          type: "command_response",
          requestId: request.requestId,
          success: true,
          data: { sent: true },
        }))
        .catch((err): CommandResponse => ({
          type: "command_response",
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

  // WS disconnect → clean up all active streams. Browser owns re-subscribe
  // responsibility per spec; chunks emitted while disconnected would be
  // dropped by ws.send anyway.
  ws.onClose = () => {
    logRegistry.closeAll(null);
    void execRegistry.closeAll(null);
  };

  // initial connection with retry
  await connectWithRetry(ws);

  // send initial host capacity report (best-effort — backend gates
  // workspace-quota provisioning on capacity_report.data.disk.workspaceQuota).
  await sendCapacityReport(config, registration.id, ws).catch((err) => {
    log.warn(`Initial capacity_report skipped: ${(err as Error).message}`);
  });
  capacityTimer = setInterval(() => {
    void sendCapacityReport(config, registration.id, ws).catch((err) => {
      log.warn(`capacity_report failed: ${(err as Error).message}`);
    });
  }, CAPACITY_REPORT_INTERVAL_MS);

  // begin streaming Docker container lifecycle events (no-op when Docker
  // unavailable; collectContainers loop will retry the daemon, after which
  // a future reconnect or manual restart will pick up the stream).
  startEventSubscriber();

  // send first snapshot with timeout — if si.* hangs, still start collect loop
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

  // start collection loop regardless of initial snapshot result
  log.info(`Collecting every ${config.collectInterval}ms`);
  let consecutiveSkips = 0;
  collectTimer = setInterval(() => {
    if (collecting) {
      consecutiveSkips++;
      // Log first skip and then every 30th (~once a minute at 2s interval)
      // to avoid drowning the docker log driver in noise during slow cycles.
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
        // Stuck cycle releases the lock so the next tick can run; the
        // background promise may still resolve later but its result is
        // ignored. This trades a possible memory leak under repeated hangs
        // for liveness, which matters more for a heartbeat agent.
        const msg = (err as Error).message;
        if (msg.startsWith("cycle exceeded")) {
          log.warn(`Collection ${msg} — abandoning to keep loop alive`);
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

  // collect system metrics
  try {
    const system = await collectSystemMetrics(
      config.agentHostname,
      config.dcgmExporterUrl,
      config.hostSysPath,
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

    // periodic full snapshot as safety net (independent of delta)
    const nowMs = Date.now();
    if (nowMs - lastContainersFullSnapshotAt >= CONTAINERS_FULL_SNAPSHOT_INTERVAL_MS) {
      ws.send({
        type: "containers",
        data: { containers } as unknown as Record<string, unknown>,
        timestamp: now,
      });
      lastContainersFullSnapshotAt = nowMs;
    }

    // collect container metrics (only for running containers)
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

    // periodic full snapshot for container_metrics (safety net for idle containers)
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
): Promise<void> {
  const report = await buildCapacityReport(config, agentId);
  ws.send(report);
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

// --- Graceful Shutdown ---

function shutdown(signal: string): void {
  log.info(`Received ${signal}. Shutting down...`);
  abortController.abort();
  if (collectTimer) clearInterval(collectTimer);
  if (capacityTimer) clearInterval(capacityTimer);
  if (logRegistryRef) {
    logRegistryRef.closeAll("agent_shutdown");
  }
  if (execRegistryRef) {
    // exec_end reason enum has no agent_shutdown; "kill" is the closest
    // forced-termination signal the browser knows about.
    void execRegistryRef.closeAll("kill");
  }
  // Give the socket ~150ms to flush log_stream_end / exec_end frames before
  // tearing down. Without this the SIGTERM → process.exit race drops the
  // final batch on the floor.
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
// Without this handler, a synchronous throw in a timer/event callback kills
// the process under Node's default policy but the stack trace can get lost
// if stderr isn't flushed. Log explicitly, then exit so the container's
// restart policy (or dev-supervisor) can recover instead of us running on
// potentially corrupted state.
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

// --- Start ---

main().catch((err) => {
  log.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
