import { Skeleton } from "@/components/ui/primitives";

/** CRM routes keep the section navigation in their layout; this fills only the content column. */
export default function CrmLoading() {
  return (
    <div className="space-y-5" role="status" aria-busy="true" aria-label="Loading CRM page">
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-56" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-40 rounded-xl" />
        <Skeleton className="h-9 w-28 rounded-xl" />
        <Skeleton className="h-9 w-28 rounded-xl" />
        <Skeleton className="ml-auto h-9 w-24 rounded-xl" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="grid grid-cols-4 gap-3 border-b border-line px-4 py-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-3 w-full max-w-24" />)}
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="grid grid-cols-4 items-center gap-3 border-b border-line px-4 py-3 last:border-0">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="ml-auto h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
