import type Dockerode from "dockerode";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createLogger } from "../logger.js";
import type { ProgressEmitter } from "../types/index.js";

const log = createLogger("handler:compose-up");

interface ComposeUpParams {
  projectName: string;
  composeYaml: string;
  env?: Record<string, string>;
  pull_if_missing?: boolean;
}

export async function handleComposeUp(
  docker: Dockerode,
  params: Record<string, unknown>,
  emitProgress: ProgressEmitter,
): Promise<Record<string, unknown>> {
  const p = params as unknown as ComposeUpParams;
  if (!p.projectName) throw new Error("projectName is required");
  if (!p.composeYaml) throw new Error("composeYaml is required");

  log.info(`Compose up: project=${p.projectName}`);

  const tmpPath = join(tmpdir(), `compose-${randomBytes(8).toString("hex")}.yaml`);
  await fs.writeFile(tmpPath, p.composeYaml, "utf-8");

  try {
    emitProgress({
      step: "pulling_image",
      percent: null,
      message: `Compose up starting: ${p.projectName}`,
      context: { projectName: p.projectName },
    });

    const args = ["compose", "-p", p.projectName, "-f", tmpPath, "up", "-d"];
    if (p.pull_if_missing !== false) args.push("--pull", "missing");

    const env: NodeJS.ProcessEnv = { ...process.env, ...(p.env ?? {}) };

    await runCommand("docker", args, env, (line) => {
      emitProgress({
        step: detectStep(line),
        percent: null,
        message: line.slice(0, 240),
        context: { projectName: p.projectName },
      });
    });

    // enumerate containers via label com.docker.compose.project
    const list = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${p.projectName}`] },
    });

    return {
      projectName: p.projectName,
      containers: list.map((c) => ({
        containerId: c.Id,
        name: c.Names[0]?.replace(/^\//, "") ?? "",
        image: c.Image,
        state: c.State,
      })),
    };
  } catch (err) {
    throw new Error(`compose up failed: ${(err as Error).message}`);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

function detectStep(line: string): "pulling_image" | "creating" | "starting" {
  const l = line.toLowerCase();
  if (l.includes("pull")) return "pulling_image";
  if (l.includes("start")) return "starting";
  return "creating";
}

function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env });
    const stderr: string[] = [];

    const handleChunk = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine(line.trim());
      }
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", (chunk: Buffer) => {
      handleChunk(chunk);
      stderr.push(chunk.toString("utf-8"));
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.join("").trim() || `exit code ${code}`));
    });
  });
}
