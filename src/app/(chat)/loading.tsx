import { Logo } from "@/components/brand";
import { Skeleton } from "@/components/ui/primitives";

/**
 * The chat surface has its own layout (no portal sidebar), so it needs its own boundary. Without
 * this file a click on an AI employee waited for the whole server render before showing anything.
 * The rail placeholder is the real navy chrome with the real wordmark, so the brand never flashes away.
 */
export default function ChatLoading() {
  return (
    <div className="flex h-dvh min-h-0 bg-bg" role="status" aria-busy="true" aria-label="Loading chat">
      <div className="workspace-nav hidden w-[280px] shrink-0 flex-col gap-3 border-r border-white/10 px-3 lg:flex">
        <div className="flex h-[76px] shrink-0 items-center px-2">
          <Logo />
        </div>
        <div className="h-10 w-full animate-pulse rounded-xl bg-white/[.06]" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-12 w-full animate-pulse rounded-xl bg-white/[.06]" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-20 shrink-0 items-center gap-3 border-b border-line px-4">
          <Skeleton className="size-10 rounded-xl" />
          <div className="space-y-1.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-20" /></div>
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6">
          <Skeleton className="h-16 w-3/4 rounded-2xl" />
          <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
          <Skeleton className="h-24 w-4/5 rounded-2xl" />
          <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
        </div>
        <div className="mx-auto w-full max-w-3xl shrink-0 p-4"><Skeleton className="h-14 w-full rounded-2xl" /></div>
      </div>
    </div>
  );
}
