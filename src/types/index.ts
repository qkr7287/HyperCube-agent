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

export interface ProcessesSummary {
  total: number;
  running: number;
}

export interface LoginsSummary {
  total: number;
  active: number;
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
  processes: ProcessesSummary;
  logins: LoginsSummary;
}

// --- Container ---

export interface PortBinding {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface ContainerMount {
  name: string;
  type: "volume";
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: PortBinding[];
  created: number;
  labels: Record<string, string>;
  networks?: string[];
  mounts?: ContainerMount[];
}

export interface ContainerMetrics {
  containerId: string;
  cpu: { usage: number; cores: number };
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  disk: { read: number; write: number };
  network_stats: ContainerNetworkStat[];
}

export type NetworkMappingMode =
  | "exact"
  | "single-network-fallback"
  | "unresolved";

export interface ContainerNetworkStat {
  network_name: string | null;
  interface_name: string | null;
  mapping_mode: NetworkMappingMode;
  rx_bytes: number;
  tx_bytes: number;
  rx_rate_bps: number | null;
  tx_rate_bps: number | null;
  rx_packets: number | null;
  tx_packets: number | null;
  errors_rx: number | null;
  errors_tx: number | null;
  timestamp: string | null;
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

export type CommandName =
  | "get_logs"
  | "inspect"
  | "control"
  | "system_info"
  | "create_container"
  | "delete_container"
  | "compose_up"
  | "compose_down";

export type ProgressStep =
  | "pulling_image"
  | "creating"
  | "starting"
  | "running_check";

export interface CommandProgress {
  type: "command_progress";
  requestId: string;
  step: ProgressStep;
  percent: number | null;
  message: string;
  context?: Record<string, unknown>;
}

export type ProgressEmitter = (progress: Omit<CommandProgress, "type" | "requestId">) => void;

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
