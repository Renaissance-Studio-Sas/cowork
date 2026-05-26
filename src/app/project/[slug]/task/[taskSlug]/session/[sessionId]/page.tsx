"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { taskRoute } from "@/lib/routes";

// Legacy deep link — redirect into the unified task workspace with the
// session expanded as the chat column.
export default function TaskSessionRedirect() {
  const params = useParams();
  const router = useRouter();
  const projectSlug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);
  const sessionId = decodeURIComponent(params.sessionId as string);

  useEffect(() => {
    router.replace(taskRoute(projectSlug, taskSlug, { chat: sessionId }));
  }, [router, projectSlug, taskSlug, sessionId]);

  return (
    <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
      Loading…
    </div>
  );
}
