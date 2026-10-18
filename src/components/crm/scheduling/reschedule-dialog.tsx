"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { rescheduleAppointmentAction, rescheduleSlotsAction } from "@/app/actions/crm-scheduling";
import { useCrmAction } from "@/components/crm/ui";
import { SlotPicker, type PickerSlot } from "@/components/crm/scheduling/slot-picker";
import { dateTimeIn } from "@/components/crm/scheduling/format";
import { zonedDate } from "@/lib/calendars/slots";
import type { CrmScope } from "@/server/crm/page";

export interface MovableAppointment {
  id: string;
  title: string;
  startAt: string;
  version: number;
  hosts: Array<{ id: string; name: string }>;
}

/** Moves an appointment to another free time. The keyboard-friendly way to reschedule; dragging in the week and day views is the shortcut. */
export function RescheduleDialog({
  scope, appointment, timeZone, today, initialDate, hostNames, onClose, onMoved,
}: {
  scope: CrmScope;
  appointment: MovableAppointment;
  timeZone: string;
  today: string;
  initialDate?: string | null;
  hostNames: Record<string, string>;
  onClose: () => void;
  onMoved?: () => void;
}) {
  const { run, busy } = useCrmAction();
  const [slot, setSlot] = React.useState<PickerSlot | null>(null);
  const load = React.useCallback((from: string, to: string) => rescheduleSlotsAction(scope.orgId, appointment.id, { from, to }), [scope.orgId, appointment.id]);
  const unchanged = slot?.start === appointment.startAt;
  const newHost = slot && slot.keepsHost === false && slot.hostIds.length === 1 ? hostNames[slot.hostIds[0]] ?? "another host" : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Reschedule appointment"
      description={<>Now {dateTimeIn(appointment.startAt, timeZone)}. Only times that are free for it are offered.</>}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!slot || unchanged}
            loading={busy("move")}
            onClick={async () => {
              if (!slot) return;
              const r = await run("move", () => rescheduleAppointmentAction(scope.orgId, appointment.id, { startAt: slot.start, expectedVersion: appointment.version }), () => `Moved to ${dateTimeIn(slot.start, timeZone)}.`);
              if (r) {
                onMoved?.();
                onClose();
              }
            }}
          >
            Move appointment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SlotPicker
          id={`resched-${appointment.id}`}
          timeZone={timeZone}
          today={today}
          initialDate={initialDate ?? zonedDate(new Date(appointment.startAt).getTime(), timeZone)}
          load={load}
          loadKey={appointment.id}
          value={slot?.start ?? null}
          onChange={setSlot}
          hostNames={hostNames}
          currentStart={appointment.startAt}
        />
        {newHost && (
          <p className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink" role="status">
            {appointment.hosts.map((h) => h.name).join(", ") || "The current host"} isn&apos;t free then, so this time is with {newHost}.
          </p>
        )}
        <p className="text-[12.5px] text-muted">Hosts are notified and any reminders move to the new time.</p>
      </div>
    </Dialog>
  );
}
