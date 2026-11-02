"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { requeueProvisioningAction } from "@/app/(admin)/admin/actions";
import { requestDeprovisionAction, requestFleetSyncAction } from "@/app/(admin)/admin/provisioning-actions";
import { revokeClientBusinessAccess, setClientBusinessToolsAction } from "@/app/actions/client-business-access";

/**
 * The agency's one calm place for the runtime controls of a client workspace: ask for a setup to be retried, contain one employee's runtime profile, synchronize the client runtime, end
 * the workspace's business-tool access, and switch its business-tool tiers. Nothing here decides anything. Each button opens a confirmation that says plainly what will happen, asks
 * for a reason of at least five characters, calls the server action (which checks the permission again and refuses an agency's or a demo's workspace), and then shows what the SERVER
 * said: a success only when the server reports one, the server's own words when it refuses. A control whose deployment switch is off is shown disabled with the reason, never hidden.
 *
 * It is given nothing for anyone but a Super Admin looking at a real client workspace (the page passes `null`), and so renders nothing for anyone else.
 */

export interface RuntimeControlsData {
  orgId: string;
  /** The deployment's own switches, read on the server. */
  flags: { provisioner: boolean; deprovision: boolean; clientTools: boolean };
  /** The workspace's own business-tool tiers. */
  tiers: { tools: boolean; proposals: boolean };
  employees: Array<{ id: string; name: string; enabled: boolean; hasProfile: boolean }>;
}

/** The words shown beside a control whose deployment switch is off. */
export const SWITCHED_OFF_REASON = "Turned off in this deployment";
const MIN_REASON = 5;

type Outcome = { ok: true; message: string } | { ok: false; message: string };
type ServerResult = { ok: true; data?: unknown } | { ok: false; error: string };

