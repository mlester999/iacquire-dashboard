"use client";

import * as React from "react";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";

const ShellContext = React.createContext<ShellData | null>(null);

export function ShellProvider({ value, children }: { value: ShellData; children: React.ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const v = React.useContext(ShellContext);
  if (!v) throw new Error("useShell must be used inside the portal shell");
  return v;
}

export function useCan() {
  const shell = React.useContext(ShellContext);
  return React.useCallback((p: Permission) => Boolean(shell?.permissions.includes(p)), [shell]);
}
