import type Dockerode from "dockerode";
import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import { createLogger } from "../logger.js";
import type {
  ExecChunkMessage,
  ExecChunkSource,
  ExecEndMessage,
  ExecEndReason,
  WsMessage,
} from "../types/index.js";

const log = createLogger("exec");

const BATCH_WINDOW_MS = 50;
const BATCH_BYTE_THRESHOLD = 64 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 500;
const MAX_ROWS = 200;

interface OpenParams {
  containerId?: string;
  cmd?: string[];
  user?: string;
  tty?: boolean;
  env?: string[];
  cols?: number;
  rows?: number;
}

interface OpenResult {
  success: boolean;
  data?: { execId: string; ready: true };
  error?: string;
}

interface InputResult {
  success: boolean;
  data?: { execId: string; wrote: number };
  error?: string;
}

interface ResizeResult {
  success: boolean;
  data?: { execId: string; resized: true };
  error?: string;
}

interface CloseResult {
  success: boolean;
  data?: { execId: string; closed: true };
  error?: string;
}

type Sender = (msg: WsMessage) => void;

interface ActiveExec {
  execId: string;
  containerId: string;
  exec: Dockerode.Exec;
  stream: Duplex;
  tty: boolean;
  batcher: ChunkBatcher;
  ended: boolean;
  emitEnd: boolean;
  openedAt: number;
}

export class ExecRegistry {
  private execs = new Map<string, ActiveExec>();

  constructor(private readonly send: Sender) {}

  async start(
    docker: Dockerode,
    execId: string,
    rawParams: Record<string, unknown>,
  ): Promise<OpenResult> {
    const params = rawParams as OpenParams;
    const containerId = params.containerId;
    if (!containerId) {
      return { success: false, error: "containerId is required" };
    }

    if (this.execs.has(execId)) {
      // Backend uses unique requestIds; collision is a programmer error.
      return { success: false, error: `execId already active: ${execId}` };
    }

    const cmd = Array.isArray(params.cmd) && params.cmd.length > 0 ? params.cmd : ["/bin/sh"];
    const tty = params.tty ?? true;
    const cols = clampCols(params.cols);
    const rows = clampRows(params.rows);

    const container = docker.getContainer(containerId);

    let inspectInfo: Dockerode.ContainerInspectInfo;
    try {
      inspectInfo = await container.inspect();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) {
        return { success: false, error: "container_not_found" };
      }
      return { success: false, error: (err as Error).message };
    }
    if (!inspectInfo.State?.Running) {
      return { success: false, error: "container_not_running" };
    }

    let exec: Dockerode.Exec;
    let stream: Duplex;
    try {
      exec = await container.exec({
        Cmd: cmd,
        User: params.user,
        Tty: tty,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Env: params.env,
      });
      stream = (await exec.start({ hijack: true, stdin: true, Tty: tty })) as Duplex;
    } catch (err) {
      const message = (err as Error).message;
      if (looksLikeMissingExecutable(message)) {
        return { success: false, error: "cmd_not_found" };
      }
      return { success: false, error: message };
    }

    const active: ActiveExec = {
      execId,
      containerId,
      exec,
      stream,
      tty,
      batcher: new ChunkBatcher(execId, (msg) => this.send(msg)),
      ended: false,
      emitEnd: true,
      openedAt: Date.now(),
    };
    this.execs.set(execId, active);
    this.attach(active, docker);

    // Initial resize. Some exec configs reject resize (non-TTY, container
    // exited mid-call); treat as non-fatal.
    try {
      await exec.resize({ h: rows, w: cols });
    } catch (err) {
      log.debug(`initial resize failed ${execId}: ${(err as Error).message}`);
    }

