import { Card, Skeleton } from "@/components/ui/primitives";

/** Shown while any Support & Requests page is being prepared: the page's shape, so nothing jumps when it arrives. */
export default function Loading() {
  return (
    <div className="module-stack" role="status" aria-label="Loading">
      <Skeleton className="h-40 w-full rounded-3xl" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /><Skeleton className="h-36 w-full" /></Card>
        <Card className="space-y-3 p-5"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></Card>
      </div>
    </div>
  );
}
