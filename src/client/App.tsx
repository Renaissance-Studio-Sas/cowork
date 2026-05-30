import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from "react-router-dom";

// SPA router. Replaces the Next App Router file tree. Routing is query-param
// driven (see src/lib/routes.ts), so there are only three real page shapes plus
// redirect-only legacy deep links.
//
// Phase 1 wires the real screens in here, e.g.:
//   import { Providers } from "@/components/Providers";
//   import { Workspace } from "@/components/workspace/Workspace";
// For now this is a placeholder shell that proves the build + routing path.

function Welcome() {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="text-[28px] font-semibold mb-2">Welcome.</div>
        <div className="text-[15px] text-[var(--text-soft)] leading-relaxed">
          Pick a task on the left to brief an agent on it. They&apos;ll work in the
          background and ping you when they need input.
        </div>
      </div>
    </div>
  );
}

// Legacy deep links collapse onto the canonical project/task route with the
// path carried as a query param, matching the old redirect-only pages.
function LegacyFileRedirect({ kind }: { kind: "file" | "dir" }) {
  const params = useParams();
  const splat = params["*"] ?? "";
  const base = params.taskSlug
    ? `/project/${params.slug}/task/${params.taskSlug}`
    : `/project/${params.slug}`;
  const key = kind === "file" ? "artifact" : "dir";
  return <Navigate to={`${base}?${key}=${encodeURIComponent(splat)}`} replace />;
}

function SessionRedirect() {
  const params = useParams();
  const base = params.taskSlug
    ? `/project/${params.slug}/task/${params.taskSlug}`
    : `/project/${params.slug}`;
  return <Navigate to={`${base}?chat=${encodeURIComponent(params.sessionId ?? "")}`} replace />;
}

// TODO(phase1): replace with the real Workspace screen + <Providers> shell.
function WorkspacePlaceholder() {
  const { pathname, search } = useLocation();
  return (
    <div className="p-6 text-sm text-[var(--text-soft)]">
      Workspace route mounted: <code>{pathname}{search}</code> (Phase 1 wires the real UI)
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/project/:slug" element={<WorkspacePlaceholder />} />
        <Route path="/project/:slug/task/:taskSlug" element={<WorkspacePlaceholder />} />

        {/* redirect-only legacy deep links */}
        <Route path="/project/:slug/file/*" element={<LegacyFileRedirect kind="file" />} />
        <Route path="/project/:slug/dir/*" element={<LegacyFileRedirect kind="dir" />} />
        <Route path="/project/:slug/session/:sessionId" element={<SessionRedirect />} />
        <Route path="/project/:slug/task/:taskSlug/file/*" element={<LegacyFileRedirect kind="file" />} />
        <Route path="/project/:slug/task/:taskSlug/dir/*" element={<LegacyFileRedirect kind="dir" />} />
        <Route path="/project/:slug/task/:taskSlug/session/:sessionId" element={<SessionRedirect />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
