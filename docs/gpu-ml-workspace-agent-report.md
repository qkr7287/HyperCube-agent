# HyperCube Agent GPU ML Workspace v1 Report

Date: 2026-05-12

## Changed files

- `src/capabilities.ts`
- `src/utils/gpu-inventory.ts`
- `src/utils/model-cache.ts`
- `src/handlers/system-info.ts`
- `src/handlers/image-inspect.ts`
- `src/handlers/create-container.ts`
- `src/handlers/prepare-model-assets.ts`
- `src/handlers/index.ts`
- `src/index.ts`
- `src/config.ts`
- `src/types/index.ts`
- `docs/gpu-ml-workspace-agent-report.md`

## Completed

- Added ML workspace capability discovery through `system_info` subCommand `capabilities`.
- Added `system_info` subCommand `gpu_inventory` with NVIDIA GPU UUID and MIG UUID slice reporting.
- Added `image_inspect` command for local Docker image presence checks.
- Extended `create_container` with optional `gpus`, `workspace`, `modelMounts`, and explicit `networkPolicy` handling.
- Added NVIDIA Docker `HostConfig.DeviceRequests` for requested GPU/MIG device IDs.
- Added workspace env injection and TCP port binding; success responses include `workspace.hostPort`, `internalPort`, and `baseUrl`.
- Added model cache verification manifests and `modelMounts` enforcement under `MODEL_CACHE_ROOT`.
- Added `prepare_model_assets` with `backend_stream` and `preseeded`; `nas_copy` is explicitly reserved/unsupported.
- `backend_stream` uses agent token headers, rejects non-backend origins and external schemes, downloads to temp, verifies SHA256, and atomic-renames into cache.
- `command_progress` for model preparation includes `phase: "prepare_model_assets"`.
- ML workspace creates do not pull images; local image presence is required when new ML optional params are present.

## Verification run

- `git status --short --branch`: baseline was `dev...origin/dev [ahead 4]` with pre-existing changes in `docs/PROTOCOL.md`, `scripts/dev-off.sh`, `scripts/dev-on.sh`, `scripts/dev-supervisor.sh`, and untracked `src/handlers/container-processes.ts`.
- `npm run typecheck`: passed after implementation.
- `npm run build`: passed after implementation.
- `nvidia-smi --query-gpu=index,name,uuid,pci.bus_id,memory.total,mig.mode.current --format=csv,noheader,nounits`: local host returned one RTX 2080 Ti row.
- `nvidia-smi -L`: local host returned the matching GPU UUID.
- Parser mock run against built `dist/utils/gpu-inventory.js`: parsed GPU rows and MIG slice UUIDs.
- Previous `system_info` `capabilities` run against built `dist` returned all ML workspace capability flags and `networkPolicy: "not_enforced"` before the enforcement follow-up below.
- Fake-Docker `image_inspect` run against built `dist`: present image returned image ID/tags and `internal_registry`; missing image returned `present: false`.
- Fake-Docker handler run against built `dist`:
  - legacy `create_container` without ML params returned the previous response shape and did not add `DeviceRequests`.
  - `prepare_model_assets` `preseeded` wrote a verified manifest and emitted `phase: "prepare_model_assets"`.
  - checksum mismatch failed with `model asset checksum mismatch`.
  - `create_container` workspace path injected `JUPYTER_TOKEN`, `JUPYTER_PORT`, `JUPYTER_BASE_URL`, `WORKSPACE_BASE_URL`.
  - workspace port `8888/tcp` was bound.
  - verified `modelMounts` produced a read-only bind.
  - missing `modelMounts.sourcePath` failed with `model cache path does not exist: ...`.
- Local loopback `backend_stream` handler run against built `dist`:
  - same-origin `sourceUrl` download succeeded.
  - request carried `Authorization: Bearer <agent token>` and `X-Agent-Token` headers.
  - progress carried `phase: "prepare_model_assets"`.
  - duplicate same checksum returned `cached: true`.
  - checksum mismatch failed and left `MODEL_CACHE_ROOT/.tmp` empty.
