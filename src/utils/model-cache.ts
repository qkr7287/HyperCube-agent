import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = ".hypercube-asset.json";

export interface ModelAssetChecksum {
  algorithm: "sha256";
  value: string;
}

export interface ModelAssetManifest {
  version: number;
  verified: true;
  cachePath: string;
  preparedAt: string;
  mode: string;
  checksum?: ModelAssetChecksum;
  sizeBytes?: number;
}

export async function assertVerifiedModelCachePath(
  cacheRoot: string,
  sourcePath: string,
): Promise<void> {
  const resolved = await resolveExistingCachePath(cacheRoot, sourcePath);
  const manifest = await readManifest(resolved);
  if (!manifest.verified) {
    throw new Error(`model cache path is not verified: ${sourcePath}`);
  }
}

export async function resolveExistingCachePath(
  cacheRoot: string,
  candidate: string,
): Promise<string> {
  const resolved = resolveCachePath(cacheRoot, candidate);
  const rootReal = await fs.realpath(path.resolve(cacheRoot));
  let targetReal = "";
  try {
    targetReal = await fs.realpath(resolved);
  } catch {
    throw new Error(`model cache path does not exist: ${candidate}`);
  }
  if (!isPathInside(rootReal, targetReal)) {
    throw new Error(`model cache path escapes cache root: ${candidate}`);
  }
  return resolved;
}

export function resolveCachePath(cacheRoot: string, candidate: string): string {
  if (!candidate || candidate.trim().length === 0) {
    throw new Error("model cache path is required");
  }
  const root = path.resolve(cacheRoot);
  const resolved = path.resolve(candidate);
  if (!isPathInside(root, resolved)) {
    throw new Error(`model cache path must be under MODEL_CACHE_ROOT: ${candidate}`);
  }
  return resolved;
}

export function buildDefaultCachePath(
  cacheRoot: string,
  requestId: string,
  params: Record<string, unknown>,
): string {
  const modelId = asString(params.modelId) ?? asString(params.model) ?? "model";
  const version = asString(params.version) ?? asString(params.modelVersion) ?? "default";
  const fileName = asString(params.fileName) ?? asString(params.filename) ?? "asset.bin";
  return path.join(cacheRoot, sanitizePathSegment(modelId), sanitizePathSegment(version), sanitizePathSegment(fileName || requestId));
}

export function parseChecksum(params: Record<string, unknown>): ModelAssetChecksum | null {
  const checksum = params.checksum;
  const checksumRecord = typeof checksum === "object" && checksum !== null
    ? checksum as Record<string, unknown>
    : {};
  const algorithm =
    asString(checksumRecord.algorithm)?.toLowerCase() ??
    asString(params.checksumAlgorithm)?.toLowerCase() ??
    (params.sha256 || checksumRecord.sha256 || checksumRecord.value || asString(checksum) ? "sha256" : null);
  const value =
    asString(checksumRecord.value) ??
    asString(checksumRecord.sha256) ??
    asString(checksum) ??
    asString(params.sha256) ??
    asString(params.checksumSha256);

  if (!algorithm && !value) return null;
  if (algorithm !== "sha256") {
    throw new Error(`unsupported checksum algorithm: ${algorithm ?? "missing"}`);
  }
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("sha256 checksum must be a 64-character hex string");
  }
  return { algorithm: "sha256", value: value.toLowerCase() };
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function hashPath(candidate: string): Promise<{ sha256: string; sizeBytes: number }> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in model cache paths: ${candidate}`);
  }
  if (stat.isDirectory()) return await hashDirectory(candidate);
  if (!stat.isFile()) {
    throw new Error(`model cache path must be a file or directory: ${candidate}`);
  }
  return await hashFile(candidate);
}

export async function writeManifest(
  cachePath: string,
  manifest: Omit<ModelAssetManifest, "version" | "verified" | "cachePath" | "preparedAt">,
): Promise<ModelAssetManifest> {
  const full: ModelAssetManifest = {
    version: MANIFEST_VERSION,
    verified: true,
    cachePath,
    preparedAt: new Date().toISOString(),
    ...manifest,
  };
  const manifestPath = await getManifestPath(cachePath);
  await fs.writeFile(manifestPath, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  return full;
}

export async function readManifest(cachePath: string): Promise<ModelAssetManifest> {
  const manifestPath = await getManifestPath(cachePath);
  let raw = "";
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    throw new Error(`model cache path is missing verification manifest: ${cachePath}`);
  }
  const parsed = JSON.parse(raw) as Partial<ModelAssetManifest>;
  if (parsed.version !== MANIFEST_VERSION || parsed.verified !== true) {
    throw new Error(`model cache path has invalid verification manifest: ${cachePath}`);
  }
  return parsed as ModelAssetManifest;
}

export async function ensureCacheRoot(cacheRoot: string): Promise<void> {
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(cacheRoot, ".tmp"), { recursive: true, mode: 0o700 });
}

export function buildTempPath(cacheRoot: string, requestId: string): string {
  return path.join(cacheRoot, ".tmp", `${sanitizePathSegment(requestId)}-${Date.now()}.part`);
}

async function hashFile(candidate: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(candidate);
    stream.on("data", (chunk: string | Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      hash.update(bytes);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function hashDirectory(candidate: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const files = await listDirectoryFiles(candidate);
  for (const file of files) {
    const rel = path.relative(candidate, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    const fileHash = await hashFile(file);
    sizeBytes += fileHash.sizeBytes;
    hash.update(fileHash.sha256);
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function listDirectoryFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === MANIFEST_FILE) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed in model cache paths: ${full}`);
      }
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

async function getManifestPath(cachePath: string): Promise<string> {
  const stat = await fs.stat(cachePath);
  return stat.isDirectory() ? path.join(cachePath, MANIFEST_FILE) : `${cachePath}.${MANIFEST_FILE}`;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return sanitized.slice(0, 120) || "asset";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
