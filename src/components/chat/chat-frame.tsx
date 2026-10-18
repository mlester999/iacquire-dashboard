"use client";

import { ShellProvider } from "@/components/shell/shell-context";
import type { ShellData } from "@/server/queries/shell";

export function ChatFrame({ data, children }: { data: ShellData; children: React.ReactNode }) {
  return (
    <ShellProvider value={data}>
      <div className="app-backdrop relative h-dvh overflow-hidden">
        {children}
      </div>
    </ShellProvider>
  );
}
