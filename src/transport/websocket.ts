import WebSocket from "ws";
import { createLogger } from "../logger.js";
import type { AppConfig, CommandRequest, CommandResponse, WsMessage } from "../types/index.js";

const log = createLogger("ws");

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_RANGE = 500;
const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;

export class AgentWebSocket {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

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
        resolved = true;
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connection") {
            log.info(`Server: ${msg.message}`);
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
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error(`Send failed: ${(err as Error).message}`);
    }
  }

  sendResponse(response: CommandResponse): void {
    if (!this.isConnected || !this.ws) return;

    try {
      this.ws.send(JSON.stringify(response));
    } catch (err) {
      log.error(`Response send failed: ${(err as Error).message}`);
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, "Agent shutting down");
      this.ws = null;
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

  private clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }
}

function buildWsUrl(backendUrl: string, agentId: string, token: string): string {
  const base = backendUrl.replace(/\/$/, "");
  return `${base}/ws/server/${agentId}/?token=${token}`;
}
