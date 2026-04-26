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
  // 1-minute load average. Linux only — POSIX semantics on macOS too but the
  // contract scopes this to Linux to avoid platform-specific interpretation.
  loadAvg1m?: number;
}

export interface MemoryInfo {
  total: number;
  // Bytes that programs can claim without swapping. On Linux this maps to
  // /proc/meminfo MemAvailable (excludes reclaimable buffer/cache from
  // "used"). Required by the payload contract — `total - free` overcounts
  // used memory by 30-50% on a healthy server.
  available: number;
  // total - available. NOT total - free.
  used: number;
  free: number;
  // (total - available) / total * 100.
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

export interface GpuMetric {
  index: number;
  vendor: string;
  model: string;
  memoryTotal: number;
  memoryUsed: number;
  // (memoryUsed / memoryTotal) * 100. Optional — omitted when memoryTotal=0
  // (fallback path on hosts where vram is unknown).
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
  // Container identity duplicated from the latest containers snapshot so the
  // backend can correlate metrics → container without joining against a
  // separate message stream. Trades a few bytes per cycle for not requiring
  // the consumer to maintain a containerId → metadata index.
  name: string;
  image: string;
  state: string;
  cpu: {
    usage: number;
    cores: number;
    // Normalized CPU% in [0, 100], computed as usage / cores_quota. null when
    // cores_quota cannot be determined (e.g. inspect failed). Frontends should
    // render null as "—" rather than 0 to avoid silently dropping the row.
    usage_pct: number | null;
    // Logical cores Docker allows the container to consume. Sourced from
    // HostConfig in priority order: NanoCpus (--cpus), CpuQuota/CpuPeriod,
    // CpusetCpus count, then host total. null when inspect failed.
    cores_quota: number | null;
  };
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  disk: { read: number; write: number };
  network_stats: ContainerNetworkStat[];
  gpu?: GpuPerContainer;
}

// Per-container GPU usage. memory_* in MiB (intentionally different unit than
// host-level GpuMetric which uses bytes — payload size and dashboard
// readability win out over consistency here).
//
// `usage` is nullable because NVIDIA blocks per-process SM% on GeForce/RTX
// consumer cards at the driver level — no agent (us, nvtop, dcgm-exporter)
// can recover it. null = "measurement unavailable". Frontends should render
// it as "—" rather than 0, otherwise sort-by-usage silently drops these
// containers to the bottom.
//
// `source` records which path produced the numbers so backend/UI can flag
// low-confidence rows:
//   "pmon"           — nvidia-smi pmon sm% per PID, summed by container.
//                      ±10-20%p sampling error. Works on data-center GPUs.
//   "dcgm-mig"       — DCGM exporter SM_ACTIVE for a MIG instance bound
//                      1:1 to the container. Hardware counter, most accurate.
//   "host-util-solo" — RTX consumer fallback: only one compute container
//                      occupies the GPU, so the host-level utilization IS
//                      that container's utilization. Exact, not an estimate.
//   "vram-only"      — RTX with multiple compute containers sharing one
//                      GPU. usage = null because the driver won't let us
//                      split the host utilization across PIDs.
export interface GpuPerContainer {
  usage: number | null;
  // Bytes (per agent-payload-contract.md). Renamed from memory_used (MiB) in
  // the contract bump — backend / frontend update concurrently.
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
  | "users"
  | "users_history";

// --- Agent Registration ---

export type AgentStatus = "pending" | "approved" | "rejected";

export interface AgentRegistration {
  id: string;
  hostname: string;
  ip_address: string;
  status: AgentStatus;
  token: string | null;
}
