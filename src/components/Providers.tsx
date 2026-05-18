"use client";

import type { ReactNode } from "react";
import { WorkspaceProvider } from "@/lib/workspace-context";
import { AppShell } from "./AppShell";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <AppShell>{children}</AppShell>
    </WorkspaceProvider>
  );
}
