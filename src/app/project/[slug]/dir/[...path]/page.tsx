"use client";

import { useParams } from "next/navigation";

// This route exists to handle /project/[slug]/dir/[...path] URLs
// It re-exports the main project page which reads the dir from searchParams
// We redirect to the main page with the dir as a query param

import { redirect } from "next/navigation";

export default function ProjectDirPage() {
  const params = useParams();
  const slug = decodeURIComponent(params.slug as string);
  const pathParts = params.path as string[];
  // Decode each path part in case useParams returns encoded values
  const dirPath = pathParts.map(p => decodeURIComponent(p)).join("/");

  // Redirect to the main project page with dir query param
  redirect(`/project/${encodeURIComponent(slug)}?dir=${encodeURIComponent(dirPath)}`);
}
