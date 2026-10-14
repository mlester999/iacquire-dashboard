"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, CheckCircle2, Copy, Crown, LockKeyhole, Mail, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { inviteStaffAction } from "@/app/(admin)/admin/actions";

export function InviteStaff({ clients = [] }: { clients?: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"agency_staff" | "agency_super_admin">("agency_staff");
  const [link, setLink] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error,setError] = React.useState<string|null>(null);
  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" /> Invite staff
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setLink(null);
        }}
        title={link ? "Invitation prepared" : "Make room for your next teammate."}
        description={link ? "A secure invitation was created for this account." : "Set their role and review the access boundary before inviting them."}
        footer={
          link ? (
            <Button onClick={() => setOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                loading={pending}
                disabled={!email.includes("@")}
                onClick={async () => {
                  setPending(true);
                  const res = await inviteStaffAction(email, role);
                  setPending(false);
                  if (!res.ok) { setError(res.error); return; }
                  setError(null);
                  setLink(res.data.link);
                  router.refresh();
                }}
              >
                Create invitation
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="space-y-4"><div className="rounded-2xl border border-success/20 bg-success-soft p-4"><CheckCircle2 className="mb-3 size-7 text-success"/><p className="font-semibold text-success-ink">Ready for {email}</p><p className="mt-1 text-[13px] text-success-ink">{role === "agency_super_admin" ? "Super admin access to every client" : "Agency staff access; client assignments follow account acceptance"}</p></div><div className="flex items-center gap-2 rounded-xl bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate px-2 text-[12px]">{link}</code>
            <Button size="sm" variant="ghost" aria-label="Copy secure invitation link" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}>
              <Copy className="size-3.5" />
            </Button>
          </div><p className="text-[12px] text-muted">Share this private link directly with the invited person. The invitation remains pending until they accept.</p></div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary"><Mail className="size-3.5"/>01 · Their account</div>
            <Field label="Work email" htmlFor="staff-email">
              <Input id="staff-email" type="email" autoComplete="email" placeholder="teammate@youragency.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <div className="border-t border-line pt-4"><p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">02 · Their role</p><div role="radiogroup" aria-label="Invitation role" className="space-y-2">{([{key:"agency_staff",label:"Agency staff",description:"Focused access to explicitly assigned clients.",icon:ShieldCheck},{key:"agency_super_admin",label:"Agency super admin",description:"Full agency control, team management and infrastructure credentials.",icon:Crown}] as const).map(r=><button key={r.key} role="radio" aria-checked={role===r.key} type="button" onClick={()=>setRole(r.key)} className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition ${role===r.key?"border-primary/35 bg-primary-soft":"border-line bg-surface hover:bg-surface-2"}`}><span className={`grid size-9 shrink-0 place-items-center rounded-xl ${role===r.key?"bg-primary text-white":"bg-surface-2 text-muted"}`}><r.icon className="size-4"/></span><span><span className="block text-sm font-semibold text-ink">{r.label}</span><span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{r.description}</span></span>{role===r.key&&<CheckCircle2 className="ml-auto mt-1 size-4 shrink-0 text-primary"/>}</button>)}</div></div>
            <div className="rounded-2xl border border-line bg-surface-2/70 p-4"><p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted"><LockKeyhole className="size-3.5"/>03 · Access preview</p><div className="mt-3 flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-[13px] font-medium text-ink"><Building2 className="size-4 text-primary"/>Client assignments</span><Badge tone={role==="agency_super_admin"?"violet":"neutral"}>{role==="agency_super_admin"?`All ${clients.length} clients`:"None at invitation"}</Badge></div><p className="mt-3 text-[12.5px] leading-relaxed text-muted">{role==="agency_staff"?"After they accept, use their team drawer or a client's Team & staff tab to assign workspaces. Staff cannot manage global secrets or approve activation.":"This role can manage every workspace, edit team access, resolve global infrastructure credentials and approve final readiness."}</p></div>
            {error&&<p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}
