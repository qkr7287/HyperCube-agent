import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { collectSystemMetrics } from "./collectors/system.js";
import { DockerCollector } from "./collectors/docker.js";
import { collectGpuPerContainer } from "./collectors/gpu-per-container.js";
import { DeltaEngine } from "./sync/delta.js";
import { dispatchCommand } from "./handlers/index.js";
import { registerAgent } from "./transport/register.js";
import { AgentWebSocket } from "./transport/websocket.js";

const log = createLogger("agent");
const collectLog = createLogger("collector");
const abortController = new AbortController();
let collectTimer: ReturnType<typeof setInterval> | null = null;
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
  const deltaEngine = new DeltaEngine();

  ws.onReconnect = () => {
    log.info("Reconnected. Sending full snapshot on next cycle.");
    deltaEngine.reset();
    lastContainersFullSnapshotAt = 0;
    lastContainerMetricsFullSnapshotAt = 0;
  };

  ws.onCommand = (request) => {
    return dispatchCommand(dockerCollector.getDocker(), request, (progress) => {
      ws.sendProgress({
        type: "command_progress",
        requestId: request.requestId,
        ...progress,
      });
    });
  };

  // initial connection with retry
  await connectWithRetry(ws);

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
    const system = await collectSystemMetrics(config.agentHostname, config.dcgmExporterUrl);
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
  process.exit(0);
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
