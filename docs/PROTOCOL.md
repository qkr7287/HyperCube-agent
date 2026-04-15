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

### `container_metrics` (every cycle, delta per-container)

```json
{
  "type": "container_metrics",
  "timestamp": "...",
  "data": {
    "containerId": "abc...",
    "cpu": { "usage": 2.1, "cores": 12 },
    "memory": { "usage": 134217728, "limit": 536870912, "percent": 25.0 },
    "network": { "rx": 2048, "tx": 1024 },
    "disk": { "read": 0, "write": 0 }
  }
}
```

- Sent per-container when CPU usage changes ≥ 2%.

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
