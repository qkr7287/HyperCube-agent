import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handlePrepareModelAssets } from "../handlers/prepare-model-assets.js";
import { handleQueryModelCache } from "../handlers/query-model-cache.js";
import type { AppConfig, CommandProgress, ProgressEmitter } from "../types/index.js";

const CONTENT = Buffer.from("hypercube-model-asset-payload-v1");
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");

let fetchCalls = 0;

// Stub global fetch so prepareBackendStream downloads a known payload without
// a real backend. Every call streams the same CONTENT buffer.
globalThis.fetch = (async (): Promise<Response> => {
  fetchCalls += 1;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(CONTENT));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-length": String(CONTENT.length) },
  });
}) as typeof fetch;

function backendStreamParams(): Record<string, unknown> {
  return {
    transferMode: "backend_stream",
    assets: [
      {
        versionId: "ver-1",
        assetSlug: "modelA",
        version: "v1",
        sha256: SHA256,
        sizeBytes: CONTENT.length,
        source: {
          type: "backend_stream",
          contentUrl: "http://backend.local/api/model-assets/1/content",
          auth: "agent_bearer",
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-model-cache-"));
  const config: AppConfig = {
    backendUrl: "http://backend.local/ws",
    backendApiUrl: "http://backend.local",
    agentHostname: "self-test-agent",
    collectInterval: 2,
    dockerSocket: "/var/run/docker.sock",
    advertiseIp: null,
    hostProcPath: "/proc",
    hostSysPath: "/sys",
    dcgmExporterUrl: null,
    gpuPerContainerEnabled: true,
    modelCacheRoot: cacheRoot,
    workspaceQuota: { enabled: false, mountRoot: "/var/lib/hypercube/workspaces" },
  };
  const targetDir = path.join(cacheRoot, "modelA", "v1");

  try {
    // --- Issue 1 + Issue 3: first prepare downloads and records bytesDone ---
    const progress: CommandProgress[] = [];
    const emit: ProgressEmitter = (p) =>
      progress.push({ type: "command_progress", requestId: "job-1", ...p });

    const first = await handlePrepareModelAssets(config, "tok", "job-1", backendStreamParams(), emit);
    assert.equal(fetchCalls, 1, "first prepare must download");
    assert.equal(first.cached, false, "first prepare is not a cache hit");
    assert.equal(first.sha256, SHA256);

    const byteEvents = progress.filter(
      (p) => typeof (p.data as { bytesDone?: unknown } | undefined)?.bytesDone === "number",
    );
    assert.ok(byteEvents.length > 0, "command_progress must carry data.bytesDone");
    const lastDownload = byteEvents[byteEvents.length - 1];
    assert.equal(
      (lastDownload.data as { bytesDone: number }).bytesDone,
      CONTENT.length,
      "final bytesDone equals payload size",
    );

    // --- Issue 1: second prepare of the same asset is an instant cache hit ---
    const second = await handlePrepareModelAssets(config, "tok", "job-1", backendStreamParams(), () => undefined);
    assert.equal(fetchCalls, 1, "second prepare must NOT re-download");
    assert.equal(second.cached, true, "second prepare is a cache hit");
    assert.equal(second.sha256, SHA256);

    // --- Issue 1 / incident c: empty leftover dir is re-prepared, not trusted ---
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    const recovered = await handlePrepareModelAssets(config, "tok", "job-1", backendStreamParams(), () => undefined);
    assert.equal(fetchCalls, 2, "empty leftover dir must trigger a re-download");
    assert.equal(recovered.cached, false);
    assert.equal(recovered.sha256, SHA256);

    // --- Issue 2: query_model_cache status판정 ---
    const ready = await handleQueryModelCache(config, { expectedCachePath: targetDir });
    assert.equal(ready.status, "ready", "prepared dir reports ready");

    const filePath = path.join(cacheRoot, "single.bin");
    await fs.writeFile(filePath, CONTENT);
    const readyFile = await handleQueryModelCache(config, {
      expectedCachePath: filePath,
      sha256: SHA256,
      sizeBytes: CONTENT.length,
    });
    assert.equal(readyFile.status, "ready");
    assert.equal(readyFile.sha256, SHA256);

    const missing = await handleQueryModelCache(config, {
      expectedCachePath: path.join(cacheRoot, "modelB", "v9"),
    });
    assert.equal(missing.status, "missing");
    assert.equal(missing.sha256, null);

    const partialPath = path.join(cacheRoot, "partial.bin");
    await fs.writeFile(partialPath, CONTENT.subarray(0, 5));
    const partial = await handleQueryModelCache(config, {
      expectedCachePath: partialPath,
      sha256: SHA256,
      sizeBytes: CONTENT.length,
    });
    assert.equal(partial.status, "partial", "truncated file reports partial");

    console.log("model-cache idempotency self-test passed");
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
