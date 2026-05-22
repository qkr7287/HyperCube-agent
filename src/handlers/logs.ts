import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("handler:logs");

// get_logs must answer well inside the backend's 15s command timeout even
// when dockerode's logs call hangs — daemon never closing the response,
// a stream stuck mid-frame, etc. Cap the docker call below that bound so the
// dispatcher can still turn a stall into an error envelope in time.
const LOGS_TIMEOUT_MS = 12_000;

interface GetLogsParams {
  containerId: string;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}

export async function handleGetLogs(
  docker: Dockerode,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { containerId, tail = 100, since, timestamps = false } =
    params as unknown as GetLogsParams;

  if (!containerId) {
    throw new Error("containerId is required");
  }

  log.info(`Fetching logs for ${containerId} (tail: ${tail})`);

  const container = docker.getContainer(containerId);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LOGS_TIMEOUT_MS);

  try {
    // follow:false → dockerode resolves the whole log dump as a Buffer.
    // abortSignal cancels the underlying HTTP request if the daemon stalls,
    // so a hang reaches us as a rejection instead of a leaked pending socket.
    const result = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      since: since ?? undefined,
      timestamps,
      follow: false,
      abortSignal: ac.signal,
    } as Parameters<typeof container.logs>[0]);

    // Defensive: a non-follow call should yield a Buffer, but guard against
    // dockerode/daemon combinations that hand back a stream instead — those
    // are exactly the case that used to hang silently.
    const buffer = Buffer.isBuffer(result)
      ? result
      : await collectStream(
          result as unknown as NodeJS.ReadableStream,
          ac.signal,
        );

    const lines = stripDockerHeaders(buffer);
    return { containerId, lines };
  } catch (err) {
    if (ac.signal.aborted) {
      throw new Error(
        `get_logs timed out after ${LOGS_TIMEOUT_MS}ms for ${containerId}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain a readable stream into one Buffer, bailing out the moment the shared
 * abort signal fires so a stalled stream can't hang the handler.
 */
function collectStream(
  stream: NodeJS.ReadableStream,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
    };
    const onAbort = () => {
      cleanup();
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      reject(new Error("aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort);

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * Docker multiplexed stream format:
 * Each frame has an 8-byte header: [stream_type(1), 0, 0, 0, size(4)]
 * stream_type: 1=stdout, 2=stderr
 */
function stripDockerHeaders(buffer: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > buffer.length) break;

    const line = buffer.subarray(offset, offset + size).toString("utf-8").trimEnd();
    if (line) lines.push(line);
    offset += size;
  }

  // fallback: if no valid headers found, treat as plain text
  if (lines.length === 0 && buffer.length > 0) {
    return buffer.toString("utf-8").split("\n").filter(Boolean);
  }

  return lines;
}
