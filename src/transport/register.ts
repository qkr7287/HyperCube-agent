import { createLogger } from "../logger.js";
import type { AppConfig, AgentRegistration } from "../types/index.js";

const REGISTER_RETRY_INTERVAL = 30_000;
const log = createLogger("register");

export async function registerAgent(
  config: AppConfig,
): Promise<AgentRegistration> {
  const url = `${config.backendApiUrl}/api/agents/`;
  // ip_address policy:
  //   - bridge mode: os.networkInterfaces() returns docker-internal IPs,
  //     so we never trust them.
  //   - Linux host network mode: host NICs are visible, but the backend's
  //     TCP peer address is already accurate enough — no need to send.
  //   - Docker Desktop (Windows/Mac), VPN, special NAT: backend can't
  //     infer the real IP. Set AGENT_ADVERTISE_IP (or HOST_IP) to override.
  // Default: omit the field and let the backend record observed peer IP.
  const body: { hostname: string; ip_address?: string } = {
    hostname: config.agentHostname,
  };
  if (config.advertiseIp) {
    body.ip_address = config.advertiseIp;
  }

  while (true) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = (await res.json()) as { data: AgentRegistration };
        log.info(`Agent registered: ${json.data.id} (${json.data.status})`);
        return json.data;
      }

      // already registered (409 or unique constraint)
      if (res.status === 409) {
        const json = (await res.json()) as { data: AgentRegistration };
        log.info(`Agent already registered: ${json.data.id}`);
        return json.data;
      }

      // auth required — backend not yet configured for AllowAny
      if (res.status === 401 || res.status === 403) {
        log.warn(
          `Backend returned ${res.status}. Ensure Agent registration API allows unauthenticated access. Retrying in ${REGISTER_RETRY_INTERVAL / 1000}s...`,
        );
        await sleep(REGISTER_RETRY_INTERVAL);
        continue;
      }

      log.error(`Unexpected response: ${res.status} ${res.statusText}`);
      await sleep(REGISTER_RETRY_INTERVAL);
    } catch (err) {
      log.error(`Connection failed: ${(err as Error).message}. Retrying in ${REGISTER_RETRY_INTERVAL / 1000}s...`);
      await sleep(REGISTER_RETRY_INTERVAL);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
