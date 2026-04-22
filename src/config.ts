import os from "node:os";
import { readFileSync } from "node:fs";
import type { AppConfig } from "./types/index.js";

export function loadConfig(): AppConfig {
  const backendUrl = requireEnv("BACKEND_URL");
  const backendApiUrl = requireEnv("BACKEND_API_URL");

  const collectInterval = parseInt(process.env.COLLECT_INTERVAL ?? "2000", 10);
  if (Number.isNaN(collectInterval) || collectInterval < 500) {
    throw new Error("COLLECT_INTERVAL must be a number >= 500");
  }

  return {
    backendUrl,
    backendApiUrl,
    agentHostname: process.env.AGENT_HOSTNAME || readHostHostname() || os.hostname(),
    collectInterval,
    dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    // Optional override sent in registration payload as ip_address. Only
    // useful in environments where the backend cannot infer the agent's
    // real IP from the TCP peer address (Docker Desktop on Windows/Mac,
    // VPN, NAT). Empty/unset = omit the field and let the backend record
    // whatever it observes.
    advertiseIp:
      process.env.AGENT_ADVERTISE_IP?.trim() ||
      process.env.HOST_IP?.trim() ||
      null,
  };
}

function readHostHostname(): string | null {
  try {
    return readFileSync("/host/etc/hostname", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
