# HyperCube Agent — Command Protocol

Bidirectional command routing over WebSocket.

## Envelope

```
Browser → Backend → Agent:   {"type": "command", "requestId": "<uuid>", "command": "<name>", "params": {...}}
Agent   → Backend → Browser: {"type": "command_response", "requestId": "<uuid>", "success": true|false, "data": {...}, "error": "<msg>"}
Agent   → Backend → Browser: {"type": "command_progress", "requestId": "<uuid>", "step": "...", "percent": N, "message": "...", "context": {...}}
```

- `requestId` is echoed verbatim by the Agent.
- On failure, `data` is omitted and `error` holds a human-readable string.
- Commands that require Docker return `error: "Docker is not available on this agent."` when the socket is unreachable.
- `command_progress` is emitted **only during** long-running commands (`create_container`, `compose_up`). It is never a substitute for the final `command_response` — every command, success or fail, ends with exactly one `command_response`.

### `command_progress` schema

| field       | type          | notes                                                                                     |
|-------------|---------------|-------------------------------------------------------------------------------------------|
| type        | string        | `"command_progress"`                                                                      |
| requestId   | string        | matches the originating command                                                           |
| step        | enum          | `pulling_image` \| `creating` \| `starting` \| `running_check`                            |
| percent     | number\|null  | 0-100. `null` when unknown                                                                |
| message     | string        | human-readable status line                                                                |
| context     | object (opt.) | e.g. `{ "image": "postgres:15", "containerName": "my-pg", "projectName": "my-stack" }`    |

## Streaming Messages (Agent → Backend, unsolicited)

These are pushed by the Agent on a timer. They do **not** carry `requestId`.

### `system_metrics` (every `COLLECT_INTERVAL`, default 2s — delta)

```json
{
  "type": "system_metrics",
  "timestamp": "2026-04-14T10:00:00.000Z",
  "data": {
    "hostname": "server_16",
    "os": "Linux 6.8.0-101-generic",
    "uptime": 3456789,
    "cpu": { "cores": 12, "model": "Intel Core i5-10400", "usage": 45.2, "perCore": [...] },
    "memory": { "total": 16384, "used": 8192, "free": 8192, "usage": 50.0 },
    "disk": { "total": 512000, "used": 204800, "free": 307200, "usage": 40.0 },
    "network": { "interfaces": ["eth0"], "connections": 42, "rx": 12345, "tx": 67890 },
    "docker": { "version": "28.1.0", "containers": 21, "images": 40 },
    "processes": { "total": 813, "running": 2 },
    "logins": { "total": 2, "active": 2 }
  }
}
```

- **Delta semantics**: On first send (or reconnect), full object. On subsequent sends, only fields that changed beyond threshold. `network`, `processes`, `logins` are always included (dashboard safety).
- Thresholds: cpu.usage ≥ 2%, memory.usage ≥ 1%, disk.usage ≥ 1%.

### `containers` (delta on change + full snapshot every 60s)

```json
{
  "type": "containers",
  "timestamp": "...",
  "data": {
    "containers": [
      { "id": "abc...", "name": "nginx", "image": "nginx:latest", "state": "running", "status": "Up 3 days", "ports": [...], "created": 1744617600 }
    ]
  }
}
```

- **Delta**: sent when a container is added/removed or state changes.
- **Full snapshot**: sent at least every 60s regardless of delta (safety net against Redis TTL expiry / Backend restart).
- On reconnect: immediate full snapshot.

### `container_metrics` (delta per-container + full snapshot every 60s)

```json
{
  "type": "container_metrics",
  "timestamp": "...",
  "data": {
    "containerId": "abc...",
    "name": "...",
    "image": "...",
    "state": "running",
    "cpu": { "usage": 2.1, "cores": 12, "usage_pct": 17.5, "cores_quota": 12 },
    "memory": { "usage": 134217728, "limit": 536870912, "percent": 25.0 },
    "network": { "rx": 2048, "tx": 1024 },
    "disk": { "read": 0, "write": 0 },
    "network_stats": [{ "network_name": "...", "rx_bytes": 0, "tx_bytes": 0, ... }],
    "gpu": { "indices": [0], "usage": 27.5, "memoryUsed": 1572864000, "memoryTotal": 8589934592, "source": "pmon" },
    "workspace": {
      "usedGb": 0.93,
      "rwLayerGb": 1.0,
      "rootFsGb": 8.13,
      "path": "/var/lib/hypercube/workspaces/<short-id>",
      "projectId": null,
      "source": "du"
    }
  }
}
```

