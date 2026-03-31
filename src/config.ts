import os from "node:os";
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
    agentHostname: process.env.AGENT_HOSTNAME || os.hostname(),
    collectInterval,
    dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
