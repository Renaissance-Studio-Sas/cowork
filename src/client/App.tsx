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
  buildWorkspaceQuery,
  decodeWorkspacePath,
  encodeWorkspacePath,
  type WorkspaceParams,
} from "@/lib/routes";

// SPA router. Routing is query-param driven (see src/lib/routes.ts) so the
// canonical app has exactly two shapes: Welcome at `/` and the workspace page
// at `/workspace/<slug>/<child>/...`. Path segments are URL-encoded individually
// and matched by a single splat (`*`), so deeply-nested workspaces all hit the
// same component.
//
// Legacy `/project/...` and `/project/:slug/task/...` deep links are preserved
// as redirect-only routes so old links don't 404 — they 301 to the equivalent
// `/workspace/...` URL.

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
          Pick a workspace on the left to brief an agent on it. They&apos;ll work
          in the background and ping you when they need input.
        </div>
      </div>
    </div>
  );
}

// react-router URL-decodes path params for us, but the splat is returned
// pre-decoded as a slash-joined string. decodeWorkspacePath splits it back
// into the slug-chain expected by the Workspace component.
function WorkspacePage() {
  const params = useParams<{ "*": string }>();
  const workspacePath = decodeWorkspacePath(params["*"] ?? "");
  return <Workspace workspacePath={workspacePath} />;
}

// Legacy deep-link redirects collapse the (project[, task][, file/dir/session])
// segments onto a `/workspace/<chain>` URL with the file/dir/session carried
// as a query param.

function buildLegacyRedirect(
  slugPath: string[],
  key: "artifact" | "dir" | "chat",
  value: string,
): string {
  const params: WorkspaceParams =
    key === "artifact"
      ? {
          artifact: value,
          dir: value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : undefined,
        }
      : key === "dir"
        ? { dir: value }
        : { chat: value };
  return `/workspace/${encodeWorkspacePath(slugPath)}${buildWorkspaceQuery(params)}`;
}

function ProjectRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/workspace/${encodeWorkspacePath([slug!])}`} replace />;
}

function TaskRedirect() {
  const { slug, taskSlug } = useParams<{ slug: string; taskSlug: string }>();
  return <Navigate to={`/workspace/${encodeWorkspacePath([slug!, taskSlug!])}`} replace />;
}

function FileRedirect() {
  const { slug, taskSlug, "*": splat } = useParams<{ slug: string; taskSlug?: string; "*": string }>();
  const chain = taskSlug ? [slug!, taskSlug] : [slug!];
  return <Navigate to={buildLegacyRedirect(chain, "artifact", splat ?? "")} replace />;
}

function DirRedirect() {
  const { slug, taskSlug, "*": splat } = useParams<{ slug: string; taskSlug?: string; "*": string }>();
  const chain = taskSlug ? [slug!, taskSlug] : [slug!];
  return <Navigate to={buildLegacyRedirect(chain, "dir", splat ?? "")} replace />;
}

function SessionRedirect() {
  const { slug, taskSlug, sessionId } = useParams<{ slug: string; taskSlug?: string; sessionId: string }>();
  const chain = taskSlug ? [slug!, taskSlug] : [slug!];
  return <Navigate to={buildLegacyRedirect(chain, "chat", sessionId ?? "")} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Welcome />} />
          {/* Canonical workspace page — splat captures the entire slug-chain. */}
          <Route path="/workspace/*" element={<WorkspacePage />} />

          {/* Legacy /project/... deep links → /workspace/... */}
          <Route path="/project/:slug/file/*" element={<FileRedirect />} />
          <Route path="/project/:slug/dir/*" element={<DirRedirect />} />
          <Route path="/project/:slug/session/:sessionId" element={<SessionRedirect />} />
          <Route path="/project/:slug/task/:taskSlug/file/*" element={<FileRedirect />} />
          <Route path="/project/:slug/task/:taskSlug/dir/*" element={<DirRedirect />} />
          <Route
            path="/project/:slug/task/:taskSlug/session/:sessionId"
            element={<SessionRedirect />}
          />
          <Route path="/project/:slug/task/:taskSlug" element={<TaskRedirect />} />
          <Route path="/project/:slug" element={<ProjectRedirect />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
