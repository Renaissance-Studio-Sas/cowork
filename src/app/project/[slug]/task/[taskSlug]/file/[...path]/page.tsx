"use client";

import { useParams, useRouter } from "next/navigation";
import { FileViewer } from "@/components/FileViewer";
import { taskRoute } from "@/lib/routes";

export default function TaskFilePage() {
  const params = useParams();
  const router = useRouter();
  const projectSlug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);
  const pathParts = params.path as string[];
  const filePath = pathParts.map(decodeURIComponent).join("/");

  const handleBack = () => {
    // Go back to the parent folder or task root
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash > 0) {
      const dirPath = filePath.slice(0, lastSlash);
      router.push(`/project/${encodeURIComponent(projectSlug)}/task/${encodeURIComponent(taskSlug)}?dir=${encodeURIComponent(dirPath)}`);
    } else {
      router.push(taskRoute(projectSlug, taskSlug));
    }
  };

  return (
    <FileViewer
      projectSlug={projectSlug}
      taskSlug={taskSlug}
      filePath={filePath}
      onBack={handleBack}
    />
  );
}