- **Delta**: sent per-container when any of CPU(≥2%), network counters, GPU usage/mem, or workspace usedGb(≥50MB) changes.
- **Full snapshot**: every 60s, one message per running container regardless of delta (safety net — idle containers would otherwise expire from Backend Redis cache TTL).
- On reconnect: immediate full snapshot.

**workspace field**

| field | type | notes |
|---|---|---|
| `usedGb` | number \| null | `/workspace` 실측 사용량. `source` 가 `null` 또는 측정 실패 시 `null` |
| `rwLayerGb` | number \| null | `SizeRw / 2^30` — 컨테이너 RW overlay 합산. distroless / no-`/workspace` 컨테이너 fallback |
| `rootFsGb` | number \| null | `SizeRootFs / 2^30` — RW + base image. 보조 |
| `path` | string \| null | `/workspace` 가 bind mount 인 경우 host source 경로. overlay 만 있으면 `null` |
| `projectId` | number \| null | XFS prjquota id (가동 시). 현재 항상 `null` (Phase 3 미가동) |
| `source` | `"du"` \| `"rw-layer"` \| `"xfs-quota"` \| `null` | `usedGb` 산출 출처. UI 우선순위: `xfs-quota` > `du` > `rw-layer`. `null` 은 "—" 표시 |

측정 주기:
- `du -sk /workspace` 는 컨테이너별 10s TTL 캐시. distroless 등 실패 시 5분 TTL 로 retry 절약.
- `SizeRw`/`SizeRootFs` 는 5 사이클(~10s) 마다 `listContainers({size:true})` 한 번 — daemon overlay walk 비용 분산. 사이클 사이엔 캐시 값 재사용.

### `container_events` (push on Docker event, batched within 100ms)

Container lifecycle events streamed from the Docker daemon. Sent in batches of 1+ events; multiple events arriving within a 100ms window are coalesced into one message for network efficiency.

```json
{
  "type": "container_events",
  "timestamp": "2026-05-08T11:30:00.000Z",
  "data": {
    "events": [
      {
        "containerId": "abc123def456...",
        "name": "verify-redis-2",
        "ts": "2026-05-08T11:29:58.123Z",
        "kind": "die",
        "exitCode": 137
      }
    ]
  }
}
```

**Event fields**

| field         | type             | required | notes                                                          |
|---------------|------------------|----------|----------------------------------------------------------------|
| containerId   | string           | yes      | full Docker ID (64 chars). Backend matches on 12-char short ID |
| name          | string           | no       | `Actor.Attributes.name` when present                           |
| ts            | string (ISO8601) | yes      | Docker `time` field (Unix seconds → ISO8601 UTC)               |
| kind          | enum             | yes      | see mapping below                                              |
| exitCode      | number           | no       | included when `kind: "die"`                                    |
| signal        | string           | no       | included when `kind: "kill"`. Numeric signals normalized to `SIGKILL` etc. when known |
| healthStatus  | enum             | no       | included when `kind: "health_status"`. `healthy` \| `unhealthy` \| `starting` |

**Action → kind mapping**

| Docker `Action`                | `kind`          | extra                                          |
|--------------------------------|-----------------|------------------------------------------------|
| `start`                        | `start`         | —                                              |
| `stop`                         | `stop`          | —                                              |
| `die`                          | `die`           | `exitCode`                                     |
| `restart`                      | `restart`       | —                                              |
| `pause`                        | `pause`         | —                                              |
| `unpause`                      | `unpause`       | —                                              |
| `kill`                         | `kill`          | `signal`                                       |
| `oom`                          | `oom`           | — (a `die` follows)                            |
| `health_status: healthy`       | `health_status` | `healthStatus: "healthy"`                      |
| `health_status: unhealthy`     | `health_status` | `healthStatus: "unhealthy"`                    |
| `health_status: starting`      | `health_status` | `healthStatus: "starting"`                     |

Other Docker actions (`create`, `destroy`, `exec_*`, `attach`, `commit`, `rename`, `update`, `top`, ...) are dropped to reduce noise.

