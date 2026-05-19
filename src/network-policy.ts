export const INTERNAL_NETWORK_NAME = "hc-ml-internal";
export const SUPPORTED_NETWORK_POLICIES = ["none", "internal_only", "host"] as const;

export type NetworkPolicy = (typeof SUPPORTED_NETWORK_POLICIES)[number];

const SUPPORTED_NETWORK_POLICY_SET = new Set<string>(SUPPORTED_NETWORK_POLICIES);

export function supportedNetworkPolicyMessage(): string {
  return `supported: ${SUPPORTED_NETWORK_POLICIES.join(", ")}`;
}

export function normalizeNetworkPolicy(value: unknown): NetworkPolicy {
  if (value === undefined || value === null) return "none";
  if (typeof value !== "string") {
    throw new Error(`networkPolicy must be a string. ${supportedNetworkPolicyMessage()}`);
  }

  const normalized = value.trim();
  if (!normalized) return "none";
  if (SUPPORTED_NETWORK_POLICY_SET.has(normalized)) return normalized as NetworkPolicy;

  throw new Error(
    `networkPolicy ${normalized} is not supported by this agent. ${supportedNetworkPolicyMessage()}`,
  );
}
