import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useParams,
} from "react-router-dom";
import { Providers } from "@/components/Providers";
import { Workspace } from "@/components/workspace/Workspace";
import {
  projectRoute,
  taskRoute,
  type WorkspaceParams,
} from "@/lib/routes";

// SPA router. Replaces the Next App Router file tree. Routing is query-param
// driven (see src/lib/routes.ts), so there are only three real page shapes plus
// redirect-only legacy deep links.
//
// The old src/app/layout.tsx wrapped every page in <Providers> (which renders
// WorkspaceProvider > AppShell > children). Here a layout route does the same:
// <Providers> renders the chrome and <Outlet/> takes the place of `children`.

function Layout() {
  return (
    <Providers>
      <Outlet />
    </Providers>
  );
}

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

// react-router already URL-decodes path params, so (unlike the old Next pages,
// which decoded manually) we pass them straight through.
function ProjectPage() {
  const { slug } = useParams();
  return <Workspace projectSlug={slug!} />;
}

function TaskPage() {
  const { slug, taskSlug } = useParams();
  return <Workspace projectSlug={slug!} taskSlug={taskSlug!} />;
}

// Legacy deep links collapse onto the canonical project/task route with the
// path carried as a query param, matching the old redirect-only pages. The
// splat ("*") is the catch-all `[...path]` segment.
function legacyRedirect(
  base: string,
  key: "artifact" | "dir" | "chat",
  value: string,
) {
  const params: WorkspaceParams =
    key === "artifact"
      ? {
          artifact: value,
          dir: value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : undefined,
        }
      : key === "dir"
        ? { dir: value }
        : { chat: value };
  return <Navigate to={base + queryFor(params)} replace />;
}

function queryFor(params: WorkspaceParams): string {
  // Reuse the canonical query builder by routing through the helpers.
  return projectRoute("__x__", params).replace(`/project/${encodeURIComponent("__x__")}`, "");
}

function FileRedirect() {
  const { slug, taskSlug, "*": splat } = useParams();
  const base = taskSlug ? taskRoute(slug!, taskSlug) : projectRoute(slug!);
  return legacyRedirect(base, "artifact", splat ?? "");
}

function DirRedirect() {
  const { slug, taskSlug, "*": splat } = useParams();
  const base = taskSlug ? taskRoute(slug!, taskSlug) : projectRoute(slug!);
  return legacyRedirect(base, "dir", splat ?? "");
}

function SessionRedirect() {
  const { slug, taskSlug, sessionId } = useParams();
  const base = taskSlug ? taskRoute(slug!, taskSlug) : projectRoute(slug!);
  return legacyRedirect(base, "chat", sessionId ?? "");
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Welcome />} />
          <Route path="/project/:slug" element={<ProjectPage />} />
          <Route path="/project/:slug/task/:taskSlug" element={<TaskPage />} />

          {/* redirect-only legacy deep links */}
          <Route path="/project/:slug/file/*" element={<FileRedirect />} />
          <Route path="/project/:slug/dir/*" element={<DirRedirect />} />
          <Route path="/project/:slug/session/:sessionId" element={<SessionRedirect />} />
          <Route path="/project/:slug/task/:taskSlug/file/*" element={<FileRedirect />} />
          <Route path="/project/:slug/task/:taskSlug/dir/*" element={<DirRedirect />} />
          <Route
            path="/project/:slug/task/:taskSlug/session/:sessionId"
            element={<SessionRedirect />}
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
