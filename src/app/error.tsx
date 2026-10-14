"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-danger-soft text-danger-ink">
        <TriangleAlert className="size-6" />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-[14px] text-muted">This page hit an unexpected problem. Nothing was changed. Try again, or head back to your dashboard.</p>
      {error.digest && <p className="mt-2 font-mono text-[11.5px] text-faint">Reference: {error.digest}</p>}
      <div className="mt-6 flex gap-2">
        <Button onClick={reset} variant="brand">
          <RefreshCw className="size-4" /> Try again
        </Button>
        <ButtonLink href="/" variant="secondary">
          Dashboard
        </ButtonLink>
      </div>
    </main>
  );
}
