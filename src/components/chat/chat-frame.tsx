"use client";

import { ShellProvider } from "@/components/shell/shell-context";
import { HelpWidget } from "@/components/help/help-widget";
import { firstName } from "@/lib/utils";
import type { ShellData } from "@/server/queries/shell";

export function ChatFrame({ data, children }: { data: ShellData; children: React.ReactNode }) {
  return (
    <ShellProvider value={data}>
      <div className="app-backdrop relative h-dvh overflow-hidden">
        {children}
        <HelpWidget firstName={firstName(data.user.name)} canOpenTickets={data.permissions.includes("support.use")} aiAvailable={data.helpAiAvailable} raised />
      </div>
    </ShellProvider>
  );
}
