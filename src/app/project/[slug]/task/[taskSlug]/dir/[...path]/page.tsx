"use client";

import { useParams } from "next/navigation";
import { redirect } from "next/navigation";

export default function TaskDirPage() {
  const params = useParams();
  const slug = params.slug as string;
  const taskSlug = params.taskSlug as string;
  const pathParts = params.path as string[];
  const dirPath = pathParts.join("/");

  redirect(`/project/${slug}/task/${taskSlug}?dir=${encodeURIComponent(dirPath)}`);
}
