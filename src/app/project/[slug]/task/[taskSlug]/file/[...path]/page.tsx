"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { taskRoute } from "@/lib/routes";

// Legacy deep link — redirect into the unified task workspace with the
// file expanded as the artifact column.
export default function TaskFileRedirect() {
  const params = useParams();
  const router = useRouter();
  const projectSlug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);
  const pathParts = params.path as string[];
  const filePath = pathParts.map(decodeURIComponent).join("/");
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  useEffect(() => {
    router.replace(taskRoute(projectSlug, taskSlug, { artifact: filePath, dir: dirPath || undefined }));
  }, [router, projectSlug, taskSlug, filePath, dirPath]);

  return (
    <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
      Loading…
    </div>
  );
}
