// --- App Config ---

export interface AppConfig {
  backendUrl: string;
  backendApiUrl: string;
  agentHostname: string;
  collectInterval: number;
  dockerSocket: string;
  advertiseIp: string | null;
  hostProcPath: string;
  // Path to host /sys (or container view of it). RAPL (powercap) and
  // thermal_zone* live here. With privileged: true the container's own
  // /sys already exposes host hardware files; override with HOST_SYS_PATH
  // when running unprivileged with /sys bind-mounted elsewhere.
  hostSysPath: string;
  dcgmExporterUrl: string | null;
  gpuPerContainerEnabled: boolean;
  modelCacheRoot: string;
  workspaceQuota: WorkspaceQuotaConfig;
}

// --- Workspace Quota ---

export interface WorkspaceQuotaConfig {
  enabled: boolean;
  mountRoot: string;
}

export interface WorkspaceQuotaInfo {
  available: boolean;
  mountPath: string | null;
  totalGb: number | null;
  freeGb: number | null;
  hardEnforced: boolean;
}

export interface WorkspaceUsage {
  path: string;
  projectId: number;
  hardGb: number;
  usedGb: number;
  availableGb: number;
  usedPct: number;
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
  // RAPL package-domain average watts since the previous collection cycle.
  // Sum across all intel-rapl:N package domains. null when RAPL is missing
  // (non-Intel/AMD, virtualized, EPERM) or on the very first sample.
  // NEVER 0 for "unsupported" — 0 means a real 0W reading.
  packagePowerW?: number | null;
  // CPU package temperature in °C from /sys/class/thermal/. Prefers
  // x86_pkg_temp / coretemp / k10temp zones; falls back to the hottest
  // available zone. null when no thermal zone is exposed.
  tempC?: number | null;
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
  // Existing temperature field, °C — kept for backward compatibility.
  temperature?: number;
  // Level-2 burden-estimate fields. Always present with explicit null when
  // nvidia-smi returned [N/A] for this GPU, so backend can distinguish
  // "unsupported" from "actually 0".
  temperatureC?: number | null;
  powerDrawW?: number | null;
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
  // Writable layer size (SizeRw from listContainers size:true). Populated only
  // on size-capture cycles and held cached between; null when not yet measured.
  sizeRw?: number | null;
  sizeRootFs?: number | null;
  // Bind-mount source path for /workspace if any container mount targets it as
  // a host bind. null when /workspace lives in the overlay or a named volume.
  workspaceBindSource?: string | null;
}

// Per-container workspace storage usage. Composed from multiple sources, with
// `source` recording which one produced `usedGb`. Backend renders null fields
// as "—" rather than 0.
export interface ContainerWorkspaceUsage {
  usedGb: number | null;
  rwLayerGb: number | null;
  rootFsGb: number | null;
  path: string | null;
  projectId: number | null;
  source: "du" | "rw-layer" | "xfs-quota" | null;
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
  workspace?: ContainerWorkspaceUsage;
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

// Canonical streaming envelope used by metric/snapshot pushes.
export interface WsEnvelopedMessage {
  type:
    | "system_metrics"
    | "containers"
    | "container_metrics"
    | "container_events";
  data: Record<string, unknown>;
  timestamp: string;
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
  // base64-encoded raw bytes (binary safe; UTF-8, ANSI escape, Ctrl keys).
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
  // null for detach / TTY exits without a recoverable exit code.
  exitCode: number | null;
  reason: ExecEndReason;
  error?: string;
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

export type WsMessage =
  | WsEnvelopedMessage
  | CapacityReportMessage
  | LogChunkMessage
  | LogStreamEndMessage
  | ExecChunkMessage
  | ExecEndMessage;

// --- Commands (Backend → Agent) ---

export type CommandName =
  | "get_logs"
  | "inspect"
  | "image_inspect"
  | "control"
  | "system_info"
  | "request_capacity"
  | "create_container"
  | "update_container"
  | "prepare_model_assets"
  | "query_model_cache"
  | "host_port_scan"
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
  // Structured progress payload the backend persists directly (e.g.
  // `bytesDone` for ModelPrepareJob). Distinct from `context`, which is a
  // free-form bag for human-readable UI hints.
  data?: Record<string, unknown>;
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
