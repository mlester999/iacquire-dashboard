import { Skeleton } from "@/components/ui/primitives";

export default function KnowledgeLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading Knowledge Center">
      <div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-96 max-w-full" /></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]"><Skeleton className="h-72 rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>
      <Skeleton className="h-56 rounded-2xl" />
    </div>
  );
}
