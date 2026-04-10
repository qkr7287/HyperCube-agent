import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("handler:logs");

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
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    since: since ?? undefined,
    timestamps,
    follow: false,
  });

  const lines = stripDockerHeaders(buffer);

  return { containerId, lines };
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
