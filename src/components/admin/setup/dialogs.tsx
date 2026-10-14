"use client";

import * as React from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { CheckRow, SwitchRow, type Act } from "@/components/admin/setup/common";
import { activateSetupAction, createCustomTaskAction, sendBackToSetupAction, setServicesAction } from "@/app/(admin)/admin/setup-actions";
import { CHECK_LABEL, SETUP_SERVICES, STATUS_LABEL, type AgencySetupSnapshot, type Section, type SetupService } from "@/lib/setup";

export function AddTaskDialog({ open, onClose, orgId, snapshot, act, busy, onCreated }: { open: boolean; onClose: () => void; orgId: string; snapshot: AgencySetupSnapshot; act: Act; busy: string | null; onCreated: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Add a custom step" description="Custom steps are completed by your team and count toward the client's progress when required.">
      {open && <AddTaskForm orgId={orgId} snapshot={snapshot} act={act} busy={busy} onClose={onClose} onCreated={onCreated} />}
    </Dialog>
  );
}

function AddTaskForm({ orgId, snapshot, act, busy, onClose, onCreated }: { orgId: string; snapshot: AgencySetupSnapshot; act: Act; busy: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = React.useState<{ title: string; description: string; section: Section; required: boolean; assignedTo: string; estimate: string; deps: string[] }>({
    title: "",
    description: "",
    section: "agency",
    required: true,
    assignedTo: "",
    estimate: "",
    deps: [],
  });
  return (
    <div className="space-y-4">
      <Field label="Step name" htmlFor="nt-title">
        <Input id="nt-title" autoFocus value={f.title} maxLength={160} placeholder="e.g. Brand approval" onChange={(e) => setF({ ...f, title: e.target.value })} />
      </Field>
      <Field label="Description for the client" htmlFor="nt-desc" optional>
        <Textarea id="nt-desc" rows={2} value={f.description} maxLength={600} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shown under" htmlFor="nt-section">
          <Select id="nt-section" value={f.section} onChange={(e) => setF({ ...f, section: e.target.value as Section })}>
            <option value="agency">We&apos;re setting this up for you</option>
            <option value="client">We need a few things from you</option>
          </Select>
        </Field>
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
      </div>
      <Field label="Estimated completion" htmlFor="nt-est" optional hint="Leave empty unless you know it.">
        <Input id="nt-est" type="date" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} />
      </Field>
      <SwitchRow id="nt-req" label="Required" hint="Required steps count toward progress and must be done before final review." checked={f.required} onChange={(v) => setF({ ...f, required: v })} />
      {snapshot.tasks.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-ink-2">Prerequisites (optional)</legend>
          <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
            {snapshot.tasks
              .filter((t) => !t.hidden && !t.serviceExcluded && t.completionMode !== "activation")
              .map((t) => (
                <CheckRow key={t.id} id={`nt-dep-${t.id}`} label={t.title} hint={STATUS_LABEL[t.status]} checked={f.deps.includes(t.id)} onChange={(v) => setF({ ...f, deps: v ? [...f.deps, t.id] : f.deps.filter((d) => d !== t.id) })} />
              ))}
          </div>
        </fieldset>
      )}
      <div className="flex justify-end gap-2 pt-1">
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
          Add step
        </Button>
      </div>
    </div>
  );
}

export function ServicesDialog({ open, onClose, orgId, current, act, busy }: { open: boolean; onClose: () => void; orgId: string; current: SetupService[]; act: Act; busy: string | null }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Services included" description="Steps tied to a service this client didn't buy are removed from their checklist, progress and readiness.">
      {open && <ServicesForm orgId={orgId} current={current} act={act} busy={busy} onClose={onClose} />}
    </Dialog>
  );
}

function ServicesForm({ orgId, current, act, busy, onClose }: { orgId: string; current: SetupService[]; act: Act; busy: string | null; onClose: () => void }) {
  const [sel, setSel] = React.useState<SetupService[]>(current);
  return (
    <div className="space-y-3">
      {SETUP_SERVICES.map((s) => (
        <CheckRow key={s.key} id={`svc-${s.key}`} label={s.label} hint={s.description} checked={sel.includes(s.key)} onChange={(v) => setSel(v ? [...sel, s.key] : sel.filter((x) => x !== s.key))} />
      ))}
      <div className="flex justify-end gap-2 pt-2">
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
          Save
        </Button>
      </div>
    </div>
  );
}

export function SendBackDialog({ open, onClose, orgId, act, busy }: { open: boolean; onClose: () => void; orgId: string; act: Act; busy: string | null }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Send back to setup" description="Returns the client to In setup so more work can be done. The client isn't told why.">
      {open && <SendBackForm orgId={orgId} act={act} busy={busy} onClose={onClose} />}
    </Dialog>
  );
}

function SendBackForm({ orgId, act, busy, onClose }: { orgId: string; act: Act; busy: string | null; onClose: () => void }) {
  const [reason, setReason] = React.useState("");
  return (
    <div className="space-y-4">
      <Field label="Reason (internal)" htmlFor="sb-reason">
        <Textarea id="sb-reason" rows={3} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
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
          Send back
        </Button>
      </div>
    </div>
  );
}

export function ActivateDialog({ open, onClose, orgId, snapshot, act, busy }: { open: boolean; onClose: () => void; orgId: string; snapshot: AgencySetupSnapshot; act: Act; busy: string | null }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Approve activation" description={`Final sign-off for ${snapshot.org.name}.`}>
      {open && <ActivateForm orgId={orgId} snapshot={snapshot} act={act} busy={busy} onClose={onClose} />}
    </Dialog>
  );
}

function ActivateForm({ orgId, snapshot, act, busy, onClose }: { orgId: string; snapshot: AgencySetupSnapshot; act: Act; busy: string | null; onClose: () => void }) {
  const [ack, setAck] = React.useState(false);
  const [note, setNote] = React.useState("");
  const attested = snapshot.readiness.attestedChecks;
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        Every implemented connection check is re-run when you approve. A failed or unverified required check blocks approval. This records the agency review; live workflows and outreach need separate authorization.
      </p>
      <ul className="space-y-1.5">
        {snapshot.checks.map((c) => (
          <li key={c.key} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2 text-[13px]">
            <span className="text-ink">{CHECK_LABEL[c.key]}</span>
            <span className={c.status === "verified" ? "text-success-ink" : c.status === "attested" ? "text-violet-ink" : c.status === "failed" ? "text-danger-ink" : "text-warning-ink"}>
              {c.status === "verified" ? "Verified" : c.status === "attested" ? "Attested by agency" : c.status === "failed" ? "Failing" : "Not verified"}
            </span>
          </li>
        ))}
      </ul>
      {attested.length > 0 && (
        <div className="space-y-2 rounded-xl border border-violet/25 bg-violet-soft/60 p-3">
          <p className="flex items-start gap-2 text-[13px] text-violet-ink">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            {attested.length} check{attested.length === 1 ? " has" : "s have"} agency evidence awaiting technical verification: {attested.map((k) => CHECK_LABEL[k]).join(", ")}.
          </p>
          <CheckRow id="act-ack" label="I have reviewed this evidence; technical verification is still required" checked={ack} onChange={setAck} />
        </div>
      )}
      {!snapshot.readiness.canActivate && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Not ready yet: {snapshot.readiness.blockers[0]?.message}
        </p>
      )}
      <Field label="Note" htmlFor="act-note" optional hint="Internal. Recorded with the approval.">
        <Textarea id="act-note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
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
          Approve activation
        </Button>
      </div>
    </div>
  );
}
