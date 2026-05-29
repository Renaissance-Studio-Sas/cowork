// Per-(user,profile) container controller. Owns ONE Chromium container and is
// the only thing allowed to talk to it. Responsibilities:
//   - ownership: records the userId that acquired it; rejects anyone else
//   - profile persistence: hydrate from R2 on acquire, save to R2 on release/idle
//     (R2 creds live here in the Worker/DO — never in the container)
//   - lifecycle: the @cloudflare/containers helper starts the container on first
//     containerFetch; we save-then-stop on release and on the idle alarm
//   - live view: mints a signed, short-lived URL to the noVNC port

import { Container } from "@cloudflare/containers";
import { profileKey } from "./types";

const AGENT_PORT = 8080; // in-container Node agent (Playwright over localhost CDP)
const NOVNC_PORT = 6080; // live view
const IDLE_MS = 20 * 60 * 1000;

export class BrowserSession extends Container<Env> {
  defaultPort = AGENT_PORT;
  sleepAfter = "20m";

  // Persisted across DO hibernation via DO storage.
  private async owner(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("userId")) ?? null;
  }
  private async assertOwner(userId: string) {
    const o = await this.owner();
    if (o && o !== userId) throw new Error("forbidden: not your session");
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/acquire") return await this.acquire(req);
      if (path === "/release") return await this.release();
      if (path === "/live-view-url") return await this.liveViewUrl();
      if (path.startsWith("/agent/")) return await this.agent(path.slice("/agent/".length), req);
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
    }
  }

  private async acquire(req: Request): Promise<Response> {
    const { userId, profile } = (await req.json()) as { userId: string; profile: string };
    await this.assertOwner(userId);
    await this.ctx.storage.put("userId", userId);
    await this.ctx.storage.put("profile", profile);

    // Hydrate the profile from R2 → push the tarball into the container, which
    // unpacks it into /profile before Chromium reads it. (R2 streams have no known
    // length for the local runtime, so buffer it.)
    const obj = await this.env.PROFILES.get(profileKey(userId, profile));
    if (obj) {
      const body = await obj.arrayBuffer();
      await this.containerFetch(new Request("https://c/hydrate", { method: "POST", body }), AGENT_PORT);
    }
    // Wait until the in-container agent reports the browser is actually ready
    // (Chromium bound + CDP reachable) — otherwise the first driving op races
    // the cold start and fails. This also starts the container if it's cold.
    await this.waitReady();
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return Response.json({ ok: true, profile });
  }

  // Poll the in-container agent's /health until the browser is ready (or time out).
  private async waitReady(tries = 60, gapMs = 500) {
    for (let i = 0; i < tries; i++) {
      const h = await this.containerFetch(new Request("https://c/health"), AGENT_PORT).catch(() => null);
      if (h && h.ok) return;
      await new Promise((r) => setTimeout(r, gapMs));
    }
    throw new Error("browser did not become ready in time");
  }

  // Forward a driving op to the in-container agent, ownership-checked.
  private async agent(op: string, req: Request): Promise<Response> {
    const { userId, args } = (await req.json()) as { userId: string; args: unknown };
    await this.assertOwner(userId);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS); // keep alive while used
    return this.containerFetch(
      new Request(`https://c/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }),
      AGENT_PORT,
    );
  }

  private async saveProfile() {
    const userId = await this.owner();
    const profile = await this.ctx.storage.get<string>("profile");
    if (!userId || !profile) return;
    // Ask the agent for the cache-filtered profile tarball, write it to R2.
    // Buffer first: R2.put needs a known content length (streams aren't accepted
    // by the local runtime, and it keeps the write atomic).
    const res = await this.containerFetch(new Request("https://c/save"), AGENT_PORT).catch(() => null);
    if (res?.ok) {
      const body = await res.arrayBuffer();
      if (body.byteLength > 0) await this.env.PROFILES.put(profileKey(userId, profile), body);
    }
  }

  private async release(): Promise<Response> {
    await this.saveProfile();
    await this.ctx.storage.deleteAlarm();
    await this.stop(); // Container helper: stop the instance
    return Response.json({ ok: true });
  }

  // Idle reclaim.
  async alarm() {
    await this.saveProfile();
    await this.stop();
  }

  // Save login state if the container stops for any reason.
  override async onStop() {
    await this.saveProfile();
  }

  private async liveViewUrl(): Promise<Response> {
    // Sign a short-lived, owner-scoped token; the Worker's /view route verifies
    // it and proxies to the container's noVNC port. (HMAC with COOKIE_ENCRYPTION_KEY.)
    const profile = await this.ctx.storage.get<string>("profile");
    // TODO: mint HMAC token (exp + sessionKey) and return `${origin}/view?t=...`.
    return Response.json({ url: `/view?profile=${profile}&port=${NOVNC_PORT}`, note: "TODO: sign token" });
  }
}
