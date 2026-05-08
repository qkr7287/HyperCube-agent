import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type {
  ContainerEvent,
  ContainerEventKind,
  ContainerHealthStatus,
} from "../types/index.js";

const log = createLogger("events");

const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const BATCH_FLUSH_MS = 100;

type EventHandler = (events: ContainerEvent[]) => void;

interface DockerEventActor {
  ID?: string;
  Attributes?: Record<string, string>;
}

interface RawDockerEvent {
  Type?: string;
  Action?: string;
  Actor?: DockerEventActor;
  time?: number;
  timeNano?: number;
}

export class DockerEventSubscriber {
  private stream: NodeJS.ReadableStream | null = null;
  private buffer: ContainerEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartBackoff = RESTART_BACKOFF_MIN_MS;
  private stopped = false;
  private lineBuffer = "";

  constructor(
    private readonly docker: Dockerode,
    private readonly onEvents: EventHandler,
  ) {}

  start(): void {
    this.stopped = false;
    void this.subscribe();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
    this.lineBuffer = "";
    this.detachStream();
  }

  private async subscribe(): Promise<void> {
    if (this.stopped) return;
    try {
      const stream = await this.docker.getEvents({
        filters: { type: ["container"] },
      });
      if (this.stopped) {
        // Detach without invoking handlers — we may have been stopped while
        // awaiting the request.
        try {
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        } catch {
          // ignore
        }
        return;
      }
      this.stream = stream;
      this.lineBuffer = "";
      this.restartBackoff = RESTART_BACKOFF_MIN_MS;
      log.info("Subscribed to Docker container events.");

      stream.on("data", (chunk: Buffer | string) => this.onData(chunk));
      stream.on("error", (err: Error) => {
        log.warn(`Event stream error: ${err.message}`);
        this.scheduleResubscribe();
      });
      stream.on("close", () => {
        if (!this.stopped) {
          log.warn("Event stream closed by daemon.");
          this.scheduleResubscribe();
        }
      });
      stream.on("end", () => {
        if (!this.stopped) {
          log.warn("Event stream ended.");
          this.scheduleResubscribe();
        }
      });
    } catch (err) {
      log.warn(`getEvents failed: ${(err as Error).message}`);
      this.scheduleResubscribe();
    }
  }

  private detachStream(): void {
    if (!this.stream) return;
    try {
      this.stream.removeAllListeners("data");
      this.stream.removeAllListeners("error");
      this.stream.removeAllListeners("close");
      this.stream.removeAllListeners("end");
      (this.stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    } catch {
      // ignore
    }
    this.stream = null;
  }

  private scheduleResubscribe(): void {
    this.detachStream();
    if (this.stopped) return;
    if (this.restartTimer) return;

    const delay = this.restartBackoff;
    this.restartBackoff = Math.min(
      this.restartBackoff * 2,
      RESTART_BACKOFF_MAX_MS,
    );
    log.info(`Re-subscribing to Docker events in ${Math.round(delay / 1000)}s...`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.subscribe();
    }, delay);
  }

  private onData(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.lineBuffer += text;

    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf("\n")) >= 0) {
      const line = this.lineBuffer.slice(0, newlineIdx).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let raw: RawDockerEvent;
    try {
      raw = JSON.parse(line) as RawDockerEvent;
    } catch (err) {
      log.debug(`Skipping unparsable event line: ${(err as Error).message}`);
      return;
    }

    const event = mapEvent(raw);
    if (!event) return;

    this.buffer.push(event);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), BATCH_FLUSH_MS);
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.onEvents(batch);
    } catch (err) {
      log.error(`onEvents handler threw: ${(err as Error).message}`);
    }
  }
}

function mapEvent(raw: RawDockerEvent): ContainerEvent | null {
  if (raw.Type !== "container") return null;
  const action = raw.Action ?? "";
  const actor = raw.Actor ?? {};
  const containerId = actor.ID;
  if (!containerId) return null;

  const ts = unixSecondsToIso(raw.time);
  const name = actor.Attributes?.name;

  // Plain lifecycle actions: start, stop, restart, pause, unpause, oom.
  const simple: Record<string, ContainerEventKind> = {
    start: "start",
    stop: "stop",
    restart: "restart",
    pause: "pause",
    unpause: "unpause",
    oom: "oom",
  };
  if (action in simple) {
    return { containerId, name, ts, kind: simple[action] };
  }

  if (action === "die") {
    const exitCode = parseIntOrUndefined(actor.Attributes?.exitCode);
    const event: ContainerEvent = { containerId, name, ts, kind: "die" };
    if (exitCode !== undefined) event.exitCode = exitCode;
    return event;
  }

  if (action === "kill") {
    const signal = actor.Attributes?.signal;
    const event: ContainerEvent = { containerId, name, ts, kind: "kill" };
    if (signal) event.signal = normalizeSignal(signal);
    return event;
  }

  // health_status comes as "health_status: healthy" / "unhealthy" / "starting".
  if (action.startsWith("health_status")) {
    const status = parseHealthStatus(action);
    if (!status) return null;
    return { containerId, name, ts, kind: "health_status", healthStatus: status };
  }

  // Drop everything else (create, destroy, exec_*, attach, commit, rename,
  // update, top, ...) as noise.
  return null;
}

function unixSecondsToIso(time: number | undefined): string {
  if (typeof time === "number" && Number.isFinite(time)) {
    return new Date(time * 1000).toISOString();
  }
  return new Date().toISOString();
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Docker reports kill signals as the bare number ("9") on cgroup v2 hosts and
// as "SIGKILL" on others. Normalize to the SIG-prefixed name when we can,
// otherwise pass through unchanged so the backend keeps full information.
const SIGNAL_BY_NUMBER: Record<string, string> = {
  "1": "SIGHUP",
  "2": "SIGINT",
  "3": "SIGQUIT",
  "9": "SIGKILL",
  "15": "SIGTERM",
};

function normalizeSignal(value: string): string {
  return SIGNAL_BY_NUMBER[value] ?? value;
}

function parseHealthStatus(action: string): ContainerHealthStatus | null {
  const colonIdx = action.indexOf(":");
  if (colonIdx < 0) return null;
  const status = action.slice(colonIdx + 1).trim();
  if (status === "healthy" || status === "unhealthy" || status === "starting") {
    return status;
  }
  return null;
}
