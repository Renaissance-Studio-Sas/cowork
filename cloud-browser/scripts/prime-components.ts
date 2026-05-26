// Refresh SHARED_COMPONENTS_DIR with the latest Chrome downloadable component
// caches by running a one-shot container with the same bind mount setup as a
// normal session. Chromium's component_updater fires ~60s after start; we
// give it a few minutes to download and let chrome write straight through
// entrypoint.sh's /profile/<name> → /opt/chrome-shared/<name> symlinks into
// the host shared folder.
//
// Note: this is purely a refresh tool. Normal usage doesn't need it — the
// first real session that navigates to live pages self-primes the shared
// folder. Re-run this script when you want to refresh stale components
// (every few weeks, or when an MCP user reports stale Widevine / safety
// lists / etc.).

import { execSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CHROME_IMAGE,
  SHARED_COMPONENTS_DIR,
} from "../src/config.js";

const WAIT_SECONDS = Number(process.env.PRIME_WAIT_SECONDS ?? 180);
// component_updater only fires for components the renderer asks for, so an
// idle about:blank session doesn't trigger downloads. Visiting a real page
// pulls in the SafeBrowsing / OptimizationHints / etc. components.
const SEED_URL = process.env.PRIME_SEED_URL ?? "https://www.google.com/";

function sh(cmd: string, opts: { silent?: boolean } = {}): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: opts.silent ? "pipe" : ["pipe", "pipe", "inherit"],
  }).trim();
}

async function main() {
  await fsp.mkdir(SHARED_COMPONENTS_DIR, { recursive: true });

  const tmpProfile = await fsp.mkdtemp(path.join(os.tmpdir(), "cbprime-"));
  console.log(`prime-components: temp /profile     ${tmpProfile}`);
  console.log(`prime-components: image             ${CHROME_IMAGE}`);
  console.log(`prime-components: shared folder     ${SHARED_COMPONENTS_DIR}`);
  console.log(`prime-components: seed URL          ${SEED_URL}`);

  // Same bind layout as a real session: chrome writes the component caches
  // through symlinks into /opt/chrome-shared, which lands in our shared host
  // folder. /profile is a throwaway scratch dir we delete at the end — we
  // don't want any cookies/login state from this run polluting profiles.
  console.log(`prime-components: spawning chromium for ${WAIT_SECONDS}s …`);
  const cid = sh(
    `docker run -d --rm --shm-size=1g ` +
      `-v "${tmpProfile}:/profile" ` +
      `-v "${SHARED_COMPONENTS_DIR}:/opt/chrome-shared" ` +
      `-p 0:9223 ` +
      `${CHROME_IMAGE}`,
    { silent: true },
  );
  console.log(`prime-components: container ${cid.slice(0, 12)}`);

  try {
    // Resolve the CDP port we got from docker and ask chromium to navigate
    // to a real page (about:blank wouldn't trigger most component fetches).
    const portMap = sh(`docker port ${cid} 9223/tcp`, { silent: true });
    const m = /:(\d+)\s*$/m.exec(portMap);
    const cdpPort = m ? Number(m[1]) : 0;
    if (cdpPort > 0) {
      // Wait for CDP to come up before posting a navigation. ~30s budget.
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
          if (r.ok) break;
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      // Open the seed URL via the /json/new endpoint (HTTP API).
      try {
        await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(SEED_URL)}`, {
          method: "PUT",
        });
        console.log(`prime-components: navigated to ${SEED_URL}`);
      } catch (e) {
        console.warn(`prime-components: navigation failed (will still wait):`, String(e));
      }
    } else {
      console.warn(`prime-components: could not resolve CDP port; relying on idle session`);
    }

    await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));
  } finally {
    console.log(`prime-components: stopping container …`);
    try {
      sh(`docker stop -t 10 ${cid}`, { silent: true });
    } catch { /* already stopped */ }
  }

  await fsp.rm(tmpProfile, { recursive: true, force: true });

  const total = sh(`du -sh "${SHARED_COMPONENTS_DIR}"`, { silent: true }).split(/\s+/)[0] ?? "?";
  console.log(`prime-components: done. ${total} at ${SHARED_COMPONENTS_DIR}`);
}

main().catch((e) => {
  console.error("prime-components: fatal", e);
  process.exit(1);
});
