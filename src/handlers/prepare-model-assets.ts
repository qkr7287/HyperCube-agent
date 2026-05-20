import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig, ProgressEmitter } from "../types/index.js";
import {
  buildDefaultCachePath,
  buildTempPath,
  ensureCacheRoot,
  hashPath,
  parseChecksum,
  pathExists,
  readManifest,
  resolveCachePath,
  resolveExistingCachePath,
  writeManifest,
  type ModelAssetChecksum,
} from "../utils/model-cache.js";

type TransferMode = "backend_stream" | "preseeded" | "nas_copy";

interface BackendStreamAsset {
  index: number;
  versionId: string | null;
  assetId: string | null;
  assetSlug: string | null;
  version: string | null;
  expectedSizeBytes: number | null;
  checksum: ModelAssetChecksum;
  contentUrl: string;
  auth: string | null;
  mountPath: string | null;
  targetPath: string;
  cachePathIsDirectory: boolean;
}

interface PreparedAssetResult {
  versionId: string | null;
  assetId: string | null;
  assetSlug: string | null;
  version: string | null;
  cachePath: string;
  sourcePath: string;
  mountPath: string | null;
  sha256: string;
  checksum: ModelAssetChecksum;
  sizeBytes: number | undefined;
  cached: boolean;
}

export async function handlePrepareModelAssets(
  config: AppConfig,
  agentToken: string,
  requestId: string,
  params: Record<string, unknown>,
  emitProgress: ProgressEmitter,
): Promise<Record<string, unknown>> {
  const mode = parseTransferMode(params);
  await ensureCacheRoot(config.modelCacheRoot);

  switch (mode) {
    case "backend_stream":
      return await prepareBackendStream(config, agentToken, requestId, params, emitProgress);
    case "preseeded":
      return await preparePreseeded(config, params, emitProgress);
    case "nas_copy":
      throw new Error("transfer mode nas_copy is not implemented by this agent");
  }
}

async function prepareBackendStream(
  config: AppConfig,
  agentToken: string,
  requestId: string,
  params: Record<string, unknown>,
  emitProgress: ProgressEmitter,
): Promise<Record<string, unknown>> {
  const assets = normalizeBackendStreamAssets(config.modelCacheRoot, requestId, params);
  const results: PreparedAssetResult[] = [];

  for (const asset of assets) {
    results.push(
      await prepareOneBackendStreamAsset(
        config,
        agentToken,
        asset,
        emitProgress,
      ),
    );
  }

  const first = results[0];
  return {
    mode: "backend_stream",
    cachePath: first.cachePath,
    sourcePath: first.sourcePath,
    sha256: first.sha256,
    checksum: first.checksum,
    sizeBytes: first.sizeBytes,
    verified: true,
    cached: results.every((asset) => asset.cached),
    assets: results,
  };
}

