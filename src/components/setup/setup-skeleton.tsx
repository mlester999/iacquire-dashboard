import { Card } from "@/components/ui/primitives";

export function SetupSkeleton() {
  return <div role="status" aria-label="Loading setup progress" className="mx-auto max-w-5xl space-y-6"><Card className="p-6 sm:p-8"><div className="flex flex-col gap-6 sm:flex-row"><div className="size-28 shrink-0 rounded-full bg-surface-2 motion-safe:animate-pulse" /><div className="flex-1 space-y-3"><div className="h-4 w-28 rounded bg-surface-2 motion-safe:animate-pulse" /><div className="h-8 w-3/4 rounded bg-surface-2 motion-safe:animate-pulse" /><div className="h-4 rounded bg-surface-2 motion-safe:animate-pulse" /><div className="h-4 w-2/3 rounded bg-surface-2 motion-safe:animate-pulse" /></div></div></Card>{[0, 1, 2].map((i) => <Card key={i} className="h-28 bg-surface-2/50 motion-safe:animate-pulse" />)}<span className="sr-only">Loading your current setup checklist</span></div>;
}
