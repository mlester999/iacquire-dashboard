import { Skeleton } from "@/components/ui/primitives";

export default function ActivityLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading activity">
      <div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-96 max-w-full" /></div>
      <Skeleton className="h-12 rounded-xl" />
      <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
    </div>
  );
}
