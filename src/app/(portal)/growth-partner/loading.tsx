import { Skeleton } from "@/components/ui/primitives";

export default function GrowthPartnerLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading AI Growth Partner">
      <div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-72" /><Skeleton className="h-4 w-96 max-w-full" /></div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      <div className="grid gap-6 xl:grid-cols-3"><Skeleton className="h-72 rounded-2xl xl:col-span-2" /><Skeleton className="h-72 rounded-2xl" /></div>
    </div>
  );
}
