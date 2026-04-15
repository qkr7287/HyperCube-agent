import type Dockerode from "dockerode";
import { spawn } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger("handler:compose-down");

interface ComposeDownParams {
  projectName: string;
  removeVolumes?: boolean;
  removeImages?: boolean;
}

export async function handleComposeDown(
  docker: Dockerode,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const p = params as unknown as ComposeDownParams;
  if (!p.projectName) throw new Error("projectName is required");

  log.info(`Compose down: project=${p.projectName}`);

  // snapshot container ids before down
  const before = await docker.listContainers({
    all: true,
    filters: { label: [`com.docker.compose.project=${p.projectName}`] },
  });
  const removedContainerIds = before.map((c) => c.Id);

  const args = ["compose", "-p", p.projectName, "down"];
  if (p.removeVolumes) args.push("-v");
  if (p.removeImages) args.push("--rmi", "all");

  try {
    await runCommand("docker", args);
  } catch (err) {
    throw new Error(`compose down failed: ${(err as Error).message}`);
  }

  return { projectName: p.projectName, removedContainerIds };
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const stderr: string[] = [];

    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf-8")));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.join("").trim() || `exit code ${code}`));
    });
  });
}
