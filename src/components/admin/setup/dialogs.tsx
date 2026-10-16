"use client";

import * as React from "react";
import { AlertTriangle, ListPlus, ShieldCheck, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { CHECK_STATUS, CheckRow, SwitchRow, TaskStatusPill, type Act } from "@/components/admin/setup/common";
import { Callout } from "@/components/admin/setup/ui";
import { activateSetupAction, createCustomTaskAction, sendBackToSetupAction, setServicesAction } from "@/app/(admin)/admin/setup-actions";
import { CHECK_LABEL, SETUP_SERVICES, type AgencySetupSnapshot, type Section, type SetupService } from "@/lib/setup";

type DialogBase = { open: boolean; onClose: () => void; orgId: string; act: Act; busy: string | null };

/** Gives every opening of a dialog a fresh form, while the dialog stays mounted so it can animate closed. */
function useFreshOnOpen(open: boolean) {
  const [gen, setGen] = React.useState(0);
  const [was, setWas] = React.useState(open);
  if (open !== was) {
    setWas(open);
    if (open) setGen((g) => g + 1);
  }
  return gen;
}

// ---------------------------------------------------------------------------
// Add a custom step
// ---------------------------------------------------------------------------

type AddProps = DialogBase & { snapshot: AgencySetupSnapshot; onCreated: (id: string) => void };

export function AddTaskDialog(props: AddProps) {
  return <AddTaskInner key={useFreshOnOpen(props.open)} {...props} />;
}

function AddTaskInner({ open, onClose, orgId, snapshot, act, busy, onCreated }: AddProps) {
  const [f, setF] = React.useState<{ title: string; description: string; section: Section; required: boolean; assignedTo: string; estimate: string; deps: string[] }>({
    title: "",
    description: "",
    section: "agency",
    required: true,
    assignedTo: "",
    estimate: "",
    deps: [],
  });
  const candidates = snapshot.tasks.filter((t) => !t.hidden && !t.serviceExcluded && t.completionMode !== "activation");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add a custom step"
      description="Custom steps are completed by your team and count toward the client's progress when required."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            loading={busy === "add-task"}
            disabled={f.title.trim().length < 2}
            onClick={async () => {
              const res = await act("add-task", () => createCustomTaskAction(orgId, { title: f.title, description: f.description, section: f.section, required: f.required, assignedTo: f.assignedTo || null, estimatedCompletionAt: f.estimate || null, dependsOn: f.deps }), "Step added");
              if (res?.ok) {
                onCreated((res.data as { taskId: string }).taskId);
                onClose();
              }
            }}
          >
            <ListPlus className="size-4" /> Add step
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Step name" htmlFor="nt-title">
          <Input id="nt-title" autoFocus value={f.title} maxLength={160} placeholder="e.g. Brand approval" onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Description for the client" htmlFor="nt-desc" optional>
          <Textarea id="nt-desc" rows={2} value={f.description} maxLength={600} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Shown under" htmlFor="nt-section">
          <Select id="nt-section" value={f.section} onChange={(e) => setF({ ...f, section: e.target.value as Section })}>
            <option value="agency">We&apos;re setting this up for you</option>
            <option value="client">We need a few things from you</option>
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assigned to" htmlFor="nt-assign" optional>
            <Select id="nt-assign" value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
              <option value="">Unassigned</option>
              {snapshot.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Estimated completion" htmlFor="nt-est" optional>
            <Input id="nt-est" type="date" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} />
          </Field>
        </div>
        <div className="rounded-xl bg-surface-2/50 px-3.5 py-3 ring-1 ring-inset ring-line">
          <SwitchRow id="nt-req" label="Required" hint="Required steps count toward progress and must be done before final review." checked={f.required} onChange={(v) => setF({ ...f, required: v })} />
        </div>
        {candidates.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="flex w-full items-center justify-between gap-2 text-[13px] font-medium text-ink-2">
              Prerequisites (optional)
              {f.deps.length > 0 && <InfoChip className="h-5 text-[11px]">{f.deps.length} selected</InfoChip>}
            </legend>
            <div className="scrollbar-thin max-h-48 space-y-1.5 overflow-y-auto pr-1">
              {candidates.map((t) => (
                <CheckRow key={t.id} id={`nt-dep-${t.id}`} label={t.title} trailing={<TaskStatusPill status={t.status} size="sm" />} checked={f.deps.includes(t.id)} onChange={(v) => setF({ ...f, deps: v ? [...f.deps, t.id] : f.deps.filter((d) => d !== t.id) })} />
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

type ServicesProps = DialogBase & { current: SetupService[] };

export function ServicesDialog(props: ServicesProps) {
  return <ServicesInner key={useFreshOnOpen(props.open)} {...props} />;
}

function ServicesInner({ open, onClose, orgId, current, act, busy }: ServicesProps) {
  const [sel, setSel] = React.useState<SetupService[]>(current);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Services included"
      description="Steps tied to a service this client didn't buy are removed from their checklist, progress and readiness."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            loading={busy === "services"}
            onClick={async () => {
              const res = await act("services", () => setServicesAction(orgId, sel), "Services updated");
              if (res?.ok) onClose();
            }}
          >
            Save services
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-ink-2">Included in this client&apos;s package</p>
          <InfoChip className="h-5 text-[11px]">{sel.length} of {SETUP_SERVICES.length} included</InfoChip>
        </div>
        {SETUP_SERVICES.map((s) => (
          <CheckRow key={s.key} id={`svc-${s.key}`} label={s.label} hint={s.description} checked={sel.includes(s.key)} onChange={(v) => setSel(v ? [...sel, s.key] : sel.filter((x) => x !== s.key))} />
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Send back to setup
// ---------------------------------------------------------------------------

export function SendBackDialog(props: DialogBase) {
  return <SendBackInner key={useFreshOnOpen(props.open)} {...props} />;
}

function SendBackInner({ open, onClose, orgId, act, busy }: DialogBase) {
  const [reason, setReason] = React.useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Send back to setup"
      description="Returns the client to In setup so more work can be done. The client isn't told why."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy === "sendback"}
            disabled={reason.trim().length < 5}
            onClick={async () => {
              const res = await act("sendback", () => sendBackToSetupAction(orgId, reason), "Sent back to setup");
              if (res?.ok) onClose();
            }}
          >
            <Undo2 className="size-4" /> Send back
          </Button>
        </>
      }
    >
      <Field label="Reason (internal)" htmlFor="sb-reason" hint="At least 5 characters. Recorded in the activity log.">
        <Textarea id="sb-reason" rows={3} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Approve activation
// ---------------------------------------------------------------------------

type ActivateProps = DialogBase & { snapshot: AgencySetupSnapshot };

export function ActivateDialog(props: ActivateProps) {
  return <ActivateInner key={useFreshOnOpen(props.open)} {...props} />;
}

function ActivateInner({ open, onClose, orgId, snapshot, act, busy }: ActivateProps) {
  const [ack, setAck] = React.useState(false);
  const [note, setNote] = React.useState("");
  const attested = snapshot.readiness.attestedChecks;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Approve activation"
      description={`Final sign-off for ${snapshot.org.name}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            loading={busy === "activate"}
            disabled={!snapshot.readiness.canActivate || (attested.length > 0 && !ack)}
            onClick={async () => {
              const res = await act("activate", () => activateSetupAction(orgId, { acknowledgeAttested: ack, note }), "Approved for activation");
              if (res?.ok) onClose();
            }}
          >
            <ShieldCheck className="size-4" /> Approve activation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Every implemented connection check is re-run when you approve. A failed or unverified required check blocks approval. This records the agency review; live workflows and outreach need separate authorization.
        </p>
        <ul className="space-y-1.5">
          {snapshot.checks.map((c) => (
            <li key={c.key} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/40 px-3 py-2 text-[13px]">
              <span className="min-w-0 text-ink">{CHECK_LABEL[c.key]}</span>
              <StatusPill tone={c.status === "unverified" ? "warning" : CHECK_STATUS[c.status].tone} size="sm">{CHECK_STATUS[c.status].label}</StatusPill>
            </li>
          ))}
        </ul>
        {attested.length > 0 && (
          <div className="space-y-2">
            <Callout tone="violet" icon={<ShieldCheck />}>
              {attested.length} check{attested.length === 1 ? " has" : "s have"} agency evidence awaiting technical verification: {attested.map((k) => CHECK_LABEL[k]).join(", ")}.
            </Callout>
            <CheckRow id="act-ack" label="I have reviewed this evidence; technical verification is still required" checked={ack} onChange={setAck} />
          </div>
        )}
        {!snapshot.readiness.canActivate && (
          <Callout tone="warning" icon={<AlertTriangle />} title="Not ready yet">
            {snapshot.readiness.blockers[0]?.message}
          </Callout>
        )}
        <Field label="Note" htmlFor="act-note" optional hint="Internal. Recorded with the approval.">
          <Textarea id="act-note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
