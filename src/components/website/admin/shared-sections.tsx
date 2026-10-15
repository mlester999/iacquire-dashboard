"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { setPatternStatusAction } from "@/app/actions/website-admin";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { relativeTime } from "@/lib/utils";
import type { PatternStatus, PatternView } from "@/server/websites/components";

const LABEL: Record<PatternStatus, string> = { draft: "Waiting for a super admin", published: "Offered to every client", archived: "Archived" };
const TONE: Record<PatternStatus, "warning" | "success" | "outline"> = { draft: "warning", published: "success", archived: "outline" };

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
        <CardTitle className="flex items-center gap-2"><Layers className="size-4" aria-hidden /> Shared sections <span className="text-[13px] font-normal text-muted">· {patterns.length}</span></CardTitle>
        <CardDescription>Reusable sections your team saved from the editor (Save as a component, then share with every website). Websites that already used one keep their own copy.</CardDescription>
      </CardHeader>
      <CardContent>
        {patterns.length === 0 ? (
          <p className="text-[13px] text-muted">None yet. In any editor, choose a section&apos;s more menu, then Save as a component, and share it with the agency.</p>
        ) : (
          <ul className="divide-y divide-line">
            {patterns.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold">{p.name}</p>
                  <p className="truncate text-[12.5px] text-muted">{p.createdByName ?? "The agency team"} · {relativeTime(p.updatedAt)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge>
                  {canPublish && p.status !== "published" && <Button size="sm" variant="soft" loading={busy === p.id} onClick={() => void change(p, "published")}>Offer to clients</Button>}
                  {canPublish && p.status === "published" && <Button size="sm" variant="secondary" loading={busy === p.id} onClick={() => void change(p, "draft")}>Take back</Button>}
                  {canPublish && p.status !== "archived" && <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void change(p, "archived")}>Archive</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
