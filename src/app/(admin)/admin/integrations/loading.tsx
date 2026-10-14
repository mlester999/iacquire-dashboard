import { Skeleton } from "@/components/ui/primitives";
export default function IntegrationLoading(){return <div className="space-y-5" aria-label="Loading integrations"><Skeleton className="h-12 w-72"/><Skeleton className="h-20 w-full"/><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({length:8},(_,i)=><Skeleton key={i} className="h-72 rounded-2xl"/>)}</div></div>;}
