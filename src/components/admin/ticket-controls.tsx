"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/primitives";
import { sentenceCase } from "@/lib/utils";
import { updateTicketAction } from "@/app/(admin)/admin/actions";

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
    <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
      <div className="flex-1 space-y-1.5">
      <label htmlFor="tk-status" className="text-[12.5px] text-muted">
        Status
      </label>
      <Select id="tk-status" disabled={pending} value={status} onChange={(e) => start(()=>update({ status: e.target.value }))} className="w-full min-w-40 text-[13px]">
        {["open", "in_progress", "waiting_for_client", "resolved", "closed"].map((s) => (
          <option key={s} value={s}>
            {sentenceCase(s)}
          </option>
        ))}
      </Select>
      </div><div className="flex-1 space-y-1.5">
      <label htmlFor="tk-priority" className="text-[12.5px] text-muted">
        Priority
      </label>
      <Select id="tk-priority" disabled={pending} value={priority} onChange={(e) => start(()=>update({ priority: e.target.value }))} className="w-full min-w-32 text-[13px]">
        {["low", "normal", "high", "urgent"].map((s) => (
          <option key={s} value={s}>
            {sentenceCase(s)}
          </option>
        ))}
      </Select>
      </div><Button loading={pending} variant="secondary" className="w-full sm:w-auto" onClick={() => start(()=>update({ assignToMe: true }))}>
        <UserCheck className="size-3.5" /> {assigned ? `Assigned to ${assigned} · take over` : "Assign to me"}
      </Button>
    </div>
  );
}
