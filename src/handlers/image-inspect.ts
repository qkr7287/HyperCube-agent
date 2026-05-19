import type Dockerode from "dockerode";
import { createLogger } from "../logger.js";

const log = createLogger("handler:image-inspect");

export async function handleImageInspect(
  docker: Dockerode,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const image = typeof params.image === "string" ? params.image.trim() : "";
  if (!image) throw new Error("image is required");

  log.info(`Inspecting image ${image}`);

  try {
    const info = await docker.getImage(image).inspect();
    const repoTags = Array.isArray(info.RepoTags) ? info.RepoTags : [];
    return {
      image,
      present: true,
      imageId: info.Id,
      repoTags,
      source: classifyImageSource(repoTags),
    };
  } catch (err) {
    if (isDockerNotFound(err)) {
      return {
        image,
        present: false,
        imageId: null,
        repoTags: [],
        source: "unknown",
      };
    }
    throw err;
  }
}

function classifyImageSource(repoTags: string[]): "local" | "internal_registry" | "unknown" {
  if (repoTags.length === 0 || repoTags.every((tag) => tag === "<none>:<none>")) {
    return "local";
  }

  for (const tag of repoTags) {
    const host = parseRegistryHost(tag);
    if (host && isInternalRegistryHost(host)) return "internal_registry";
  }

  return "local";
}

function parseRegistryHost(tag: string): string | null {
  const first = tag.split("/")[0];
  if (!first || first === tag) return null;
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") return null;
  return first.toLowerCase();
}

function isInternalRegistryHost(host: string): boolean {
  if (host === "localhost" || host.startsWith("127.") || host === "[::1]") return true;
  const withoutPort = host.replace(/:\d+$/, "");
  if (/^10\./.test(withoutPort)) return true;
  if (/^192\.168\./.test(withoutPort)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(withoutPort)) return true;
  if (withoutPort.endsWith(".local") || withoutPort.endsWith(".internal")) return true;
  return host.includes(":");
}

function isDockerNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; reason?: string; message?: string };
  return e.statusCode === 404 || /no such image|not found/i.test(e.reason ?? e.message ?? "");
}
