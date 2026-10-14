import { Compass } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="app-backdrop flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <Logo />
      <div className="mt-10 flex size-14 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
        <Compass className="size-6" />
      </div>
      <h1 className="mt-5 text-[24px] font-semibold tracking-tight">We couldn&apos;t find that page</h1>
      <p className="mt-2 max-w-sm text-[14px] text-muted">It may have moved, or you might not have access to it from this workspace.</p>
      <ButtonLink href="/" variant="brand" className="mt-6">
        Back to your workspace
      </ButtonLink>
    </main>
  );
}
