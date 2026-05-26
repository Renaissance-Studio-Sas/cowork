"use client";

import { useParams } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";

export default function TaskPage() {
  const params = useParams();
  const projectSlug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);

  return <Workspace projectSlug={projectSlug} taskSlug={taskSlug} />;
}
