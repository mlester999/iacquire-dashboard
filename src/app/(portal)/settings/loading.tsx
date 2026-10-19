import { Skeleton } from "@/components/ui/primitives";

/** Settings navigation stays mounted in its layout; this fills the form column. */
export default function SettingsLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading settings">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ))}
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>
    </div>
  );
}