interface Control {
  key: string;
  label: string;
  buttonLabel: string;
  title: string;
  /** What the confirmation says will happen, in plain words. */
  confirm: string;
  tone: "brand" | "danger";
  /** Set when the control cannot be used right now; shown beside it. */
  disabled: string | null;
  run: (reason: string) => Promise<ServerResult>;
  /** The sentence for a success the server reported, built from what it returned. */
  done: (data: unknown) => string;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const count = (value: unknown) => (typeof value === "number" ? value : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function buildControls(data: RuntimeControlsData): { setup: Control[]; contain: Control[]; fleet: Control; access: Control[]; tiers: Control[] } {
  const { orgId, flags, tiers } = data;
  const provisionerOff = flags.provisioner ? null : SWITCHED_OFF_REASON;
  const setup = data.employees.filter((e) => e.enabled).map<Control>((e) => ({
    key: `setup-${e.id}`,
    label: e.name,
    buttonLabel: "Retry setup",
    title: `Retry ${e.name}'s setup?`,
    confirm: "Opens one new setup request for this employee, in place of one that failed or was cancelled. Nothing happens to a request that is still running or will retry by itself, and the client's owners are told.",
    tone: "brand",
    // A retry only opens a request that waits for the worker, so it does not depend on any deployment switch.
    disabled: null,
    run: (reason) => requeueProvisioningAction(orgId, e.id, reason),
    done: () => "A new setup request was opened. It waits for the restricted worker.",
  }));
  const contain = data.employees.filter((e) => e.hasProfile).map<Control>((e) => ({
    key: `contain-${e.id}`,
    label: e.name,
    buttonLabel: "Contain",
    title: `Contain ${e.name}'s runtime profile?`,
    confirm: "This is containment, not deletion. The profile's key is replaced with one nobody is given and its tools are switched off, and the worker proves both before anything is recorded. The profile, its history and its settings stay. The employee stops working until its setup is run again, and the client's access to it ends.",
    tone: "danger",
    disabled: flags.deprovision ? null : SWITCHED_OFF_REASON,
    run: (reason) => requestDeprovisionAction(orgId, e.id, reason),
    done: (d) => (asRecord(d).alreadyOpen === true
      ? "A containment request was already open for this employee, so nothing new was requested."
      : "Containment was requested. Nothing is changed until the worker proves it; the employee is marked not set up only then."),
  }));
  const fleet: Control = {
    key: "fleet",
    label: "The whole client runtime",
    buttonLabel: "Synchronize",
    title: "Synchronize the client runtime?",
    confirm: "Asks the restricted worker to bring every provisioned client employee's profile in line with its applied configuration again, at most 200 employees at a time. An employee that already has a request open is left alone, so pressing it again is safe. This covers every client, not only this one.",
    tone: "brand",
    disabled: provisionerOff,
    run: (reason) => requestFleetSyncAction(reason),
    done: (d) => {
      const r = asRecord(d);
      const queued = Array.isArray(r.queued) ? r.queued.length : 0;
      return `Asked for ${plural(queued, "synchronization", "synchronizations")}; ${plural(count(r.alreadyOpen), "employee was", "employees were")} already waiting and ${count(r.skipped)} had nothing to synchronize.${r.truncated === true ? " More employees qualify than one request takes: press it again." : ""}`;
    },
  };
  const toolsOff = flags.clientTools ? null : SWITCHED_OFF_REASON;
  const access: Control[] = [{
    key: "revoke-access",
    label: "All business-tool access",
    buttonLabel: "End access",
    title: "End this workspace's business-tool access?",
    confirm: "Ends every business-tool credential of this workspace at once: its employees can no longer read the client's records through the business tools. This is the emergency lever. The employees are not deleted, and access can be issued again by synchronizing their profiles.",
    tone: "danger",
    disabled: null,
    run: (reason) => revokeClientBusinessAccess({ orgId, reason }),
    done: (d) => `Ended ${plural(count(asRecord(d).revoked), "credential", "credentials")}.`,
  }];
  const tierControls: Control[] = [
    { name: "tools", label: "Business tools (reads)", on: tiers.tools, what: "read the client's own records" },
    { name: "proposals", label: "Change proposals", on: tiers.proposals, what: "propose changes that wait for a person's approval" },
  ].map(({ name, label, on, what }) => ({
    key: `tier-${name}`,
    label,
    buttonLabel: on ? "Turn off" : "Turn on",
    title: `Turn ${label.toLowerCase()} ${on ? "off" : "on"} for this workspace?`,
    confirm: on
      ? `The workspace's employees stop being able to ${what}. Their profiles are synchronized to match, and each reads as not online until that has been done and checked.`
      : `The workspace's employees will be able to ${what}. Their profiles are synchronized to match, and each reads as not online until that has been done and checked.`,
    tone: on ? "danger" : "brand",
    disabled: toolsOff,
    run: (reason) => setClientBusinessToolsAction({ orgId, [name]: !on, reason }),
    done: (d) => (asRecord(d).changed === true ? `Switched ${on ? "off" : "on"}; ${plural(count(asRecord(d).queued), "synchronization was", "synchronizations were")} requested.` : "It was already that way, so nothing changed."),
  }));
  return { setup, contain, fleet, access, tiers: tierControls };
}

export function RuntimeControls({ data }: { data: RuntimeControlsData | null }) {
  const router = useRouter();
  const [open, setOpen] = React.useState<Control | null>(null);
  const [reason, setReason] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [last, setLast] = React.useState<Outcome | null>(null);
  if (!data) return null;
  const controls = buildControls(data);

  const press = async () => {
    if (!open || reason.trim().length < MIN_REASON) return;
    setPending(true);
    let outcome: Outcome;
    try {
      const result = await open.run(reason.trim());
      outcome = result.ok ? { ok: true, message: open.done(result.data) } : { ok: false, message: result.error };
    } catch {
      outcome = { ok: false, message: "The request could not be sent. Nothing was changed; try again." };
    }
    setPending(false);
    setLast(outcome);
    if (outcome.ok) {
      toast.success(outcome.message);
      setOpen(null);
      setReason("");
      router.refresh();
    } else {
      toast.error(outcome.message);
    }
  };

  const row = (c: Control) => (
    <li key={c.key} className="flex flex-wrap items-center justify-between gap-3 py-2">
      <span className="min-w-0 text-[14px] text-ink">{c.label}</span>
      <span className="flex items-center gap-3">
        {c.disabled ? <span className="text-[12.5px] text-muted">{c.disabled}</span> : null}
        <Button variant="secondary" size="sm" disabled={Boolean(c.disabled)} aria-label={`${c.buttonLabel}: ${c.label}`} onClick={() => { setReason(""); setOpen(c); }}>
          {c.buttonLabel}
        </Button>
      </span>
    </li>
  );
  const group = (title: string, hint: string, items: Control[], empty: string) => (
    <section className="space-y-1" aria-label={title}>
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <p className="text-[13px] text-muted">{hint}</p>
      {items.length ? <ul className="divide-y divide-line">{items.map(row)}</ul> : <p className="py-2 text-[13px] text-muted">{empty}</p>}
    </section>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Runtime controls <Badge tone="neutral">Super Admin</Badge></CardTitle>
        <CardDescription>Each press asks the server and shows what it said. Nothing is done by this page itself, and each action is recorded.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {group("Setup", "Retry an employee's setup after it failed or was cancelled.", controls.setup, "No employee of this workspace is in its plan.")}
        {group("Containment", "Replace a runtime profile's key and switch its tools off. Nothing is deleted.", controls.contain, "No employee of this workspace has a runtime profile.")}
        {group("Client runtime", "Bring every provisioned profile in line again.", [controls.fleet], "")}
        {group("Business tools", "Switch the workspace's tiers on or off, or end its access.", [...controls.tiers, ...controls.access], "")}
        <div aria-live="polite" role="status" className="min-h-5 text-[13px]">
          {last ? <span className={last.ok ? "text-success" : "text-danger"}>{last.ok ? "Done: " : "Not done: "}{last.message}</span> : null}
        </div>
      </CardContent>
      <Dialog
        open={Boolean(open)}
        onOpenChange={(o) => { if (!o && !pending) setOpen(null); }}
        title={open?.title ?? "Runtime control"}
        description={open?.confirm}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(null)} disabled={pending}>Cancel</Button>
            <Button variant={open?.tone ?? "brand"} disabled={reason.trim().length < MIN_REASON} loading={pending} onClick={press}>{open?.buttonLabel ?? "Confirm"}</Button>
          </>
        }
      >
        <Field label="Reason (kept in the audit log, not shown to the client)" htmlFor="runtime-control-reason" hint={`At least ${MIN_REASON} characters.`}>
          <Textarea id="runtime-control-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
      </Dialog>
    </Card>
  );
}
