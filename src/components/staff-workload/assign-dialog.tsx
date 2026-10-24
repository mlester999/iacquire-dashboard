"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/overlays";
import { Badge, ProgressBar } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { assignWorkloadItemAction, suggestWorkloadAssigneeAction } from "@/app/actions/staff-workload";
import { LABEL_TEXT } from "@/lib/staff-workload/labels";
import { LABEL_TONE, percentText } from "@/lib/staff-workload/screens";
import { SKILL_LEVEL_LABELS } from "@/lib/staff-workload/sources";
import type { SuggestionsFor } from "@/server/staff-workload/suggestions";

// The board's assignment dialog. It asks the server who could take the item (the three best fits with their reasons), then applies one choice through the same service the
// board uses. Nothing is assigned by opening the dialog, and a person whose standing changed is refused by the action, not by this component.

export interface AssignDialogProps {
  source: SuggestionsFor["item"]["source"];
  itemId: string;
  title: string;
  orgName: string;
  /** Who holds it now; null for the unassigned lane. Sent back so a stale board is refused instead of overwriting a newer assignment. */
  assigneeId: string | null;
  disabled?: boolean;
}

export function AssignDialog({ source, itemId, title, orgName, assigneeId, disabled = false }: AssignDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<SuggestionsFor | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    const result = await suggestWorkloadAssigneeAction({ source, itemId });
    if (result.ok) setData(result.data);
    else setError(result.error);
    setLoading(false);
  }, [source, itemId]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load();
  };

  const choose = async (userId: string) => {
    setSaving(userId);
    setError(null);
    const result = await assignWorkloadItemAction({ source, itemId, assigneeId: userId, expectedAssigneeId: assigneeId, via: "suggestion" });
    setSaving(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Work assigned.");
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(true)} disabled={disabled}>
        <UserRound className="size-3.5" aria-hidden /> {assigneeId ? "Reassign" : "Assign"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Give this item to someone"
        description={
          <span>
            {title} <span className="text-muted">· {orgName}</span>
          </span>
        }
        size="md"
        footer={
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        }
      >
        {loading && (
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Finding the people who could take it…
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">
            {error}
          </p>
        )}
        {data && !loading && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              <p>
                Ranked by recorded skill, current load, the effect of this item, and who has had the least from the board. A suggestion changes nothing until you choose it.
              </p>
            </div>
            {data.list.suggestions.length ? (
              <ul className="space-y-2" aria-label="Suggested people">
                {data.list.suggestions.map((s) => (
                  <li key={s.userId} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                          {s.name}
                          {s.skillLevel !== null && <Badge tone="primary">{SKILL_LEVEL_LABELS[s.skillLevel]} skill</Badge>}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                          {s.current.label ? (
                            <Badge tone={LABEL_TONE[s.current.label]}>{LABEL_TEXT[s.current.label]}</Badge>
                          ) : (
                            <Badge tone="outline">Capacity not set</Badge>
                          )}
                          <span className="tabular-nums">
                            {s.current.points} pts now · {s.after.points} pts with this item
                          </span>
                        </p>
                      </div>
                      <Button type="button" size="sm" onClick={() => void choose(s.userId)} loading={saving === s.userId} disabled={saving !== null}>
                        Assign to {s.name.split(" ")[0]}
                      </Button>
                    </div>
                    <div className="mt-2 space-y-1">
                      <ProgressBar value={s.after.ratioPercent ?? 0} tone={(s.after.ratioPercent ?? 0) >= 100 ? "danger" : (s.after.ratioPercent ?? 0) >= 85 ? "warning" : "primary"} label={`${percentText(s.after.ratioPercent)} of capacity with this item`} />
                      <ul className="space-y-0.5 text-[12px] leading-relaxed text-muted">
                        {s.reasons.slice(0, 4).map((reason) => (
                          <li key={reason}>· {reason}</li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-line bg-surface-2 px-3 py-4 text-[13px] leading-relaxed text-muted">
                {data.list.notes.length ? data.list.notes.join(" ") : "Nobody who can open this client and holds the permission for this kind of work is available."}
              </p>
            )}
            {data.list.notes.length > 0 && data.list.suggestions.length > 0 && <p className="text-[12px] leading-relaxed text-muted">{data.list.notes.join(" ")}</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}
