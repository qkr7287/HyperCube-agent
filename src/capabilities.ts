import { INTERNAL_NETWORK_NAME, SUPPORTED_NETWORK_POLICIES } from "./network-policy.js";

export const AGENT_CAPABILITIES = {
  gpuInventory: true,
  createContainerGpu: true,
  imageInspect: true,
  workspaceBaseUrl: true,
  prepareModelAssets: true,
  networkPolicyInternalOnly: true,
  networkPolicyHost: true,
  networkPolicyNotEnforced: false,
} as const;

export function getAgentCapabilities(): Record<string, unknown> {
  return {
    capabilities: AGENT_CAPABILITIES,
    mlWorkspace: {
      version: 1,
      supported: true,
      networkPolicy: "enforced",
      supportedNetworkPolicies: SUPPORTED_NETWORK_POLICIES,
      internalNetworkName: INTERNAL_NETWORK_NAME,
    },
  };
}