    log.info(
      `exec_open ${execId} container=${containerId} cmd=${cmd.join(" ")} tty=${tty} ${cols}x${rows}`,
    );
    return { success: true, data: { execId, ready: true } };
  }

  write(execId: string, base64Data: string): InputResult {
    const active = this.execs.get(execId);
    if (!active) {
      return { success: false, error: "unknown execId" };
    }
    const bytes = Buffer.from(base64Data, "base64");
    try {
      active.stream.write(bytes);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    return { success: true, data: { execId, wrote: bytes.length } };
  }

  async resize(execId: string, cols: number, rows: number): Promise<ResizeResult> {
    const active = this.execs.get(execId);
    if (!active) {
      return { success: false, error: "unknown execId" };
    }
    const w = clampCols(cols);
    const h = clampRows(rows);
    try {
      await active.exec.resize({ h, w });
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    return { success: true, data: { execId, resized: true } };
  }

  async stop(execId: string, reason: ExecEndReason): Promise<CloseResult> {
    const active = this.execs.get(execId);
    if (!active) {
      // Idempotent — close on an unknown execId is still a success.
      return { success: true, data: { execId, closed: true } };
    }
    await this.finalize(active, reason);
    return { success: true, data: { execId, closed: true } };
  }

  /**
   * Stop all exec sessions. reason=null suppresses exec_end emit (used on WS
   * disconnect — peer is gone). Otherwise the given reason is reported.
   */
  async closeAll(reason: ExecEndReason | null): Promise<void> {
    if (this.execs.size === 0) return;
    log.info(`closing ${this.execs.size} exec(s) reason=${reason ?? "silent"}`);
    const all = Array.from(this.execs.values());
    for (const active of all) {
      if (reason === null) {
        active.emitEnd = false;
        await this.finalize(active, "browser_disconnect");
      } else {
        await this.finalize(active, reason);
      }
    }
  }

  private attach(active: ActiveExec, docker: Dockerode): void {
    if (active.tty) {
      active.stream.on("data", (chunk: Buffer) => {
        active.batcher.add("stdout", chunk);
      });
    } else {
      const stdoutPipe = new PassThrough();
      const stderrPipe = new PassThrough();
      docker.modem.demuxStream(active.stream, stdoutPipe, stderrPipe);
      stdoutPipe.on("data", (chunk: Buffer) => active.batcher.add("stdout", chunk));
      stderrPipe.on("data", (chunk: Buffer) => active.batcher.add("stderr", chunk));
    }

    active.stream.on("error", (err: Error) => {
      if (active.ended) return;
      log.warn(`exec ${active.execId} stream error: ${err.message}`);
      void this.finalize(active, "error", err.message);
    });
    active.stream.on("end", () => {
      if (active.ended) return;
      void this.finalize(active, "natural");
    });
    active.stream.on("close", () => {
      if (active.ended) return;
      void this.finalize(active, "natural");
    });
  }

  private async finalize(
    active: ActiveExec,
    reason: ExecEndReason,
    error?: string,
  ): Promise<void> {
    if (active.ended) return;
    active.ended = true;
    active.batcher.flushNow();

    let exitCode: number | null = null;
    try {
      const info = await active.exec.inspect();
      exitCode = typeof info.ExitCode === "number" ? info.ExitCode : null;
    } catch (err) {
      log.debug(`exec.inspect failed ${active.execId}: ${(err as Error).message}`);
    }

    if (active.emitEnd) {
      const msg: ExecEndMessage = {
        type: "exec_end",
        execId: active.execId,
        exitCode,
        reason,
      };
      if (error !== undefined) msg.error = error;
      try {
        this.send(msg);
      } catch (err) {
        log.warn(`failed to emit exec_end ${active.execId}: ${(err as Error).message}`);
      }
    }

    active.batcher.dispose();
    try {
      active.stream.removeAllListeners();
      active.stream.destroy();
    } catch (err) {
      log.debug(`destroy error ${active.execId}: ${(err as Error).message}`);
    }
    this.execs.delete(active.execId);
    log.info(
      `exec_end ${active.execId} container=${active.containerId} reason=${reason} exit=${exitCode}`,
    );
  }
}

class ChunkBatcher {
  private stdout: Buffer[] = [];
  private stderr: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly execId: string,
    private readonly send: (msg: ExecChunkMessage) => void,
  ) {}

  add(source: ExecChunkSource, chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return;
    if (source === "stdout") {
      this.stdout.push(chunk);
      this.stdoutBytes += chunk.length;
    } else {
      this.stderr.push(chunk);
      this.stderrBytes += chunk.length;
    }
    if (this.stdoutBytes + this.stderrBytes >= BATCH_BYTE_THRESHOLD) {
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
    if (this.stdoutBytes > 0) {
      this.emit("stdout", Buffer.concat(this.stdout, this.stdoutBytes));
      this.stdout = [];
      this.stdoutBytes = 0;
    }
    if (this.stderrBytes > 0) {
      this.emit("stderr", Buffer.concat(this.stderr, this.stderrBytes));
      this.stderr = [];
      this.stderrBytes = 0;
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
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
  }

  private emit(source: ExecChunkSource, buf: Buffer): void {
    const msg: ExecChunkMessage = {
      type: "exec_chunk",
      execId: this.execId,
      stream: source,
      data: buf.toString("base64"),
    };
    try {
      this.send(msg);
    } catch (err) {
      log.warn(`exec_chunk send failed ${this.execId}: ${(err as Error).message}`);
    }
  }
}

function clampCols(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COLS;
  if (value < 1) return 1;
  if (value > MAX_COLS) return MAX_COLS;
  return Math.floor(value);
}

function clampRows(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ROWS;
  if (value < 1) return 1;
  if (value > MAX_ROWS) return MAX_ROWS;
  return Math.floor(value);
}

// dockerode surfaces the runtime's "command not found" via the start() error
// rather than a structured code. Match the common phrasings emitted by
// containerd / runc / Docker daemon.
function looksLikeMissingExecutable(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("executable file not found") ||
    lower.includes("no such file or directory") ||
    lower.includes("starting container process") &&
      (lower.includes("not found") || lower.includes("no such"))
  );
}
