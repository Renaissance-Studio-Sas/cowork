"use client";

import { useParams, useRouter } from "next/navigation";
import { FileViewer } from "@/components/FileViewer";
import { projectRoute } from "@/lib/routes";

export default function ProjectFilePage() {
  const params = useParams();
  const router = useRouter();
  const projectSlug = decodeURIComponent(params.slug as string);
  const pathParts = params.path as string[];
  const filePath = pathParts.map(decodeURIComponent).join("/");

  const handleBack = () => {
    // Go back to the parent folder or project root
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash > 0) {
      const dirPath = filePath.slice(0, lastSlash);
      router.push(`/project/${encodeURIComponent(projectSlug)}?dir=${encodeURIComponent(dirPath)}`);
    } else {
      router.push(projectRoute(projectSlug));
    }
  };

  return (
    <FileViewer
      projectSlug={projectSlug}
      taskSlug=""
      filePath={filePath}
      onBack={handleBack}
    />
  );
}
