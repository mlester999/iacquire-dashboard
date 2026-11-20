import { Skeleton } from "@/components/ui/primitives";

export default function WorkLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading AI Work Board">
      <div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-96 max-w-full" /></div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      <Skeleton className="h-[26rem] rounded-2xl" />
    </div>
  );
}
