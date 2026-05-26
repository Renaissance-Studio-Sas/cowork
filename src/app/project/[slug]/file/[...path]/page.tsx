"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { projectRoute } from "@/lib/routes";

// Legacy deep link — redirect into the unified project workspace with the
// file expanded as the artifact column.
export default function ProjectFileRedirect() {
  const params = useParams();
  const router = useRouter();
  const projectSlug = decodeURIComponent(params.slug as string);
  const pathParts = params.path as string[];
  const filePath = pathParts.map(decodeURIComponent).join("/");
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  useEffect(() => {
    router.replace(projectRoute(projectSlug, { artifact: filePath, dir: dirPath || undefined }));
  }, [router, projectSlug, filePath, dirPath]);

  return (
    <div className="flex-1 flex items-center justify-center text-[var(--muted)]">
      Loading…
    </div>
  );
}
