// Docker container lifecycle for vanilla-chromium-novnc sessions.

import Docker from "dockerode";
import { CHROME_IMAGE, CONTAINER_LABEL, CONTAINER_PROFILE_LABEL, DOCKER_SOCKET } from "./config.js";
import { log } from "./log.js";

const docker = new Docker(DOCKER_SOCKET ? { socketPath: DOCKER_SOCKET } : undefined);

export interface SpawnedContainer {
  id: string;
  cdpPort: number;
  novncPort: number;
}

export interface SpawnOptions {
  profile: string;
  hostProfileDir: string;
}

// Spawn a fresh container with the profile dir bind-mounted at /profile.
// Returns the container id and the host ports CDP / noVNC were published to.
export async function spawn(opts: SpawnOptions): Promise<SpawnedContainer> {
  // Make sure the image is present locally. Pulling it would be a no-op
  // for our self-built image — just log and continue if missing.
  try {
    await docker.getImage(CHROME_IMAGE).inspect();
  } catch {
    throw new Error(
      `Image ${CHROME_IMAGE} not found locally. Run: npm run docker:build`,
    );
  }

  const [labelKey, labelVal] = CONTAINER_LABEL.split("=");
  const c = await docker.createContainer({
    Image: CHROME_IMAGE,
    Labels: {
      [labelKey!]: labelVal!,
      [CONTAINER_PROFILE_LABEL]: opts.profile,
    },
    HostConfig: {
      // Let Docker pick free host ports
      PublishAllPorts: false,
      PortBindings: {
        "9223/tcp": [{ HostPort: "" }],
        "6080/tcp": [{ HostPort: "" }],
      },
      Binds: [`${opts.hostProfileDir}:/profile`],
      // SHM is small by default; Chromium wants more.
      ShmSize: 1024 * 1024 * 1024, // 1 GB
      AutoRemove: false,
    },
    ExposedPorts: {
      "9223/tcp": {},
      "6080/tcp": {},
    },
  });
  await c.start();

  const info = await c.inspect();
  const cdpPort = parseInt(info.NetworkSettings.Ports?.["9223/tcp"]?.[0]?.HostPort ?? "0", 10);
  const novncPort = parseInt(info.NetworkSettings.Ports?.["6080/tcp"]?.[0]?.HostPort ?? "0", 10);
  if (!cdpPort || !novncPort) {
    throw new Error(`Container started but ports not published (cdp=${cdpPort}, novnc=${novncPort})`);
  }

  log.info("container spawned", { id: c.id.slice(0, 12), profile: opts.profile, cdpPort, novncPort });
  return { id: c.id, cdpPort, novncPort };
}

// Stop + remove a container. Graceful stop (chrome flushes cookies).
export async function stop(id: string, graceSeconds = 10): Promise<void> {
  const c = docker.getContainer(id);
  try {
    await c.stop({ t: graceSeconds });
  } catch (e) {
    // Already stopped or doesn't exist
    log.debug("container stop error (continuing)", { id: id.slice(0, 12), err: String(e) });
  }
  try {
    await c.remove({ force: true });
  } catch (e) {
    log.debug("container remove error (continuing)", { id: id.slice(0, 12), err: String(e) });
  }
}

// List orphan containers we spawned in a past run (matched by label).
export async function listManagedContainers(): Promise<{ id: string; profile: string }[]> {
  const [labelKey, labelVal] = CONTAINER_LABEL.split("=");
  const filters = { label: [`${labelKey}=${labelVal}`] };
  const list = await docker.listContainers({ all: true, filters: filters as never });
  return list.map((c) => ({
    id: c.Id,
    profile: c.Labels?.[CONTAINER_PROFILE_LABEL] ?? "(unknown)",
  }));
}

// Wait until the container's CDP endpoint responds. Returns the webSocketDebuggerUrl.
// 30s is generous — Xvnc + fluxbox + websockify + wmctrl-watcher + chromium startup
// on a cold image pull or a busy host can creep past the previous 15s budget.
export async function waitForCdpReady(cdpPort: number, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (r.ok) {
        const { webSocketDebuggerUrl } = (await r.json()) as { webSocketDebuggerUrl: string };
        // Chromium binds to 0.0.0.0 inside the container, so the returned URL
        // uses the container hostname. Rewrite to localhost:<published port>.
        return webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${cdpPort}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome CDP not ready on :${cdpPort} after ${timeoutMs}ms (last: ${String(lastErr)})`);
}