- **No backfill**: events arriving while the WebSocket is disconnected are lost. Backend owns retention; the agent is stateless on this stream.
- **Re-subscribe**: on WebSocket reconnect, or when the Docker event stream ends/errors (e.g. daemon restart), the agent re-subscribes after a short backoff (1s → 30s).

### `log_chunk` (push, on demand — see `logs_subscribe`)

Live container log lines pushed to backend while a `logs_subscribe` stream is active. Lines are batched by a 200ms window OR a 50-line threshold (whichever fires first). stdout and stderr are emitted as separate chunks.

```json
{
  "type": "log_chunk",
  "streamId": "<sub-uuid>",
  "stream": "stdout",
  "lines": [
    "2026-05-08T11:30:00.123Z [info] hello",
    "2026-05-08T11:30:00.456Z [warn] something"
  ]
}
```

| field    | type   | notes                                                                       |
|----------|--------|-----------------------------------------------------------------------------|
| streamId | string | echo of the originating `logs_subscribe` `requestId`                        |
| stream   | enum   | `"stdout"` \| `"stderr"` \| `"mixed"`. Demuxed streams emit pure stdout/stderr; `"mixed"` reserved for tty-mode containers where the stream isn't framed |
| lines    | array  | newline-stripped strings. Includes Docker timestamp prefix when subscribe `timestamps:true` |

### `log_stream_end` (push, terminal)

Emitted exactly once when an active stream ends naturally — i.e. the container stops, the Docker stream errors, or the agent shuts down. **NOT emitted** for streams ended via `logs_unsubscribe` (the `command_response(ended:true)` is the terminal signal in that case).

```json
{
  "type": "log_stream_end",
  "streamId": "<sub-uuid>",
  "reason": "container_stopped",
  "error": null
}
```

| reason              | meaning                                                          |
|---------------------|------------------------------------------------------------------|
| `container_stopped` | Docker stream ended (container exited / stopped / removed)       |
| `container_removed` | (reserved — currently emitted as `container_stopped`)            |
| `stream_error`      | Docker socket read error. `error` field carries the message      |
| `agent_shutdown`    | Agent process is shutting down gracefully                        |

---

## Commands

### 1. `get_logs`

Fetch container logs (non-streaming).

**params**
| field        | type    | required | default | notes                          |
|--------------|---------|----------|---------|--------------------------------|
| containerId  | string  | yes      |         | full ID or short ID            |
| tail         | number  | no       | 100     | last N lines                   |
| since        | string  | no       |         | RFC3339 or Unix seconds        |
| timestamps   | boolean | no       | false   | prepend log timestamps         |

**success.data**
```json
{
  "containerId": "abc123",
  "lines": ["log line 1", "log line 2", "..."]
}
```

**errors** — `"containerId is required"`, Dockerode errors (container not found, etc.)

---

### 2. `inspect`

Full container metadata (Docker Inspect subset).

**params**
| field       | type   | required |
|-------------|--------|----------|
| containerId | string | yes      |

**success.data**
```json
{
  "id": "abc123...",
  "name": "nginx",
  "created": "2026-03-31T10:00:00Z",
  "state": {
    "status": "running",
    "running": true,
    "paused": false,
    "restarting": false,
    "oomKilled": false,
    "dead": false,
    "pid": 1234,
    "exitCode": 0,
    "startedAt": "2026-03-31T10:00:01Z",
    "finishedAt": "0001-01-01T00:00:00Z",
    "health": null
  },
  "image": "nginx:latest",
  "config": {
    "hostname": "abc123",
    "env": ["PATH=..."],
    "cmd": ["nginx", "-g", "daemon off;"],
    "labels": { "com.docker.compose.project": "..." },
    "workingDir": "",
    "entrypoint": ["/docker-entrypoint.sh"]
  },
  "networkSettings": {
    "ports": { "80/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "8080" }] },
    "networks": { "bridge": { "IPAddress": "172.17.0.2", "...": "..." } }
  },
  "mounts": [
    { "type": "bind", "source": "/host/path", "destination": "/container/path", "mode": "rw", "rw": true }
  ],
  "restartCount": 0
}
```

**errors** — `"containerId is required"`, Dockerode errors.

---

### 3. `control`

Container lifecycle action.

**params**
| field       | type    | required | default | notes                      |
|-------------|---------|----------|---------|----------------------------|
| containerId | string  | yes      |         |                            |
| action      | string  | yes      |         | see list below             |
| force       | boolean | no       | false   | applies to `remove` only   |

