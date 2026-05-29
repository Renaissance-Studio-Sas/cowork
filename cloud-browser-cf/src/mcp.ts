// The remote MCP server. McpAgent is itself a Durable Object; the authenticated
// Google user arrives in `this.props`. Every tool is scoped to that user — it
// can only ever touch its own profiles/sessions (the DO id and R2 keys are
// derived from props.userId, so cross-user access is impossible by construction).

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UserProps } from "./types";
import { sessionKey, profileKey, LIMITS } from "./types";

// Driving tools forwarded verbatim to the in-container agent.
// Each maps to POST /<tool> on the container's agent.
const DRIVING_TOOLS: Record<string, z.ZodRawShape> = {
  browser_navigate: { url: z.string() },
  browser_read_page: { max_chars: z.number().optional() },
  browser_screenshot: { full_page: z.boolean().optional() },
  browser_click: { selector: z.string() },
  browser_click_xy: { x: z.number(), y: z.number() },
  browser_fill: { selector: z.string(), text: z.string() },
  browser_extract: { selector: z.string() },
  browser_type: { text: z.string(), submit: z.boolean().optional() },
  browser_press: { key: z.string() },
  browser_scroll: { dy: z.number() },
  browser_get_url: {},
  browser_list_tabs: {},
  browser_open_tab: { url: z.string().optional() },
  browser_switch_tab: { index: z.number() },
  browser_evaluate: { expression: z.string() },
  browser_request_human: { reason: z.string() },
};

export class BrowserMcp extends McpAgent<Env, unknown, UserProps> {
  server = new McpServer({ name: "cloud-browser", version: "0.1.0" });

  private get userId(): string {
    return this.props!.userId;
  }

  // Resolve the per-(user,profile) container controller DO. Unguessable across
  // users; one live browser per (user, profile).
  private sessionStub(profile: string) {
    const id = this.env.BROWSER_SESSION.idFromName(sessionKey(this.userId, profile));
    return this.env.BROWSER_SESSION.get(id);
  }

  // Call the container's in-container agent for `profile` via its controller DO.
  private async drive(profile: string, op: string, args: unknown) {
    const res = await this.sessionStub(profile).fetch(`https://do/agent/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: this.userId, args }),
    });
    return res;
  }

  async init() {
    // ── Management tools ────────────────────────────────────────────────
    (this.server.tool as any)(
      "list_profiles",
      "List your reusable browser profiles (persistent logins).",
      {},
      async () => {
        const list = await this.env.PROFILES.list({ prefix: `${this.userId}/` });
        const names = list.objects.map((o) => o.key.split("/")[1]).filter(Boolean);
        return { content: [{ type: "text", text: names.length ? names.join("\n") : "(no profiles yet)" }] };
      },
    );

    (this.server.tool as any)(
      "acquire_session",
      "Start (or reuse) a browser for a profile. Spawns a Chromium container, hydrates the profile from R2, returns a session handle. One live session per profile.",
      { profile: z.string() },
      async ({ profile }: { profile: string }) => {
        const res = await this.sessionStub(profile).fetch("https://do/acquire", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: this.userId, profile, limits: LIMITS }),
        });
        return { content: [{ type: "text", text: await res.text() }], isError: !res.ok };
      },
    );

    (this.server.tool as any)(
      "live_view_url",
      "Get a signed, short-lived URL to watch the live browser (and hand off 2FA).",
      { profile: z.string() },
      async ({ profile }: { profile: string }) => {
        const res = await this.sessionStub(profile).fetch("https://do/live-view-url", { method: "POST" });
        return { content: [{ type: "text", text: await res.text() }] };
      },
    );

    (this.server.tool as any)(
      "release_session",
      "Stop the browser for a profile (saves login state back to R2, then tears down the container).",
      { profile: z.string() },
      async ({ profile }: { profile: string }) => {
        const res = await this.sessionStub(profile).fetch("https://do/release", { method: "POST" });
        return { content: [{ type: "text", text: await res.text() }] };
      },
    );

    // ── Driving tools (forwarded to the in-container agent) ─────────────
    // All require a `profile` so we know which container to talk to.
    for (const [name, shape] of Object.entries(DRIVING_TOOLS)) {
      (this.server.tool as any)(name, `Browser: ${name.replace("browser_", "")} (on a profile's live session).`,
        { profile: z.string(), ...shape },
        async ({ profile, ...args }: { profile: string; [k: string]: unknown }) => {
          const res = await this.drive(profile, name.replace("browser_", ""), args);
          const text = await res.text();
          // screenshot returns an image; the agent base64-encodes it with a marker
          return { content: [{ type: "text", text }], isError: !res.ok };
        },
      );
    }
  }
}
