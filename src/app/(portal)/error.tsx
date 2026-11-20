"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PortalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;

  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-danger-soft text-danger-ink">
        <TriangleAlert className="size-6" aria-hidden />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">This part of your workspace couldn&apos;t load</h1>
      <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-muted">Try again. If this keeps happening, ask your workspace admin for help.</p>
      {digest && <p className="mt-2 font-mono text-[12px] text-faint">Reference: {digest}</p>}
      <Button className="mt-6" onClick={retry} variant="brand">
        <RefreshCw className="size-4" aria-hidden /> Try again
      </Button>
    </main>
  );
}