- Source search for forbidden public download paths in new ML files found no matches for Hugging Face, GitHub, GHCR, NGC, Docker Hub, S3 URLs, `git clone`, `npm install`, `pip install`, `apt-get`, or `docker pull`.
- Docker daemon live checks were attempted but blocked by local permission: `permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.
- Node child_process execution of `nvidia-smi` was blocked by local sandbox with `spawn EPERM`; direct PowerShell `nvidia-smi` commands succeeded.

## Remaining blockers

- Live Docker `image_inspect` and actual container creation could not be executed in this local session because Docker API access is denied.
- Live NVIDIA DeviceRequests could not be verified by starting a GPU container here.
- Live `networkPolicy: "internal_only"` Docker enforcement must be verified on server 63 after deployment.
- `nas_copy` is scaffolded only as an explicit unsupported mode.
- Backend must define the exact internal `backend_stream.sourceUrl` endpoint and accept the approved agent token in `Authorization: Bearer ...` and/or `X-Agent-Token`.

## HyperCube core payload contract to align

- Capability discovery command:
  - `command: "system_info"`
  - `params: {"subCommand": "capabilities"}`
- GPU inventory command:
  - `command: "system_info"`
  - `params: {"subCommand": "gpu_inventory"}`
- Image inspect command:
  - `command: "image_inspect"`
  - `params: {"image": "<image-ref>"}`
- Prepare command:
  - `command: "prepare_model_assets"`
  - Use `ModelPrepareJob.id` as the command `requestId`.
  - Expect progress with `phase: "prepare_model_assets"`.
  - For `backend_stream`, send a same-origin `sourceUrl` relative to `BACKEND_API_URL` and a SHA256 checksum.
- Create command additions:
  - `gpus: [{deviceId, kind}]`
  - `modelMounts: [{sourcePath, mountPath, readOnly}]`
  - `workspace: {kind, token, port, baseUrl}`
- `networkPolicy`: missing/empty/`"none"` keeps the previous Docker default, `"internal_only"` attaches only to the agent-managed Docker internal network `hc-ml-internal`, and `"host"` uses Docker host network mode without port publishing.

## Manual server/GPU host checks

```bash
npm run typecheck
npm run build
nvidia-smi --query-gpu=index,name,uuid,pci.bus_id,memory.total,mig.mode.current --format=csv,noheader,nounits
nvidia-smi -L
docker image inspect <workspace-image>
docker inspect <created-container> --format '{{json .HostConfig.DeviceRequests}}'
docker inspect <created-container> --format '{{json .Config.Env}}'
docker inspect <created-container> --format '{{json .HostConfig.PortBindings}}'
docker inspect <created-container> --format '{{json .Mounts}}'
docker network inspect hc-ml-internal --format '{{.Internal}} {{.Driver}}'
docker inspect <created-container> --format '{{.HostConfig.NetworkMode}} {{json .NetworkSettings.Networks}}'
```

For an `internal_only` workspace, the first field from the container inspect command should be
`hc-ml-internal`, the networks JSON should contain only `hc-ml-internal`, and the Docker network
inspect command should print `true bridge`.

Negative public egress smoke check for the created workspace container:

```bash
if docker exec <created-container> python3 - <<'PY'
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

For backend-stream prepare, verify server-side that the token is received from headers, not
query string, and that checksum mismatch leaves no partial file in `MODEL_CACHE_ROOT/.tmp`.

## Issue #14 follow-up

Date: 2026-05-13

- Fixed `prepare_model_assets` `backend_stream` to accept the core payload shape where the canonical checksum is `params.assets[N].sha256`, not only a top-level `params.sha256`.
- Added support for checksum aliases documented by core handoff notes: `assets[N].checksum`, `assets[N].checksumSha256`, `assets[N].source.sha256`, and `assets[N].source.checksum`.
- Added per-asset normalization for `versionId`, `assetId`, `assetSlug`, `version`, `sizeBytes`, `mountPath`, and `source.contentUrl`.
- For `assets[]` payloads, cache output is now a verified directory at `MODEL_CACHE_ROOT/<assetSlug>/<version>` and the downloaded file name is taken from `Content-Disposition` when present.
- Success response keeps core-required top-level `cachePath` and `sha256`, and also includes `assets[]` details for multi-asset compatibility.
- Verified locally with a loopback backend-stream server:
  - accepted `params.assets[0].sha256`
  - sent token in `Authorization: Bearer ...` and `X-Agent-Token` headers
  - did not put token material in query string
  - emitted `phase: "prepare_model_assets"` progress
  - returned `cached: true` on repeat prepare with matching manifest
  - failed checksum mismatch with `model asset checksum mismatch`
  - left `MODEL_CACHE_ROOT/.tmp` empty after mismatch
- Updated dev agents `server_63_dev` and `server_16_dev` by copying current source into their remote workspaces and restarting the existing `hypercube-agent-dev-*` containers without rebuilding Docker images.
- Remote verification on both 63 and 16:
  - `npm run typecheck`: passed inside the dev agent container
  - `npm run build`: passed inside the dev agent container
  - loopback issue #14 payload test: passed inside the dev agent container

## networkPolicy enforcement follow-up

Date: 2026-05-13

- Replaced the explicit `networkPolicy: "internal_only"` failure with Docker internal network enforcement.
- Added `hc-ml-internal` creation with `Internal: true`; if that network already exists but is not internal, create fails clearly instead of attaching the workspace to it.
- `internal_only` create options set `HostConfig.NetworkMode` to `hc-ml-internal` and `NetworkingConfig.EndpointsConfig` to only that network, so the default external `bridge` network is not attached.
- Jupyter port publishing remains enabled for `internal_only`, preserving the existing HyperCube workspace access path.
- Added `networkPolicy: "host"` handling as an intentional host-network mode; explicit `ports` are rejected with host mode because Docker host networking cannot use port publishing.
- Unsupported values fail with `supported: none, internal_only, host`.
- Capability discovery now reports `networkPolicy: "enforced"`, `networkPolicyInternalOnly: true`, `networkPolicyHost: true`, and `networkPolicyNotEnforced: false`.
- Added local self-test command: `npm run self-test:network-policy`.