async function prepareOneBackendStreamAsset(
  config: AppConfig,
  agentToken: string,
  asset: BackendStreamAsset,
  emitProgress: ProgressEmitter,
): Promise<PreparedAssetResult> {
  if (asset.auth && asset.auth !== "agent_bearer") {
    throw new Error(`assets[${asset.index}].source.auth must be agent_bearer`);
  }

  const existing = await getExistingVerifiedTarget(asset.targetPath, asset.checksum);
  if (existing) {
    return buildPreparedAssetResult(asset, existing.sizeBytes, true);
  }

  // A non-verified leftover at targetPath (a partial download, or an empty
  // v1/ directory from a crashed attempt) must not block the retry. Clear it
  // so the re-download starts from a clean state. (incident c)
  await fs.rm(asset.targetPath, { recursive: true, force: true }).catch(() => undefined);

  const url = resolveBackendStreamUrl(config.backendApiUrl, asset.contentUrl);
  const tempPath = buildTempPath(config.modelCacheRoot, `${asset.versionId ?? "asset"}-${asset.index}`);

  emitProgress({
    phase: "prepare_model_assets",
    step: "preparing_model_assets",
    percent: 0,
    message: "Preparing model asset download",
    context: buildProgressContext(asset),
    data: { bytesDone: 0, percent: 0 },
  });

  let moved = false;
  let targetFilePath = asset.targetPath;
  try {
    const downloaded = await downloadBackendStream(url, agentToken, tempPath, emitProgress);
    if (asset.expectedSizeBytes !== null && downloaded.sizeBytes !== asset.expectedSizeBytes) {
      throw new Error(
        `model asset size mismatch: expected ${asset.expectedSizeBytes}, got ${downloaded.sizeBytes}`,
      );
    }
    verifyChecksum(asset.checksum, downloaded.sha256);

    if (asset.cachePathIsDirectory) {
      await fs.mkdir(asset.targetPath, { recursive: true, mode: 0o700 });
      targetFilePath = path.join(asset.targetPath, downloaded.fileName ?? defaultAssetFileName(asset));
    } else {
      await fs.mkdir(path.dirname(asset.targetPath), { recursive: true, mode: 0o700 });
    }
    await fs.rename(tempPath, targetFilePath);
    moved = true;

    emitProgress({
      phase: "prepare_model_assets",
      step: "verifying_model_assets",
      percent: 100,
      message: "Model asset checksum verified",
      context: { ...buildProgressContext(asset), bytes: downloaded.sizeBytes },
      data: { bytesDone: downloaded.sizeBytes, percent: 100 },
    });

    const manifest = await writeManifest(asset.targetPath, {
      mode: "backend_stream",
      checksum: asset.checksum,
      sizeBytes: downloaded.sizeBytes,
    });

    return buildPreparedAssetResult(asset, manifest.sizeBytes, false);
  } finally {
    if (!moved) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function preparePreseeded(
  config: AppConfig,
  params: Record<string, unknown>,
  emitProgress: ProgressEmitter,
): Promise<Record<string, unknown>> {
  const rawSourcePath = asString(params.sourcePath) ?? asString(params.cachePath);
  if (!rawSourcePath) throw new Error("preseeded requires sourcePath");
  const sourcePath = await resolveExistingCachePath(config.modelCacheRoot, rawSourcePath);
  const checksum = parseChecksum(params);

  emitProgress({
    phase: "prepare_model_assets",
    step: "verifying_model_assets",
    percent: null,
    message: "Verifying preseeded model asset",
    context: { mode: "preseeded" },
  });

  const hashed = await hashPath(sourcePath);
  if (checksum) verifyChecksum(checksum, hashed.sha256);
  const manifest = await writeManifest(sourcePath, {
    mode: "preseeded",
    checksum: checksum ?? { algorithm: "sha256", value: hashed.sha256 },
    sizeBytes: hashed.sizeBytes,
  });

  emitProgress({
    phase: "prepare_model_assets",
    step: "verifying_model_assets",
    percent: 100,
    message: "Preseeded model asset verified",
    context: { mode: "preseeded", bytes: hashed.sizeBytes },
  });

  return {
    mode: "preseeded",
    cachePath: sourcePath,
    checksum: manifest.checksum,
    sizeBytes: manifest.sizeBytes,
    verified: true,
  };
}

// Decides whether targetPath already holds a verified copy of this asset, so
// a repeated prepare call (e.g. the backend self-heal re-dispatch) can return
// success immediately without re-downloading. Returns null — "treat as
// missing, re-prepare" — for every non-verified state rather than throwing,
// which keeps prepare_model_assets idempotent. (Issue 1)
async function getExistingVerifiedTarget(
  targetPath: string,
  checksum: ModelAssetChecksum,
): Promise<{ sizeBytes?: number } | null> {
  if (!(await pathExists(targetPath))) return null;
  let manifest;
  try {
    manifest = await readManifest(targetPath);
  } catch {
    // No sha256-verifiable manifest: a partial/aborted download or an empty
    // directory left by a failed attempt. Not "already prepared". (incident c)
    return null;
  }
  if (manifest.checksum?.algorithm === checksum.algorithm && manifest.checksum.value === checksum.value) {
    return { sizeBytes: manifest.sizeBytes };
  }
  // Manifest is present but records a different asset → re-prepare.
  return null;
}

async function downloadBackendStream(
  url: URL,
  agentToken: string,
  tempPath: string,
  emitProgress: ProgressEmitter,
): Promise<{ sha256: string; sizeBytes: number; fileName: string | null }> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "X-Agent-Token": agentToken,
    },
  });
  if (!response.ok) {
    throw new Error(`backend_stream failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error("backend_stream response body is empty");

  const total = Number(response.headers.get("content-length"));
  const hasTotal = Number.isFinite(total) && total > 0;
  const fileName = parseContentDispositionFileName(response.headers.get("content-disposition"));
  const hash = createHash("sha256");
  const file = await fs.open(tempPath, "wx", 0o600);
  let sizeBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      await file.write(chunk);
      hash.update(chunk);
      sizeBytes += chunk.length;
      const percent = hasTotal ? Math.min(99, Math.round((sizeBytes / total) * 100)) : null;
      emitProgress({
        phase: "prepare_model_assets",
        step: "preparing_model_assets",
        percent,
        message: "Downloading model asset from backend",
        context: { mode: "backend_stream", bytes: sizeBytes, totalBytes: hasTotal ? total : null },
        data: { bytesDone: sizeBytes, percent },
      });
    }
  } finally {
    await file.close();
  }

  return { sha256: hash.digest("hex"), sizeBytes, fileName };
}

function resolveBackendStreamUrl(
  backendApiUrl: string,
  source: string | Record<string, unknown>,
): URL {
  const params = typeof source === "string" ? null : source;
  const raw = typeof source === "string"
    ? source
    : asString(params?.sourceUrl) ??
      asString(params?.backendUrl) ??
      asString(params?.url) ??
      asString(params?.path);
  if (!raw) throw new Error("backend_stream requires sourceUrl");
  if (/^(s3|git|ssh|ftp|hf):/i.test(raw)) {
    throw new Error(`external transfer scheme is not allowed: ${raw.split(":")[0]}`);
  }

  const base = new URL(backendApiUrl);
  const resolved = new URL(raw, base);
  if (resolved.origin !== base.origin) {
    throw new Error("backend_stream sourceUrl must use BACKEND_API_URL origin");
  }

  for (const key of resolved.searchParams.keys()) {
    if (/token|secret|password|credential|signature/i.test(key)) {
      throw new Error("backend_stream credentials must be sent in headers, not query string");
    }
  }

  return resolved;
}

function parseTransferMode(params: Record<string, unknown>): TransferMode {
  const raw = asString(params.transferMode) ?? asString(params.mode);
  if (raw === "backend_stream" || raw === "preseeded" || raw === "nas_copy") return raw;
  throw new Error(`unsupported model asset transfer mode: ${raw ?? "missing"}`);
}

function normalizeBackendStreamAssets(
  cacheRoot: string,
  requestId: string,
  params: Record<string, unknown>,
): BackendStreamAsset[] {
  const rawAssets = Array.isArray(params.assets) ? params.assets : null;
  if (!rawAssets || rawAssets.length === 0) {
    return [normalizeTopLevelBackendStreamAsset(cacheRoot, requestId, params)];
  }

  return rawAssets.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`assets[${index}] must be an object`);
    }
    const asset = raw as Record<string, unknown>;
    const source = isRecord(asset.source) ? asset.source : {};
    const checksum = parseAssetChecksum(asset, source, index);
    const contentUrl = asString(source.contentUrl) ?? asString(asset.contentUrl);
    if (!contentUrl) throw new Error(`assets[${index}].source.contentUrl is required`);
    const sourceType = asString(source.type);
    if (sourceType && sourceType !== "backend_stream") {
      throw new Error(`assets[${index}].source.type must be backend_stream`);
    }

    const assetSlug = asString(asset.assetSlug);
    const version = asString(asset.version);
    const targetPath = resolveCachePath(
      cacheRoot,
      asString(asset.cachePath) ??
        asString(asset.targetPath) ??
        (assetSlug && version
          ? path.join(cacheRoot, sanitizePathSegment(assetSlug), sanitizePathSegment(version))
          : buildDefaultCachePath(cacheRoot, requestId, params)),
    );

    return {
      index,
      versionId: asString(asset.versionId),
      assetId: asString(asset.assetId),
      assetSlug,
      version,
      expectedSizeBytes: asNullablePositiveInteger(asset.sizeBytes ?? source.sizeBytes),
      checksum,
      contentUrl,
      auth: asString(source.auth),
      mountPath: asString(asset.mountPath),
      targetPath,
      cachePathIsDirectory: true,
    };
  });
}

function normalizeTopLevelBackendStreamAsset(
  cacheRoot: string,
  requestId: string,
  params: Record<string, unknown>,
): BackendStreamAsset {
  const checksum = parseChecksum(params);
  if (!checksum) throw new Error("backend_stream requires sha256 checksum");
  return {
    index: 0,
    versionId: asString(params.versionId),
    assetId: asString(params.assetId),
    assetSlug: asString(params.assetSlug),
    version: asString(params.version) ?? asString(params.modelVersion),
    expectedSizeBytes: asNullablePositiveInteger(params.sizeBytes),
    checksum,
    contentUrl:
      asString(params.sourceUrl) ??
      asString(params.backendUrl) ??
      asString(params.url) ??
      asString(params.path) ??
      "",
    auth: asString(params.auth),
    mountPath: asString(params.mountPath),
    targetPath: resolveCachePath(
      cacheRoot,
      asString(params.cachePath) ??
        asString(params.targetPath) ??
        buildDefaultCachePath(cacheRoot, requestId, params),
    ),
    cachePathIsDirectory: false,
  };
}

function parseAssetChecksum(
  asset: Record<string, unknown>,
  source: Record<string, unknown>,
  index: number,
): ModelAssetChecksum {
  const value =
    asString(asset.sha256) ??
    checksumValue(asset.checksum) ??
    asString(asset.checksumSha256) ??
    asString(source.sha256) ??
    checksumValue(source.checksum);
  if (!value) throw new Error(`assets[${index}].sha256 is required`);
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`assets[${index}].sha256 must be a 64-character hex string`);
  }
  return { algorithm: "sha256", value: value.toLowerCase() };
}

function checksumValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (isRecord(value)) {
    return asString(value.value) ?? asString(value.sha256);
  }
  return null;
}

function buildPreparedAssetResult(
  asset: BackendStreamAsset,
  sizeBytes: number | undefined,
  cached: boolean,
): PreparedAssetResult {
  return {
    versionId: asset.versionId,
    assetId: asset.assetId,
    assetSlug: asset.assetSlug,
    version: asset.version,
    cachePath: asset.targetPath,
    sourcePath: asset.targetPath,
    mountPath: asset.mountPath,
    sha256: asset.checksum.value,
    checksum: asset.checksum,
    sizeBytes,
    cached,
  };
}

function buildProgressContext(asset: BackendStreamAsset): Record<string, unknown> {
  return {
    mode: "backend_stream",
    assetIndex: asset.index,
    versionId: asset.versionId,
    assetId: asset.assetId,
    assetSlug: asset.assetSlug,
  };
}

function verifyChecksum(expected: ModelAssetChecksum, actualSha256: string): void {
  if (expected.value !== actualSha256.toLowerCase()) {
    throw new Error("model asset checksum mismatch");
  }
}

function parseContentDispositionFileName(value: string | null): string | null {
  if (!value) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8Match) return sanitizeFileName(decodeURIComponentSafe(utf8Match[1]));
  const quotedMatch = /filename="([^"]+)"/i.exec(value);
  if (quotedMatch) return sanitizeFileName(quotedMatch[1]);
  const plainMatch = /filename=([^;]+)/i.exec(value);
  if (plainMatch) return sanitizeFileName(plainMatch[1].trim());
  return null;
}

function defaultAssetFileName(asset: BackendStreamAsset): string {
  const base = asset.assetSlug ?? asset.versionId ?? asset.assetId ?? "asset";
  return `${sanitizeFileName(base)}.bin`;
}

function sanitizeFileName(value: string): string {
  const base = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base : "asset.bin";
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return sanitized.slice(0, 120) || "asset";
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function asNullablePositiveInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
