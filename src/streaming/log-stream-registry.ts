import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";
import type {
  LogChunkMessage,
  LogStreamEndMessage,
  LogStreamEndReason,
  LogStreamSource,
  WsMessage,
} from "../types/index.js";

const log = createLogger("logs-stream");

const BATCH_WINDOW_MS = 200;
const BATCH_LINE_THRESHOLD = 50;
const RELATIVE_SINCE_PATTERN = /^(\d+)([smh])$/;

interface SubscribeParams {
  containerId: string;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}

interface SubscribeResult {
  success: boolean;
  data?: { streamId: string; subscribed: true };
  error?: string;
}

type Sender = (msg: WsMessage) => void;

interface ActiveStream {
  streamId: string;
  containerId: string;
  dockerStream: NodeJS.ReadableStream;
  parser: FrameParser;
  lineBuffer: LineBuffer;
  batcher: LineBatcher;
  ended: boolean;
  emitEnd: boolean;
}

export class LogStreamRegistry {
  private streams = new Map<string, ActiveStream>();

  constructor(private readonly send: Sender) {}

  async start(
    docker: Dockerode,
    streamId: string,
    rawParams: Record<string, unknown>,
  ): Promise<SubscribeResult> {
    const params = rawParams as unknown as SubscribeParams;
    const containerId = params.containerId;
    if (!containerId) {
      return { success: false, error: "containerId is required" };
    }
    const tail = clampTail(params.tail);
    const timestamps = params.timestamps ?? true;
    const since = resolveSince(params.since);

    if (this.streams.has(streamId)) {
      // Should not happen — Backend uses unique requestIds. Treat as
      // programmer error rather than swallowing.
      return { success: false, error: `streamId already active: ${streamId}` };
    }

    const container = docker.getContainer(containerId);
    let dockerStream: NodeJS.ReadableStream;
    try {
      const result = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail,
        since,
        timestamps,
      });
      dockerStream = result as unknown as NodeJS.ReadableStream;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    const active: ActiveStream = {
      streamId,
      containerId,
      dockerStream,
      parser: new FrameParser(),
      lineBuffer: new LineBuffer(),
      batcher: new LineBatcher(streamId, (msg) => this.send(msg)),
      ended: false,
      emitEnd: true,
    };

    this.streams.set(streamId, active);
    this.attach(active);

    log.info(
      `subscribe streamId=${streamId} container=${containerId} tail=${tail} timestamps=${timestamps}` +
        (since ? ` since=${since}` : ""),
    );

    return { success: true, data: { streamId, subscribed: true } };
  }

  /**
   * Stop a stream by id. Returns true if the stream existed (regardless of
   * whether emit-end has been suppressed). Does NOT emit log_stream_end —
   * unsubscribe is acknowledged via the command_response only, per spec.
   */
  stop(streamId: string): boolean {
    const active = this.streams.get(streamId);
    if (!active) return false;
    active.emitEnd = false;
    this.terminate(active);
    return true;
  }

  /**
   * Stop all streams, optionally emitting log_stream_end with the given
   * reason. Used for WS reconnect cleanup (no emit — peer is gone) and
   * agent shutdown (emit = "agent_shutdown").
   */
  closeAll(reason: LogStreamEndReason | null): void {
    if (this.streams.size === 0) return;
    log.info(`closing ${this.streams.size} stream(s) reason=${reason ?? "none"}`);
    for (const active of Array.from(this.streams.values())) {
      if (reason !== null) {
        this.emitEnd(active, reason);
      } else {
        active.emitEnd = false;
      }
      this.terminate(active);
    }
  }

  private attach(active: ActiveStream): void {
    const { dockerStream } = active;

    dockerStream.on("data", (chunk: Buffer) => {
      this.handleData(active, chunk);
    });
    dockerStream.on("error", (err: Error) => {
      log.warn(`stream ${active.streamId} error: ${err.message}`);
      if (active.ended) return;
      this.emitEnd(active, "stream_error", err.message);
      this.terminate(active);
    });
    dockerStream.on("end", () => {
      if (active.ended) return;
      // dockerode closes the follow stream when the container exits or is
      // removed. Distinguishing the two requires an inspect, which we skip —
      // backend can resolve via container_events that arrive in parallel.
      this.emitEnd(active, "container_stopped");
      this.terminate(active);
    });
    dockerStream.on("close", () => {
      if (active.ended) return;
      this.emitEnd(active, "container_stopped");
      this.terminate(active);
    });
  }

  private handleData(active: ActiveStream, chunk: Buffer): void {
    const frames = active.parser.push(chunk);
    for (const frame of frames) {
      const lines = active.lineBuffer.feed(frame.type, frame.text);
      if (lines.stdout.length > 0) {
        active.batcher.add("stdout", lines.stdout);
      }
      if (lines.stderr.length > 0) {
        active.batcher.add("stderr", lines.stderr);
      }
    }
  }

  private emitEnd(
    active: ActiveStream,
    reason: LogStreamEndReason,
    error?: string,
  ): void {
    if (!active.emitEnd) return;
    active.batcher.flushNow();
    const msg: LogStreamEndMessage = {
      type: "log_stream_end",
      streamId: active.streamId,
      reason,
    };
    if (error !== undefined) msg.error = error;
    try {
      this.send(msg);
    } catch (err) {
      log.warn(`failed to emit log_stream_end ${active.streamId}: ${(err as Error).message}`);
    }
  }

  private terminate(active: ActiveStream): void {
    if (active.ended) return;
    active.ended = true;
    log.info(`terminate streamId=${active.streamId} container=${active.containerId}`);
    active.batcher.dispose();
    try {
      active.dockerStream.removeAllListeners("data");
      active.dockerStream.removeAllListeners("error");
      active.dockerStream.removeAllListeners("end");
      active.dockerStream.removeAllListeners("close");
      (
        active.dockerStream as NodeJS.ReadableStream & { destroy?: () => void }
      ).destroy?.();
    } catch (err) {
      log.debug(`destroy error ${active.streamId}: ${(err as Error).message}`);
    }
    this.streams.delete(active.streamId);
  }
}

