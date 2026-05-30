// Compatibility shim: exposes the slice of the Next.js `next/navigation` +
// `next/link` API that this app actually used, backed by react-router. This lets
// the ported components keep their existing call sites (useRouter().push(...),
// useSearchParams().get(...), <Link href=...>) with only an import-path change,
// instead of rewriting navigation logic across ~9 files.
//
// Migrated from Next's App Router during the Hono+Vite move. See MIGRATION.md.
import { forwardRef } from "react";
import {
  Link as RRLink,
  useLocation,
  useNavigate,
  useParams as useRRParams,
  useSearchParams as useRRSearchParams,
  type LinkProps as RRLinkProps,
} from "react-router-dom";

// next/navigation's useRouter() surface. `scroll` is accepted and ignored
// (react-router handles scroll restoration separately). `refresh()` re-runs
// server components in Next; in this SPA all data is client-fetched / SSE-driven,
// so it's a no-op — kept so call sites don't need to change.
export interface AppRouter {
  push: (href: string, opts?: { scroll?: boolean }) => void;
  replace: (href: string, opts?: { scroll?: boolean }) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: () => void;
}

export function useRouter(): AppRouter {
  const navigate = useNavigate();
  return {
    push: (href) => navigate(href),
    replace: (href) => navigate(href, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: () => {},
    prefetch: () => {},
  };
}

export function usePathname(): string {
  return useLocation().pathname;
}

// Next returns a ReadonlyURLSearchParams directly; react-router returns a
// [params, setParams] tuple. Return just the params to match Next's call sites
// (which only ever read via .get()).
export function useSearchParams(): URLSearchParams {
  const [params] = useRRSearchParams();
  return params;
}

// Next's useParams() returns decoded string | string[] values; react-router's
// returns string | undefined. The shape is close enough for our call sites,
// which read `params.slug`, `params.taskSlug`, etc.
export function useParams(): Record<string, string | string[] | undefined> {
  return useRRParams() as Record<string, string | string[] | undefined>;
}

// next/link's <Link href=...> → react-router's <Link to=...>. Forward refs and
// pass through the rest of the props (className, children, onClick, …).
type NextLinkProps = Omit<RRLinkProps, "to"> & { href: string; prefetch?: boolean };

export const Link = forwardRef<HTMLAnchorElement, NextLinkProps>(function Link(
  { href, prefetch: _prefetch, ...rest },
  ref,
) {
  return <RRLink ref={ref} to={href} {...rest} />;
});