**Valid actions**: `start`, `stop`, `restart`, `pause`, `unpause`, `kill`, `remove`

**success.data**
```json
{ "containerId": "abc123", "action": "restart", "success": true }
```

**errors** — `"containerId is required"`, `"Invalid action: <x>. Valid: start, stop, ..."`, Dockerode errors.

---

### 4. `create_container`

Create and start a single container. Emits `command_progress` events during image pull / create / start.

**params**

| field          | type    | required | default            | notes                                      |
|----------------|---------|----------|--------------------|--------------------------------------------|
| image          | string  | yes      |                    | e.g. `postgres:15`                         |
| name           | string  | yes      |                    | must be unique                             |
| env            | object  | no       | `{}`               | `{ "KEY": "value" }`                       |
| ports          | array   | no       | `[]`               | `[{ host, container, protocol? }]`         |
| volumes        | array   | no       | `[]`               | `[{ host, container, mode? }]`             |
| restart_policy | string  | no       | `"unless-stopped"` | Docker restart policy name                 |
| pull_if_missing| boolean | no       | `true`             | pull image if not present locally          |
| gpus           | array   | no       | `[]`               | ML workspace GPU/MIG device requests       |
| modelMounts    | array   | no       | `[]`               | verified model cache mounts                |
| workspace      | object  | no       |                    | Jupyter env/base URL/port metadata         |
| networkPolicy  | string  | no       | `"none"`           | `none`, `internal_only`, or `host`         |

`networkPolicy` behavior:

- missing, empty, or `"none"` keeps the previous Docker networking behavior.
- `"internal_only"` ensures Docker network `hc-ml-internal` exists with `Internal: true`, attaches the created container only to that network, and keeps explicit/Jupyter port publishing so the existing HyperCube workspace access path can reach Jupyter.
- `"host"` intentionally uses Docker host network mode. Explicit `ports` are rejected because host networking cannot use Docker port publishing.
- Other explicit values are rejected with `supported: none, internal_only, host`.

**success.data**

```json
{
  "containerId": "abc123def456...",
  "name": "my-pg",
  "image": "postgres:15",
  "state": "running"
}
```

**progress steps**: `pulling_image` (per-layer aggregated percent) → `creating` → `starting`.

**errors** — `"image is required"`, `"name is required"`, `"name already exists: <name>"`, `"image pull failed: <reason>"`, `"create failed: <reason>"`, `"start failed: <reason>"`.

Unsupported explicit `networkPolicy` values fail with
`networkPolicy <value> is not supported by this agent. supported: none, internal_only, host`.

`internal_only` deployment smoke checks:

```bash
docker network inspect hc-ml-internal --format '{{.Internal}} {{.Driver}}'
docker inspect <container> --format '{{.HostConfig.NetworkMode}} {{json .NetworkSettings.Networks}}'

if docker exec <container> python3 - <<'PY'
import socket
socket.create_connection(("1.1.1.1", 443), timeout=5)
PY
then
  echo "FAIL: public egress is reachable"
  exit 1
else
  echo "PASS: public egress is blocked"
fi
```

---

### 5. `delete_container`

Remove a container. No progress events (fast operation).

**params**

| field         | type    | required | default |
|---------------|---------|----------|---------|
| containerId   | string  | yes      |         |
| force         | boolean | no       | false   |
| removeVolumes | boolean | no       | false   |

**success.data**

```json
{ "containerId": "abc123def456...", "removed": true }
```

**errors** — `"containerId is required"`, `"container not found"`, `"running container, set force=true to remove"`.

---

### 6. `compose_up`

Bring up a docker-compose project. Emits progress events per step.

**params**

| field           | type    | required | default | notes                                 |
|-----------------|---------|----------|---------|---------------------------------------|
| projectName     | string  | yes      |         | `docker compose -p <name>`            |
| composeYaml     | string  | yes      |         | raw YAML body                         |
| env             | object  | no       | `{}`    | env vars passed to compose (for `${VAR}` substitution) |
| pull_if_missing | boolean | no       | true    | pull images only if missing           |

**success.data**

```json
{
  "projectName": "my-stack",
  "containers": [
    { "containerId": "abc...", "name": "my-stack-web-1", "image": "nginx:1.27", "state": "running" },
    { "containerId": "def...", "name": "my-stack-db-1",  "image": "postgres:15", "state": "running" }
  ]
}
```

