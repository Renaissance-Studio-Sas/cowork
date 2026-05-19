"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, usePathname } from "next/navigation";
import { Chat } from "@/components/Chat";
import { useWorkspace } from "@/lib/workspace-context";
import { taskRoute, saveTaskPath } from "@/lib/routes";

export default function TaskSessionPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const projectSlug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);
  const sessionId = decodeURIComponent(params.sessionId as string);

  const { sessions, refresh } = useWorkspace();

  // Save the current path to localStorage for task state persistence
  useEffect(() => {
    saveTaskPath(projectSlug, taskSlug, pathname);
  }, [pathname, projectSlug, taskSlug]);
  const [notFoundTimeout, setNotFoundTimeout] = useState(false);
  const markedSeenRef = useRef(false);

  const session = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId],
  );

  // When the page mounts or session isn't found yet, trigger a refresh and wait
  // a reasonable time before showing "not found"
  useEffect(() => {
    if (!session) {
      // Immediately refresh to try to pick up a newly created session
      refresh();
      // Only show "not found" after a delay to allow for async session creation
      const timer = setTimeout(() => setNotFoundTimeout(true), 3000);
      return () => clearTimeout(timer);
    } else {
      setNotFoundTimeout(false);
    }
  }, [session, refresh, sessionId]);

  // Mark the session as seen when viewing it
  useEffect(() => {
    if (!session || !session.unread || markedSeenRef.current) return;
    markedSeenRef.current = true;
    fetch(`/api/sessions/${sessionId}/seen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectSlug, taskSlug }),
    }).then(() => refresh());
  }, [session, sessionId, projectSlug, taskSlug, refresh]);

  const handleBack = () => {
    router.push(taskRoute(projectSlug, taskSlug));
  };

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
        {notFoundTimeout ? "Session not found" : "Loading..."}
      </div>
    );
  }

  return (
    <Chat
      session={session}
      onChange={refresh}
      onBack={handleBack}
    />
  );
}
