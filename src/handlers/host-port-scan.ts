import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import type { AppConfig } from "../types/index.js";

const log = createLogger("handler:host-port-scan");

// TCP_LISTEN state code in /proc/net/tcp{,6} (column `st`, hex).
const TCP_LISTEN = "0A";

interface HostPort {
  port: number;
  proto: "tcp";
}

// Reports the host's TCP LISTEN ports so the backend can render accurate
// used-ports (coverage=full) instead of only the ports HyperCube itself
// published. Reads /proc/net/tcp{,6} directly — no `ss`/`netstat` dependency.
// The agent runs with network_mode: host, so these files reflect the host's
// network namespace.
export async function handleHostPortScan(
  config: AppConfig,
): Promise<Record<string, unknown>> {
  const procRoot = config.hostProcPath;
  const ports = new Set<number>();

  for (const relPath of ["net/tcp", "net/tcp6"]) {
    const filePath = path.join(procRoot, relPath);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      // tcp6 is absent when IPv6 is disabled — skip quietly.
      log.debug(`skipping ${filePath}: ${(err as Error).message}`);
      continue;
    }
    for (const port of parseListeningPorts(content)) {
      ports.add(port);
    }
  }

  const sorted: HostPort[] = [...ports]
    .sort((a, b) => a - b)
    .map((port) => ({ port, proto: "tcp" }));
  return { ports: sorted };
}

// Each /proc/net/tcp line: `sl local_address rem_address st ...`.
// local_address is `HEXIP:HEXPORT`; we keep rows in TCP_LISTEN state.
function parseListeningPorts(content: string): number[] {
  const out: number[] = [];
  const lines = content.split("\n").slice(1); // drop the header row
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (cols[3] !== TCP_LISTEN) continue;
    const portHex = cols[1].split(":")[1];
    if (!portHex) continue;
    const port = parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      out.push(port);
    }
  }
  return out;
}
