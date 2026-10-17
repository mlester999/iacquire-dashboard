"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, CheckCircle2, Copy, Mail, ShieldCheck, UserPlus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { inviteStaffAction } from "@/app/(admin)/admin/actions";

type TeamRole = "agency_staff" | "agency_manager";
type ScopeMode = "all_clients" | "assigned_clients";
type Delivery = { status: string; error: string | null };

export function InviteStaff({ clients = [] }: { clients?: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<TeamRole>("agency_staff");
  const [scopeMode, setScopeMode] = React.useState<ScopeMode>("assigned_clients");
  const [clientIds, setClientIds] = React.useState<string[]>([]);
  const [link, setLink] = React.useState<string | null>(null);
  const [delivery, setDelivery] = React.useState<Delivery | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const begin = () => {
    setLink(null); setDelivery(null); setError(null); setEmail(""); setRole("agency_staff");
    setScopeMode("assigned_clients"); setClientIds([]); setOpen(true);
  };

  const invite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      const res = await inviteStaffAction(email, role, scopeMode, scopeMode === "assigned_clients" ? clientIds : []);
      if (!res.ok) { setError(res.error); return; }
      setLink(res.data.link); setDelivery(res.data.delivery); router.refresh();
    } catch {
      setError("The invitation could not be confirmed. Check pending invitations before trying again.");
    } finally { setPending(false); }
  };

  const deliveryCopy = delivery?.status === "sent"
    ? "The email provider accepted the invitation email."
    : delivery?.status === "queued"
      ? "The invitation email is queued. Delivery is not confirmed yet."
      : delivery?.status === "captured"
        ? "The invitation was captured in the development mailbox; it was not delivered."
        : delivery?.status === "failed"
          ? "The invitation email failed. Fix the email-provider configuration, or securely share this one-time link."
          : "Email delivery could not be confirmed. Do not assume the invitee received an email.";

  return (
    <>
      <Button variant="brand" onClick={begin}><UserPlus className="size-4" /> Invite teammate</Button>
      <Dialog
        open={open}
        onOpenChange={(value) => { if (!value && pending) return; setOpen(value); if (!value) setLink(null); }}
        title={link ? "Invitation created" : "Invite an agency teammate"}
        description={link ? "The invitation is single-use and expires in seven days." : "Choose their role, client scope and any initial assignments."}
        footer={link ? <Button onClick={() => { setOpen(false); setLink(null); }}>Done</Button> : <>
          <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button loading={pending} disabled={!email.includes("@")} type="submit" form="staff-invitation-form">Create invitation</Button>
        </>}
      >
        {link ? (
          <div className="space-y-4">
            <div className={`rounded-2xl border p-4 ${delivery?.status === "sent" ? "border-success/20 bg-success-soft" : delivery?.status === "failed" ? "border-danger/20 bg-danger-soft" : "border-warning/20 bg-warning-soft"}`}>
              <CheckCircle2 className="mb-3 size-7 text-primary" />
              <p className="font-semibold text-ink">Invitation created for {email}</p>
              <p className="mt-1 text-[13px] text-muted">{deliveryCopy}</p>
              <p className="mt-2 text-[12px] text-muted">{role === "agency_manager" ? scopeMode === "all_clients" ? "Agency Manager · All current and future clients" : "Agency Manager · Assigned clients only" : `Agency Staff · ${clientIds.length} initial assignment${clientIds.length === 1 ? "" : "s"}`}</p>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-surface-2 p-2">
              <code className="min-w-0 flex-1 truncate px-2 text-[12px]">{link}</code>
              <Button size="sm" variant="ghost" aria-label="Copy secure invitation link" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}><Copy className="size-3.5" /></Button>
            </div>
            <p className="text-[12px] text-muted">Share this private link only with {email}. It is single-use and cannot grant Super Admin ownership.</p>
          </div>
        ) : (
          <form id="staff-invitation-form" className="space-y-5" onSubmit={invite}>
            <Field label="Work email" htmlFor="staff-email">
              <Input id="staff-email" type="email" required autoComplete="email" placeholder="teammate@youragency.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <section className="space-y-3 border-t border-line pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Role</p>
              {([
                { key: "agency_manager", label: "Agency Manager", description: "Works across clients by default. Cannot manage agency credentials, team roles or security settings.", icon: ShieldCheck },
                { key: "agency_staff", label: "Agency Staff", description: "Works with assigned clients only. No client access is granted until assignments are selected.", icon: Workflow },
              ] as const).map((item) => <label key={item.key} className={`relative flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${role === item.key ? "border-primary/35 bg-primary-soft" : "border-line bg-surface hover:bg-surface-2"}`}>
                <input type="radio" className="sr-only" name="staff-invitation-role" value={item.key} checked={role === item.key} onChange={() => { setRole(item.key); setScopeMode(item.key === "agency_manager" ? "all_clients" : "assigned_clients"); }} />
                <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${role === item.key ? "bg-primary text-white" : "bg-surface-2 text-muted"}`}><item.icon className="size-4" /></span>
                <span><span className="block text-sm font-semibold text-ink">{item.label}</span><span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{item.description}</span></span>
                {role === item.key && <CheckCircle2 className="ml-auto mt-1 size-4 shrink-0 text-primary" />}
              </label>)}
            </section>

            {role === "agency_manager" && <section className="space-y-2 border-t border-line pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Client access</p>
              {([
                { key: "all_clients", title: "All current and future clients", detail: "New client workspaces are included automatically." },
                { key: "assigned_clients", title: "Assigned clients only", detail: "The manager can access only the clients selected below." },
              ] as const).map((option) => <label key={option.key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
                <input type="radio" name="manager-scope" checked={scopeMode === option.key} onChange={() => setScopeMode(option.key)} className="mt-1 accent-primary" />
                <span><span className="block text-[13px] font-medium text-ink">{option.title}</span><span className="mt-1 block text-[12px] text-muted">{option.detail}</span></span>
              </label>)}
            </section>}

            {scopeMode === "assigned_clients" && <section className="space-y-2 border-t border-line pt-4">
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary"><Building2 className="size-3.5" />Initial client assignments</p>
              {clients.length ? <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
                {clients.map((client) => <label key={client.id} className="flex min-h-10 items-center gap-3 rounded-lg px-2 hover:bg-surface-2">
                  <input type="checkbox" checked={clientIds.includes(client.id)} onChange={(event) => setClientIds((current) => event.target.checked ? [...current, client.id] : current.filter((id) => id !== client.id))} className="size-4 accent-primary" />
                  <span className="text-[13px] text-ink">{client.name}</span>
                </label>)}
              </div> : <p className="rounded-xl bg-surface-2 p-3 text-[12px] text-muted">No client workspaces are available to assign yet.</p>}
              <p className="text-[12px] text-muted">No clients will be accessible unless an assignment is selected here or added later.</p>
            </section>}

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface-2/70 p-4">
              <span className="flex items-center gap-2 text-[13px] font-medium text-ink"><Mail className="size-4 text-primary" />Secure invitation</span>
              <Badge tone={scopeMode === "all_clients" ? "violet" : "neutral"}>{scopeMode === "all_clients" ? "All clients" : `${clientIds.length} selected`}</Badge>
            </div>
            {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
          </form>
        )}
      </Dialog>
    </>
  );
}
