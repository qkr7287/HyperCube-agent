import type {
  SystemMetrics,
  ContainerInfo,
  ContainerMetrics,
} from "../types/index.js";

const CPU_THRESHOLD = 2;
const MEMORY_THRESHOLD = 1;
const DISK_THRESHOLD = 1;
const CONTAINER_CPU_THRESHOLD = 2;
const CONTAINER_NETWORK_RATE_THRESHOLD = 1;

export class DeltaEngine {
  private prevSystem: SystemMetrics | null = null;
  private prevContainerIds: Set<string> | null = null;
  private prevContainerStates: Map<string, string> | null = null;
  private prevContainerMetrics: Map<string, ContainerMetrics> | null = null;

  computeSystemDelta(
    current: SystemMetrics,
  ): Partial<SystemMetrics> | null {
    if (!this.prevSystem) {
      this.prevSystem = current;
      return current;
    }

    const prev = this.prevSystem;
    const delta: Partial<SystemMetrics> = {};
    let hasChange = false;

    if (Math.abs(prev.cpu.usage - current.cpu.usage) >= CPU_THRESHOLD) {
      delta.cpu = current.cpu;
      hasChange = true;
    }

    if (Math.abs(prev.memory.usage - current.memory.usage) >= MEMORY_THRESHOLD) {
      delta.memory = current.memory;
      hasChange = true;
    }

    if (Math.abs(prev.disk.usage - current.disk.usage) >= DISK_THRESHOLD) {
      delta.disk = current.disk;
      hasChange = true;
    }

    // network is always sent (cumulative values)
    delta.network = current.network;
    // processes/logins always included (small payload, dashboard depends on them)
    delta.processes = current.processes;
    delta.logins = current.logins;
    hasChange = true;

    this.prevSystem = current;
    return hasChange ? delta : null;
  }

  computeContainersDelta(
    current: ContainerInfo[],
  ): ContainerInfo[] | null {
    const currentIds = new Set(current.map((c) => c.id));
    const currentStates = new Map(current.map((c) => [c.id, c.state]));

    if (!this.prevContainerIds || !this.prevContainerStates) {
      this.prevContainerIds = currentIds;
      this.prevContainerStates = currentStates;
      return current;
    }

    let changed = false;

    // check added/removed
    if (currentIds.size !== this.prevContainerIds.size) {
      changed = true;
    } else {
      for (const id of currentIds) {
        if (!this.prevContainerIds.has(id)) {
          changed = true;
          break;
        }
      }
    }

    // check state changes
    if (!changed) {
      for (const [id, state] of currentStates) {
        if (this.prevContainerStates.get(id) !== state) {
          changed = true;
          break;
        }
      }
    }

    this.prevContainerIds = currentIds;
    this.prevContainerStates = currentStates;
    return changed ? current : null;
  }

  computeContainerMetricsDelta(
    current: Record<string, ContainerMetrics>,
  ): Record<string, ContainerMetrics> | null {
    if (!this.prevContainerMetrics) {
      this.prevContainerMetrics = new Map(Object.entries(current));
      return Object.keys(current).length > 0 ? current : null;
    }

    const changed: Record<string, ContainerMetrics> = {};
    let hasChange = false;

    for (const [id, metrics] of Object.entries(current)) {
      const prev = this.prevContainerMetrics.get(id);
      if (!prev) {
        changed[id] = metrics;
        hasChange = true;
        continue;
      }

      if (
        Math.abs(prev.cpu.usage - metrics.cpu.usage) >= CONTAINER_CPU_THRESHOLD ||
        hasContainerNetworkChanged(prev, metrics)
      ) {
        changed[id] = metrics;
        hasChange = true;
      }
    }

    this.prevContainerMetrics = new Map(Object.entries(current));
    return hasChange ? changed : null;
  }

  reset(): void {
    this.prevSystem = null;
    this.prevContainerIds = null;
    this.prevContainerStates = null;
    this.prevContainerMetrics = null;
  }
}

function hasContainerNetworkChanged(
  prev: ContainerMetrics,
  current: ContainerMetrics,
): boolean {
  if (
    prev.network.rx !== current.network.rx ||
    prev.network.tx !== current.network.tx ||
    prev.network_stats.length !== current.network_stats.length
  ) {
    return true;
  }

  for (let i = 0; i < current.network_stats.length; i += 1) {
    const prevStat = prev.network_stats[i];
    const currentStat = current.network_stats[i];

    if (!prevStat || !currentStat) return true;
    if (
      prevStat.network_name !== currentStat.network_name ||
      prevStat.interface_name !== currentStat.interface_name ||
      prevStat.mapping_mode !== currentStat.mapping_mode ||
      prevStat.rx_bytes !== currentStat.rx_bytes ||
      prevStat.tx_bytes !== currentStat.tx_bytes ||
      prevStat.rx_packets !== currentStat.rx_packets ||
      prevStat.tx_packets !== currentStat.tx_packets ||
      prevStat.errors_rx !== currentStat.errors_rx ||
      prevStat.errors_tx !== currentStat.errors_tx
    ) {
      return true;
    }

    if (
      hasNullableRateChanged(prevStat.rx_rate_bps, currentStat.rx_rate_bps) ||
      hasNullableRateChanged(prevStat.tx_rate_bps, currentStat.tx_rate_bps)
    ) {
      return true;
    }
  }

  return false;
}

function hasNullableRateChanged(prev: number | null, current: number | null): boolean {
  if (prev === current) return false;
  if (prev === null || current === null) return true;
  return Math.abs(prev - current) >= CONTAINER_NETWORK_RATE_THRESHOLD;
}