Container list is enumerated via `com.docker.compose.project=<projectName>` label filter.

**progress steps**: `pulling_image` / `creating` / `starting` lines streamed from compose CLI stdout/stderr.

**errors** — `"projectName is required"`, `"composeYaml is required"`, `"compose up failed: <reason>"`.

Implementation note: agent runs `docker compose -p <name> -f <tmpfile> up -d --pull missing`. The agent container ships with the docker CLI + compose plugin.

---

### 7. `compose_down`

Stop and remove a compose project. No progress events.

**params**

| field         | type    | required | default | notes                           |
|---------------|---------|----------|---------|---------------------------------|
| projectName   | string  | yes      |         |                                 |
| removeVolumes | boolean | no       | false   | `-v`                            |
| removeImages  | boolean | no       | false   | `--rmi all`                     |

**success.data**

```json
{ "projectName": "my-stack", "removedContainerIds": ["abc...", "def..."] }
```

`removedContainerIds` is the list captured **before** `down` executes (via label filter).

**errors** — `"projectName is required"`, `"compose down failed: <reason>"`.

---

### 8. `system_info`

Host-level system data. One subcommand per invocation.

**params**
| field      | type   | required | notes                                                    |
|------------|--------|----------|----------------------------------------------------------|
| subCommand | string | yes      | `cpu_detail` \| `processes` \| `network_detail` \| `users` |
| sortBy     | string | no       | `processes` only — `cpu` (default) or `mem`              |

Invalid `subCommand` → `"Invalid subCommand: <x>. Valid: cpu_detail, processes, network_detail, users"`.

#### 4.1 `cpu_detail`

```json
{
  "model": "Intel Core i5-10400",
  "speed": 2.9,
  "cores": 12,
  "usage": 45.2,
  "perCore": [{ "core": 0, "load": 30.1 }, { "core": 1, "load": 50.4 }],
  "temperature": { "main": 55, "cores": [54, 56, 55, 57], "max": 57 },
  "loadAvg": { "avg1": 1.23, "avg5": 1.45, "avg15": 1.30 }
}
```

- `temperature` is `null` when sensors unavailable.
- `loadAvg` is read from `/host/proc/loadavg` (fallback: `os.loadavg()`).

#### 4.2 `processes`

```json
{
  "total": 350,
  "running": 2,
  "blocked": 0,
  "list": [
    {
      "pid": 1234,
      "name": "node",
      "cpu": 3.2,
      "mem": 128.5,
      "state": "running",
      "user": "root",
      "command": "node /app/dist/index.js"
    }
  ]
}
```

- `list` is capped at 50 entries, sorted by `cpu` or `mem` (`sortBy` param).
- `mem` is RSS in MB.
- Host process visibility requires `pid: host` in compose.

#### 4.3 `network_detail`

```json
{
  "interfaces": [
    {
      "iface": "eth0",
      "ip4": "192.168.0.16",
      "ip6": "fe80::...",
      "mac": "aa:bb:cc:dd:ee:ff",
      "type": "wired",
      "speed": 1000,
      "operstate": "up"
    }
  ],
  "stats": {
    "rx_bytes": 123456789,
    "tx_bytes": 987654321,
    "rx_packets": 1234567,
    "tx_packets": 7654321,
    "rx_errors": 0,
    "tx_errors": 0
  },
  "connections": 42
}
```

- `stats` is the **sum** of all interfaces except `lo`, parsed from `/host/proc/net/dev`.
- `connections` is the count of active connections (may be 0 if unavailable).

#### 4.4 `users`

```json
{
  "users": [
    {
      "user": "agics-ai",
      "terminal": "pts/0",
      "date": "2026-04-13",
      "time": "10:30",
      "ip": "192.168.0.47",
      "command": "-bash"
    }
  ]
}
```

- Requires `/var/run/utmp` mount in compose. Empty array if not mounted.

---

### 9. `logs_subscribe`

Open a live `docker logs --follow` stream. The `command_response` is sent immediately; log lines are then pushed asynchronously as `log_chunk` messages keyed by `streamId`. The stream ends when the container stops (`log_stream_end`), on `logs_unsubscribe`, on WebSocket reconnect (silent), or on agent shutdown (`log_stream_end reason:"agent_shutdown"`).

