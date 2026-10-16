"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { setPatternStatusAction } from "@/app/actions/website-admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { InfoChip, RelativeTime, StatusPill, type StatusTone } from "@/components/ui/status";
import {  } from "@/lib/utils";
import type { PatternStatus, PatternView } from "@/server/websites/components";

const LABEL: Record<PatternStatus, string> = { draft: "Waiting for a super admin", published: "Offered to every client", archived: "Archived" };
const TONE: Record<PatternStatus, StatusTone> = { draft: "warning", published: "success", archived: "neutral" };

/**
 * Sections the agency shares with every client's editor. Anyone on the agency team can save one from the editor; it reaches clients only once a
 * super admin publishes it. A client who has already used one keeps their own copy whatever happens here.
 */
export function SharedSections({ patterns, canPublish }: { patterns: PatternView[]; canPublish: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const change = async (p: PatternView, status: PatternStatus) => {
    setBusy(p.id);
    const res = await setPatternStatusAction(p.id, status);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    toast.success(status === "published" ? `“${p.name}” is now offered to every client.` : status === "archived" ? `“${p.name}” was archived.` : `“${p.name}” went back to draft.`);
    router.refresh();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-[10px] bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" aria-hidden><Layers className="size-4" /></span> Shared sections <span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{patterns.length}</span></CardTitle>
        <CardDescription>Reusable sections your team saved from the editor (Save as a component, then share with every website). Websites that already used one keep their own copy.</CardDescription>
      </CardHeader>
      <CardContent>
        {patterns.length === 0 ? (
          <EmptyState compact icon={<Layers className="size-5" />} title="No shared sections yet" description="In any editor, choose a section's more menu, then Save as a component, and share it with the agency." />
        ) : (
          <ul className="-mx-2 divide-y divide-line">
            {patterns.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-surface-2/70">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-ink" title={p.name}>{p.name}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5"><InfoChip>{p.createdByName ?? "The agency team"}</InfoChip><InfoChip><RelativeTime value={p.updatedAt} prefix="Updated " /></InfoChip></div>
                </div>
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  <StatusPill tone={TONE[p.status]}>{LABEL[p.status]}</StatusPill>
                  {canPublish && p.status !== "published" && <Button size="sm" className="max-sm:h-10" variant="soft" loading={busy === p.id} onClick={() => void change(p, "published")}>Offer to clients</Button>}
                  {canPublish && p.status === "published" && <Button size="sm" className="max-sm:h-10" variant="secondary" loading={busy === p.id} onClick={() => void change(p, "draft")}>Take back</Button>}
                  {canPublish && p.status !== "archived" && <Button size="sm" className="max-sm:h-10" variant="ghost" disabled={busy === p.id} onClick={() => void change(p, "archived")}>Archive</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
