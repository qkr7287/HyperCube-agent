import os from "node:os";
import type { AppConfig, AgentRegistration } from "../types/index.js";

const POLL_INTERVAL = 10_000;
const REGISTER_RETRY_INTERVAL = 30_000;

export async function registerAgent(
  config: AppConfig,
): Promise<AgentRegistration> {
  const url = `${config.backendApiUrl}/api/agents/`;
  const body = {
    hostname: config.agentHostname,
    ip_address: getLocalIp(),
  };

  while (true) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = (await res.json()) as { data: AgentRegistration };
        console.log(`[register] Agent registered: ${json.data.id} (${json.data.status})`);
        return json.data;
      }

      // already registered (409 or unique constraint)
      if (res.status === 409) {
        const json = (await res.json()) as { data: AgentRegistration };
        console.log(`[register] Agent already registered: ${json.data.id}`);
        return json.data;
      }

      // auth required — backend not yet configured for AllowAny
      if (res.status === 401 || res.status === 403) {
        console.warn(
          `[register] Backend returned ${res.status}. Ensure Agent registration API allows unauthenticated access. Retrying in ${REGISTER_RETRY_INTERVAL / 1000}s...`,
        );
        await sleep(REGISTER_RETRY_INTERVAL);
        continue;
      }

      console.error(`[register] Unexpected response: ${res.status} ${res.statusText}`);
      await sleep(REGISTER_RETRY_INTERVAL);
    } catch (err) {
      console.error(`[register] Connection failed: ${(err as Error).message}. Retrying in ${REGISTER_RETRY_INTERVAL / 1000}s...`);
      await sleep(REGISTER_RETRY_INTERVAL);
    }
  }
}

export async function pollApproval(
  config: AppConfig,
  agentId: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${config.backendApiUrl}/api/agents/${agentId}/status/`;

  console.log("[register] Waiting for admin approval...");

  while (!signal?.aborted) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        console.warn(`[register] Status check failed: ${res.status}. Retrying...`);
        await sleep(POLL_INTERVAL);
        continue;
      }

      const json = (await res.json()) as { data: AgentRegistration };
      const agent = json.data;

      if (agent.status === "approved" && agent.token) {
        console.log("[register] Agent approved. Token received.");
        return agent.token;
      }

      if (agent.status === "rejected") {
        throw new Error("Agent registration was rejected by admin.");
      }

      // still pending
      await sleep(POLL_INTERVAL);
    } catch (err) {
      if (signal?.aborted) break;
      console.error(`[register] Poll error: ${(err as Error).message}. Retrying...`);
      await sleep(POLL_INTERVAL);
    }
  }

  throw new Error("Approval polling aborted.");
}

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const ifaceList of Object.values(interfaces)) {
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (!iface.internal && iface.family === "IPv4") {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
