"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { projectRoute } from "@/lib/routes";

// Legacy deep link — redirect into the unified project workspace with the
// session expanded as the chat column.
export default function ProjectSessionRedirect() {
  const params = useParams();
  const router = useRouter();
  const projectSlug = decodeURIComponent(params.slug as string);
  const sessionId = decodeURIComponent(params.sessionId as string);

  useEffect(() => {
    router.replace(projectRoute(projectSlug, { chat: sessionId }));
  }, [router, projectSlug, sessionId]);

  return (
    <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
      Loading…
    </div>
  );
}