// ---- Docker frame parser (8-byte header demux) ----
//
// Each frame: [stream_type(1)][0][0][0][size(4 BE)][payload(size)]. stream_type
// 1=stdout, 2=stderr. follow=true delivers frames mid-stream so the parser
// must tolerate split chunks (header straddling a chunk boundary, payload
// shorter than declared size, etc.).

interface ParsedFrame {
  type: 1 | 2;
  text: string;
}

class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private header: { type: 1 | 2; size: number } | null = null;

  push(chunk: Buffer): ParsedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: ParsedFrame[] = [];

    while (true) {
      if (!this.header) {
        if (this.buf.length < 8) break;
        const type = this.buf[0];
        const size = this.buf.readUInt32BE(4);
        if (type !== 1 && type !== 2) {
          // Non-demuxed stream (e.g. tty=true container). Treat the entire
          // buffered content as stdout text and reset.
          out.push({ type: 1, text: this.buf.toString("utf-8") });
          this.buf = Buffer.alloc(0);
          break;
        }
        this.header = { type: type as 1 | 2, size };
        this.buf = this.buf.subarray(8);
      }
      if (this.buf.length < this.header.size) break;
      const payload = this.buf.subarray(0, this.header.size);
      out.push({ type: this.header.type, text: payload.toString("utf-8") });
      this.buf = this.buf.subarray(this.header.size);
      this.header = null;
    }
    return out;
  }
}

// Frames may carry partial lines; buffer per-stream until a newline arrives.
class LineBuffer {
  private stdoutBuf = "";
  private stderrBuf = "";

  feed(type: 1 | 2, text: string): { stdout: string[]; stderr: string[] } {
    if (type === 1) {
      const lines = this.consume("stdout", this.stdoutBuf + text);
      this.stdoutBuf = lines.remainder;
      return { stdout: lines.complete, stderr: [] };
    }
    const lines = this.consume("stderr", this.stderrBuf + text);
    this.stderrBuf = lines.remainder;
    return { stdout: [], stderr: lines.complete };
  }

  private consume(_label: string, combined: string): { complete: string[]; remainder: string } {
    const lastNl = combined.lastIndexOf("\n");
    if (lastNl < 0) {
      return { complete: [], remainder: combined };
    }
    const completeText = combined.slice(0, lastNl);
    const remainder = combined.slice(lastNl + 1);
    const lines = completeText.split("\n").filter((line) => line.length > 0);
    return { complete: lines, remainder };
  }
}

// 200ms window or 50-line threshold, whichever first. stdout/stderr are
// accumulated separately and emitted as separate chunks per spec.
class LineBatcher {
  private stdout: string[] = [];
  private stderr: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly streamId: string,
    private readonly send: (msg: LogChunkMessage) => void,
  ) {}

  add(source: "stdout" | "stderr", lines: string[]): void {
    if (this.disposed || lines.length === 0) return;
    if (source === "stdout") this.stdout.push(...lines);
    else this.stderr.push(...lines);

    if (this.totalLines() >= BATCH_LINE_THRESHOLD) {
      this.flushNow();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flushNow(), BATCH_WINDOW_MS);
    }
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stdout.length > 0) {
      this.emit("stdout", this.stdout);
      this.stdout = [];
    }
    if (this.stderr.length > 0) {
      this.emit("stderr", this.stderr);
      this.stderr = [];
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stdout = [];
    this.stderr = [];
  }

  private totalLines(): number {
    return this.stdout.length + this.stderr.length;
  }

  private emit(source: LogStreamSource, lines: string[]): void {
    const msg: LogChunkMessage = {
      type: "log_chunk",
      streamId: this.streamId,
      stream: source,
      lines,
    };
    try {
      this.send(msg);
    } catch (err) {
      log.warn(`log_chunk send failed ${this.streamId}: ${(err as Error).message}`);
    }
  }
}

function clampTail(value: number | undefined): number {
  if (value === undefined || value === null) return 100;
  if (!Number.isFinite(value) || value < 0) return 100;
  if (value === 0) return 0;
  return Math.floor(value);
}

// dockerode passes `since` straight to Docker which accepts unix seconds or
// RFC3339 timestamps. ISO8601 inputs pass through; relative shorthand
// ("5m", "1h", "30s") is converted to absolute ISO8601 here so callers don't
// need a clock on their side.
function resolveSince(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = value.match(RELATIVE_SINCE_PATTERN);
  if (!m) return value;
  const num = parseInt(m[1], 10);
  const unit = m[2];
  const ms = num * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  return new Date(Date.now() - ms).toISOString();
}
