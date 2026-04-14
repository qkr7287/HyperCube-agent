# HyperCube Agent — Command Protocol

Bidirectional command routing over WebSocket.

## Envelope

```
Browser → Backend → Agent:   {"type": "command", "requestId": "<uuid>", "command": "<name>", "params": {...}}
Agent   → Backend → Browser: {"type": "command_response", "requestId": "<uuid>", "success": true|false, "data": {...}, "error": "<msg>"}
```

- `requestId` is echoed verbatim by the Agent.
- On failure, `data` is omitted and `error` holds a human-readable string.
- Commands that require Docker return `error: "Docker is not available on this agent."` when the socket is unreachable.

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

### 4. `system_info`

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
