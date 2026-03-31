import { loadConfig } from "./config.js";
import { collectSystemMetrics } from "./collectors/system.js";
import { initDocker, collectContainers, collectAllContainerMetrics } from "./collectors/docker.js";
import { DeltaEngine } from "./sync/delta.js";
import { registerAgent, pollApproval } from "./transport/register.js";
import { AgentWebSocket } from "./transport/websocket.js";
import type { WsMessage } from "./types/index.js";

const abortController = new AbortController();
let collectTimer: ReturnType<typeof setInterval> | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[agent] Starting HyperCube Agent (${config.agentHostname})`);

  // initialize docker client
  initDocker(config.dockerSocket);

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
    console.log("[agent] Reconnected. Sending full snapshot on next cycle.");
    deltaEngine.reset();
  };

  // initial connection with retry
  await connectWithRetry(ws);

  // start collection loop
  console.log(`[agent] Collecting every ${config.collectInterval}ms`);
  collectTimer = setInterval(() => {
    collectAndSend(config, ws, deltaEngine).catch((err) => {
      console.error(`[agent] Collection error: ${(err as Error).message}`);
    });
  }, config.collectInterval);

  // send first snapshot immediately
  await collectAndSend(config, ws, deltaEngine);
}

async function collectAndSend(
  config: ReturnType<typeof loadConfig>,
  ws: AgentWebSocket,
  deltaEngine: DeltaEngine,
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
    console.error(`[collector] System metrics failed: ${(err as Error).message}`);
  }

  // collect containers
  try {
    const containers = await collectContainers();
    const containersDelta = deltaEngine.computeContainersDelta(containers);
    if (containersDelta) {
      ws.send({
        type: "containers",
        data: { containers: containersDelta } as unknown as Record<string, unknown>,
        timestamp: now,
      });
    }

    // collect container metrics (only for running containers)
    const metrics = await collectAllContainerMetrics(containers);
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
  } catch (err) {
    console.error(`[collector] Docker metrics failed: ${(err as Error).message}`);
  }
}

async function connectWithRetry(ws: AgentWebSocket): Promise<void> {
  while (true) {
    try {
      await ws.connect();
      return;
    } catch {
      console.warn("[agent] Initial connection failed. Retrying via backoff...");
      await sleep(3000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Graceful Shutdown ---

function shutdown(signal: string): void {
  console.log(`[agent] Received ${signal}. Shutting down...`);
  abortController.abort();
  if (collectTimer) clearInterval(collectTimer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  console.error("[agent] Unhandled rejection:", err);
});

// --- Start ---

main().catch((err) => {
  console.error(`[agent] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
