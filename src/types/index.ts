// --- App Config ---

export interface AppConfig {
  backendUrl: string;
  backendApiUrl: string;
  agentHostname: string;
  collectInterval: number;
  dockerSocket: string;
  advertiseIp: string | null;
  hostProcPath: string;
  dcgmExporterUrl: string | null;
  gpuPerContainerEnabled: boolean;
  modelCacheRoot: string;
  workspaceQuota: WorkspaceQuotaConfig;
}

export interface WorkspaceQuotaConfig {
  enabled: boolean;
  mountRoot: string;
}

// --- System Metrics ---

export interface CpuInfo {
  model: string;
  sockets: number;
  cores: number;
  threads: number;
  isHybrid: boolean;
  performanceCores: number;
  efficiencyCores: number;
  usage: number;
  perCore: number[];
  // 1-minute load average. Linux only.
  loadAvg1m?: number;
}

export interface MemoryInfo {
  total: number;
  available: number;
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

export interface WorkspaceQuotaInfo {
  available: boolean;
  mountPath: string | null;
  totalGb: number | null;
  freeGb: number | null;
  hardEnforced: boolean;
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

export interface GpuMetric {
  index: number;
  vendor: string;
  model: string;
  memoryTotal: number;
  memoryUsed: number;
  memoryPercent?: number;
  usage: number;
  temperature?: number;
}

export interface SystemMetrics {
  hostname: string;
  os: string;
  uptime: number;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  workspaceQuota?: WorkspaceQuotaInfo;
  network: NetworkInfo;
  docker: DockerSummary;
  processes: ProcessesSummary;
  logins: LoginsSummary;
  gpu: GpuMetric[];
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
  name: string;
  image: string;
  state: string;
  cpu: {
    usage: number;
    cores: number;
    usage_pct: number | null;
    cores_quota: number | null;
  };
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  disk: { read: number; write: number };
  workspace?: WorkspaceUsage;
  network_stats: ContainerNetworkStat[];
  gpu?: GpuPerContainer;
}

export interface WorkspaceUsage {
  path: string;
  projectId: number;
  hardGb: number;
  usedGb: number;
  availableGb: number;
  usedPct: number;
}

export interface GpuPerContainer {
  usage: number | null;
  memoryUsed: number;
  memoryTotal: number;
  indices: string[];
  source: GpuPerContainerSource;
}

export type GpuPerContainerSource =
  | "pmon"
  | "dcgm-mig"
  | "host-util-solo"
  | "vram-only";

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

// --- Container Lifecycle Events ---

export type ContainerEventKind =
  | "start"
  | "stop"
  | "die"
  | "restart"
  | "pause"
  | "unpause"
  | "kill"
  | "oom"
  | "health_status";

export type ContainerHealthStatus = "healthy" | "unhealthy" | "starting";

export interface ContainerEvent {
  containerId: string;
  name?: string;
  ts: string;
  kind: ContainerEventKind;
  exitCode?: number;
  signal?: string;
  healthStatus?: ContainerHealthStatus;
}

// --- WebSocket Messages ---

export type WsMessageType =
  | "system_metrics"
  | "capacity_report"
  | "containers"
  | "container_metrics"
  | "container_events"
  | "command_response"
  | "log_chunk"
  | "log_stream_end"
  | "exec_chunk"
  | "exec_end";

export interface WsEnvelopedMessage {
  type:
    | "system_metrics"
    | "containers"
    | "container_metrics"
    | "container_events";
  data: Record<string, unknown>;
  timestamp: string;
}

export interface CapacityReportMessage {
  type: "capacity_report";
  agentId: string;
  timestamp: string;
  data: CapacityReportData;
}

export interface CapacityReportData {
  cpu: {
    cores: number;
    model: string | null;
    architecture: string;
  };
  memory: {
    totalMb: number;
  };
  disk: {
    rootTotalGb: number | null;
    rootUsedGb: number | null;
    filesystem: string | null;
    workspaceQuota: WorkspaceQuotaInfo;
  };
  network: {
    primaryInterface: string | null;
    speedMbps: number | null;
  };
  gpu: {
    count: number;
    devices: Array<{
      index: number;
      model: string;
      memoryMb: number;
      migEnabled: boolean;
    }>;
  };
  os: {
    distro: string | null;
    kernel: string;
    cgroupVersion: "v1" | "v2" | "unknown";
  };
  agent: {
    version: string;
    nodeVersion: string;
  };
}

export type LogStreamSource = "stdout" | "stderr" | "mixed";

export interface LogChunkMessage {
  type: "log_chunk";
  streamId: string;
  stream: LogStreamSource;
  lines: string[];
}

export type LogStreamEndReason =
  | "container_stopped"
  | "container_removed"
  | "stream_error"
  | "agent_shutdown";

export interface LogStreamEndMessage {
  type: "log_stream_end";
  streamId: string;
  reason: LogStreamEndReason;
  error?: string;
}

export type ExecChunkSource = "stdout" | "stderr";

export interface ExecChunkMessage {
  type: "exec_chunk";
  execId: string;
  stream: ExecChunkSource;
  data: string;
}

export type ExecEndReason =
  | "natural"
  | "kill"
  | "container_stopped"
  | "error"
  | "browser_disconnect";

export interface ExecEndMessage {
  type: "exec_end";
  execId: string;
  exitCode: number | null;
  reason: ExecEndReason;
  error?: string;
}

export type WsMessage =
  | WsEnvelopedMessage
  | CapacityReportMessage
  | LogChunkMessage
  | LogStreamEndMessage
  | ExecChunkMessage
  | ExecEndMessage;

// --- Commands (Backend -> Agent) ---

export type CommandName =
  | "get_logs"
  | "inspect"
  | "image_inspect"
  | "control"
  | "system_info"
  | "request_capacity"
  | "create_container"
  | "prepare_model_assets"
  | "delete_container"
  | "compose_up"
  | "compose_down"
  | "logs_subscribe"
  | "logs_unsubscribe"
  | "container_processes"
  | "exec_open"
  | "exec_input"
  | "exec_resize"
  | "exec_close";

export type ProgressStep =
  | "pulling_image"
  | "creating"
  | "starting"
  | "running_check"
  | "preparing_model_assets"
  | "verifying_model_assets";

export interface CommandProgress {
  type: "command_progress";
  requestId: string;
  step: ProgressStep;
  phase?: string;
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
  | "users"
  | "users_history"
  | "capabilities"
  | "gpu_inventory";

// --- Agent Registration ---

export type AgentStatus = "pending" | "approved" | "rejected";

export interface AgentRegistration {
  id: string;
  hostname: string;
  ip_address: string;
  status: AgentStatus;
  token: string | null;
}