`get_logs` (non-streaming, polling) remains available for one-shot fetches.

**params**

| field       | type    | required | default | notes                                                                          |
|-------------|---------|----------|---------|--------------------------------------------------------------------------------|
| containerId | string  | yes      |         | full ID or short ID                                                            |
| tail        | number  | no       | 100     | initial backfill line count. `0` = start from now                              |
| since       | string  | no       |         | ISO8601 (`"2026-05-08T11:00:00Z"`) OR relative shorthand (`"5m"`, `"1h"`, `"30s"`) |
| timestamps  | boolean | no       | true    | prepend Docker RFC3339 timestamp to each line                                  |

**success.data**

```json
{ "streamId": "<sub-uuid>", "subscribed": true }
```

`streamId` is the originating `requestId` echoed back. All subsequent `log_chunk` and `log_stream_end` messages reference this id.

**errors** — `"containerId is required"`, container not found, Docker errors. On error, no stream is opened.

**streaming follow-on** — see `log_chunk` and `log_stream_end` in *Streaming Messages* above.

---

### 10. `logs_unsubscribe`

Stop an active log stream. **Idempotent**: succeeds even if the streamId doesn't match any active stream (already-ended streams included). Does NOT cause a `log_stream_end` to be emitted — the `command_response` is the only terminal signal.

**params**

| field    | type   | required | notes                                                |
|----------|--------|----------|------------------------------------------------------|
| streamId | string | yes      | the `streamId` returned by the originating subscribe |

**success.data**

```json
{ "ended": true, "streamId": "<sub-uuid>" }
```

**errors** — `"streamId is required"` (when missing). Unknown streamIds return success (idempotent).

---

### 11. `container_processes`

Top-N processes inside a container, sorted by CPU or memory. Works on minimal images (no `ps` inside the container required) — agent observes via host `/proc` and `dockerode container.top()`.

**params**

| field       | type   | required | default | notes                                            |
|-------------|--------|----------|---------|--------------------------------------------------|
| containerId | string | yes      |         | full ID or short ID                              |
| sortBy      | string | no       | `"cpu"` | `cpu` \| `mem`. Other values silently fall back to `cpu` |
| limit       | number | no       | 20      | clamped to `[1, 100]`. NaN/missing → default     |

**success.data**

```json
{
  "containerId": "abc123def456",
  "total": 42,
  "processes": [
    {
      "pid": 1234,
      "name": "redis-server",
      "command": "redis-server *:6379",
      "cpu_percent": 1.2,
      "memory_rss": 12582912,
      "state": "S",
      "user": "999"
    }
  ]
}
```

| field       | type   | notes                                                                                  |
|-------------|--------|----------------------------------------------------------------------------------------|
| containerId | string | always returned as the 12-char short ID                                                |
| total       | number | full process count inside the container (before `limit` is applied)                    |
| pid         | number | host PID (agent runs with `pid: host`)                                                 |
| name        | string | `/proc/<pid>/comm` (15-char limit), falls back to first cmdline token                  |
| command     | string | full cmdline, NULLs replaced with spaces. Empty for kernel threads — `comm` then used  |
| cpu_percent | number | `Δ(utime+stime) / clk_tck / Δwall * 100` (cores summed; 4-core fully busy = 400). Sampled 100ms apart |
| memory_rss  | number | `/proc/<pid>/status` `VmRSS` × 1024, in bytes                                          |
| state       | string | `/proc/<pid>/stat` state code: `R` running, `S` sleep, `D` uninterruptible, `Z` zombie, `T` stopped, `I` idle |
| user        | string | real `Uid` from `/proc/<pid>/status`. Username resolution not attempted (uid string)   |

**errors** — `"containerId is required"`, `"container_not_found"` (404 from Docker), `"container_not_running"` (state ≠ Running), `"permission_denied"` (host `/proc` not readable). Other Docker / fs errors propagate verbatim.

**Implementation notes**

- PID enumeration: tries `container.top()` first (image-agnostic — daemon runs host `ps` against the container's pid namespace; `ps` is never invoked inside the container). Falls back to scanning `/host/proc/<pid>/cgroup` for the container ID when `top()` fails (paused containers, daemon errors).
- CPU sampling holds the dispatcher for ~100ms by design. Concurrent calls are safe but each pays this cost.
- Sort tie-breaker: ascending PID (stable order across calls).
