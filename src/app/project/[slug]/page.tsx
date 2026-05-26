"use client";

import { useParams } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";

export default function ProjectPage() {
  const params = useParams();
  const slug = decodeURIComponent(params.slug as string);

  return <Workspace projectSlug={slug} />;
}
