"use client";

import { useParams } from "next/navigation";
import { redirect } from "next/navigation";

export default function TaskDirPage() {
  const params = useParams();
  const slug = decodeURIComponent(params.slug as string);
  const taskSlug = decodeURIComponent(params.taskSlug as string);
  const pathParts = params.path as string[];
  // Decode each path part in case useParams returns encoded values
  const dirPath = pathParts.map(p => decodeURIComponent(p)).join("/");

  redirect(`/project/${encodeURIComponent(slug)}/task/${encodeURIComponent(taskSlug)}?dir=${encodeURIComponent(dirPath)}`);
}
