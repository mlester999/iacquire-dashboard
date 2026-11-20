import { Skeleton } from "@/components/ui/primitives";

export default function ApprovalsLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading approvals">
      <div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-96 max-w-full" /></div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"><Skeleton className="h-[26rem] rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>
    </div>
  );
}
