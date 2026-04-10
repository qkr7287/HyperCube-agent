// --- App Config ---

export interface AppConfig {
  backendUrl: string;
  backendApiUrl: string;
  agentHostname: string;
  collectInterval: number;
  dockerSocket: string;
}

// --- System Metrics ---

export interface CpuInfo {
  cores: number;
  model: string;
  usage: number;
  perCore: number[];
}

export interface MemoryInfo {
  total: number;
  used: number;
  free: number;
  usage: number;
}

export interface DiskInfo {
  total: number;
  used: number;
  free: number;
  usage: number;
}

export interface NetworkInfo {
  interfaces: string[];
  connections: number;
  rx: number;
  tx: number;
}

export interface DockerSummary {
  version: string;
  containers: number;
  images: number;
}

export interface SystemMetrics {
  hostname: string;
  os: string;
  uptime: number;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  network: NetworkInfo;
  docker: DockerSummary;
}

// --- Container ---

export interface PortBinding {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: PortBinding[];
  created: number;
}

export interface ContainerMetrics {
  containerId: string;
  cpu: { usage: number; cores: number };
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  disk: { read: number; write: number };
}

// --- WebSocket Messages ---

export type WsMessageType =
  | "system_metrics"
  | "containers"
  | "container_metrics"
  | "command_response";

export interface WsMessage {
  type: WsMessageType;
  data: Record<string, unknown>;
  timestamp: string;
}

// --- Commands (Backend → Agent) ---

export type CommandName = "get_logs" | "inspect" | "control" | "system_info";

export interface CommandRequest {
  type: "command";
  requestId: string;
  command: CommandName;
  params: Record<string, unknown>;
}

export interface CommandResponse {
  type: "command_response";
  requestId: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export type ContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "unpause"
  | "kill"
  | "remove";

export type SystemInfoSubCommand =
  | "cpu_detail"
  | "processes"
  | "network_detail"
  | "users";

// --- Agent Registration ---

export type AgentStatus = "pending" | "approved" | "rejected";

export interface AgentRegistration {
  id: string;
  hostname: string;
  ip_address: string;
  status: AgentStatus;
  token: string | null;
}
