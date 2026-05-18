"use client";

import { useParams } from "next/navigation";
import ProjectPage from "../../page";

// This route exists to handle /project/[slug]/dir/[...path] URLs
// It re-exports the main project page which reads the dir from searchParams
// We redirect to the main page with the dir as a query param

import { redirect } from "next/navigation";

export default function ProjectDirPage() {
  const params = useParams();
  const slug = params.slug as string;
  const pathParts = params.path as string[];
  const dirPath = pathParts.join("/");

  // Redirect to the main project page with dir query param
  redirect(`/project/${slug}?dir=${encodeURIComponent(dirPath)}`);
}
