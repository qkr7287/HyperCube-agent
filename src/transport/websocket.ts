import WebSocket from "ws";
import { createLogger } from "../logger.js";
import type { AppConfig, CommandProgress, CommandRequest, CommandResponse, WsMessage } from "../types/index.js";

const log = createLogger("ws");

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_RANGE = 500;
const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;
const SEND_STATS_INTERVAL = 60_000;
// Backend sends heartbeat every 15s; terminate if none arrives for this long.
const SILENCE_TIMEOUT = 60_000;
// Pending queue for command_response / command_progress when socket is down.
const MAX_PENDING_QUEUE = 1_000;
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
const DRAIN_INTERVAL_MS = 50; // ~20 msg/s

interface PendingMessage {
  payload: string;
  kind: "response" | "progress";
  enqueuedAt: number;
}

export class AgentWebSocket {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private sentCount = 0;
  private sentBytes = 0;
  private closed = false;
  private pendingQueue: PendingMessage[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  onReconnect: (() => void) | null = null;
  onCommand: ((request: CommandRequest) => Promise<CommandResponse>) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly agentId: string,
    private readonly token: string,
  ) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("WebSocket client is closed."));
        return;
      }

      const wsUrl = buildWsUrl(this.config.backendUrl, this.agentId, this.token);
      log.info(`Connecting to ${wsUrl.replace(/token=.+/, "token=***")}...`);

      this.ws = new WebSocket(wsUrl);
      let resolved = false;

      this.ws.on("open", () => {
        log.info("Connected.");
        this.backoff = INITIAL_BACKOFF;
        this.startHeartbeat();
        this.startSendStats();
        this.resetSilenceTimer();
        resolved = true;
        resolve();
      });

      this.ws.on("message", (data) => {
        this.resetSilenceTimer();
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connection") {
            log.info(`Server: ${msg.message}`);
            if (this.pendingQueue.length > 0) {
              log.info(`Draining ${this.pendingQueue.length} queued message(s).`);
              this.scheduleDrain();
            }
          } else if (msg.type === "heartbeat") {
            // silence timer already reset; no further action needed
          } else if (msg.type === "command" && this.onCommand) {
            this.onCommand(msg as CommandRequest)
              .then((response) => this.sendResponse(response))
              .catch((err) => {
                log.error(`Command handler error: ${(err as Error).message}`);
              });
          }
        } catch {
          // ignore non-JSON messages
        }
      });

      this.ws.on("pong", () => {
        this.clearPongTimeout();
      });

      this.ws.on("close", (code, reason) => {
        log.warn(`Disconnected: ${code} ${reason.toString()}`);
        this.stopHeartbeat();
        this.stopSendStats();
        this.stopSilenceTimer();
        this.stopDrain();
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed: ${code}`));
        }
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        log.error(`Error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  send(message: WsMessage): void {
    if (!this.isConnected || !this.ws) return;

    try {
      const payload = JSON.stringify(message);
      this.ws.send(payload);
      this.sentCount += 1;
      this.sentBytes += Buffer.byteLength(payload);
    } catch (err) {
      log.error(`Send failed: ${(err as Error).message}`);
    }
  }

  sendResponse(response: CommandResponse): void {
    this.sendCritical(JSON.stringify(response), "response");
  }

  sendProgress(progress: CommandProgress): void {
    this.sendCritical(JSON.stringify(progress), "progress");
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.stopSendStats();
    this.stopSilenceTimer();
    this.stopDrain();
    if (this.ws) {
      this.ws.close(1000, "Agent shutting down");
      this.ws = null;
    }
  }

  private sendCritical(payload: string, kind: "response" | "progress"): void {
    if (this.isConnected && this.ws) {
      try {
        this.ws.send(payload, (err) => {
          if (err) {
            log.warn(`${kind} send callback error: ${err.message}. Queueing.`);
            this.enqueuePending({ payload, kind, enqueuedAt: Date.now() });
          }
        });
        return;
      } catch (err) {
        log.warn(`${kind} send exception: ${(err as Error).message}. Queueing.`);
      }
    }
    this.enqueuePending({ payload, kind, enqueuedAt: Date.now() });
  }

  private enqueuePending(msg: PendingMessage): void {
    const now = Date.now();
    while (
      this.pendingQueue.length > 0 &&
      now - this.pendingQueue[0].enqueuedAt > MAX_PENDING_AGE_MS
    ) {
      this.pendingQueue.shift();
    }
    if (this.pendingQueue.length >= MAX_PENDING_QUEUE) {
      this.pendingQueue.shift();
      log.warn(`Pending queue full (${MAX_PENDING_QUEUE}). Dropped oldest.`);
    }
    this.pendingQueue.push(msg);
    log.info(`Queued ${msg.kind} (pending=${this.pendingQueue.length}).`);
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => this.drainOne(), 0);
  }

  private drainOne(): void {
    this.drainTimer = null;
    if (!this.isConnected || !this.ws) return;

    const msg = this.pendingQueue.shift();
    if (!msg) return;

    if (Date.now() - msg.enqueuedAt > MAX_PENDING_AGE_MS) {
      log.warn(`Dropping expired ${msg.kind} from queue.`);
      this.drainTimer = setTimeout(() => this.drainOne(), 0);
      return;
    }

    try {
      this.ws.send(msg.payload, (err) => {
        if (err) {
          log.error(`Drain ${msg.kind} send failed: ${err.message}. Requeueing.`);
          this.pendingQueue.unshift(msg);
        }
      });
    } catch (err) {
      log.error(`Drain ${msg.kind} exception: ${(err as Error).message}. Requeueing.`);
      this.pendingQueue.unshift(msg);
      return;
    }

    if (this.pendingQueue.length > 0) {
      this.drainTimer = setTimeout(() => this.drainOne(), DRAIN_INTERVAL_MS);
    } else {
      log.info("Pending queue drained.");
    }
  }

  private stopDrain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const jitter = Math.random() * JITTER_RANGE * 2 - JITTER_RANGE;
    const delay = Math.min(this.backoff + jitter, MAX_BACKOFF);
    log.info(`Reconnecting in ${Math.round(delay / 1000)}s...`);

    setTimeout(async () => {
      try {
        await this.connect();
        this.onReconnect?.();
      } catch {
        // connect() handles errors, backoff continues
      }
    }, delay);

    this.backoff = Math.min(this.backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (!this.isConnected || !this.ws) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        log.warn("Pong timeout. Closing connection.");
        this.ws?.terminate();
      }, PONG_TIMEOUT);
    }, PING_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  private startSendStats(): void {
    this.sentCount = 0;
    this.sentBytes = 0;
    this.statsTimer = setInterval(() => {
      if (this.sentCount === 0) return;
      const kb = (this.sentBytes / 1024).toFixed(1);
      log.info(`Sent ${this.sentCount} messages (${kb} KB) in last ${SEND_STATS_INTERVAL / 1000}s`);
      this.sentCount = 0;
      this.sentBytes = 0;
    }, SEND_STATS_INTERVAL);
  }

  private stopSendStats(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private resetSilenceTimer(): void {
    this.stopSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      log.warn(`No server messages for ${SILENCE_TIMEOUT / 1000}s. Reconnecting.`);
      this.ws?.terminate();
    }, SILENCE_TIMEOUT);
  }

  private stopSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}

function buildWsUrl(backendUrl: string, agentId: string, token: string): string {
  const base = backendUrl.replace(/\/$/, "");
  return `${base}/ws/server/${agentId}/?token=${token}`;
}
