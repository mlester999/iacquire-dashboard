"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { sentenceCase } from "@/lib/utils";
import { updateTicketAction } from "@/app/(admin)/admin/actions";

/** A ticket's lifecycle state as a tinted pill (open and in progress read blue, waiting amber, resolved green, closed neutral). */
export function TicketStatusPill({ status, size }: { status: string; size?: "sm" | "md" }) {
  return <StatusPill status={status} size={size} />;
}

/** Priority as a pill: urgent is red, high amber, normal and low neutral. Pass `label` for a longer wording such as "Urgent priority". */
export function TicketPriorityPill({ priority, size, label }: { priority: string; size?: "sm" | "md"; label?: string }) {
  return <StatusPill status={priority} size={size}>{label ?? sentenceCase(priority)}</StatusPill>;
}

export function TicketControls({ ticketId, status, priority, assigned }: { ticketId: string; status: string; priority: string; assigned: string | null }) {
  const router = useRouter();
  const [pending,start]=React.useTransition();
  const update = async (changes: { status?: string; priority?: string; assignToMe?: boolean }) => {
    const res = await updateTicketAction(ticketId, changes);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Ticket updated");
    router.refresh();
  };
  return (
    <div className="mt-4 grid items-end gap-3 border-t border-line pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="space-y-1.5">
        <Label htmlFor="tk-status">Status</Label>
        <Select id="tk-status" disabled={pending} value={status} onChange={(e) => start(()=>update({ status: e.target.value }))} className="w-full min-w-0">
          {["open", "in_progress", "waiting_for_client", "resolved", "closed"].map((s) => (
            <option key={s} value={s}>
              {sentenceCase(s)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tk-priority">Priority</Label>
        <Select id="tk-priority" disabled={pending} value={priority} onChange={(e) => start(()=>update({ priority: e.target.value }))} className="w-full min-w-0">
          {["low", "normal", "high", "urgent"].map((s) => (
            <option key={s} value={s}>
              {sentenceCase(s)}
            </option>
          ))}
        </Select>
      </div>
      <Button loading={pending} variant="secondary" className="w-full min-w-0 sm:w-auto sm:max-w-[16rem]" onClick={() => start(()=>update({ assignToMe: true }))} title={assigned ? `Assigned to ${assigned}. Take over this ticket.` : "Assign this ticket to yourself"}>
        <UserCheck className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{assigned ? `Assigned to ${assigned} · take over` : "Assign to me"}</span>
      </Button>
    </div>
  );
}
