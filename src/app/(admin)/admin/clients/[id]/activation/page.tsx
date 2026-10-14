import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { withUser } from "@/server/db";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
export const metadata = { title: "Activation readiness" };
export default async function ActivationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  const snapshot = await getAgencySetupSnapshot(user, id);
  const reviews = await withUser(user.id, (db) => db.query<{ id: string; decision: string; note: string; created_at: Date; full_name: string }>("select r.id, r.decision, r.note, r.created_at, u.full_name from activation_reviews r join users u on u.id = r.reviewed_by where r.org_id = $1 order by r.created_at desc limit 50", [id]));
  return <div className="space-y-5"><Link href={`/admin/clients/${id}/setup`} className="text-sm text-muted hover:text-ink">← Client setup and agency approval</Link><div><h1 className="text-2xl font-semibold text-ink">{snapshot.org.name} · Activation readiness</h1><p className="mt-2 text-sm text-muted">Required tasks, client approvals and current provider verification must pass before an agency super admin approves the portal. External live activation needs separate authorization.</p></div>
    <Card><CardHeader><CardTitle>Readiness review</CardTitle><Badge tone={snapshot.readiness.canActivate ? "success" : "warning"}>{snapshot.readiness.canActivate ? "Ready for agency review" : "Blocked"}</Badge></CardHeader><CardContent><p className="mb-3 text-sm text-ink">{snapshot.progress.completed} of {snapshot.progress.total} required preparation steps completed.</p><ul className="space-y-2">{snapshot.readiness.blockers.map((b, i) => <li key={i} className="rounded-lg bg-warning-soft p-3 text-sm text-warning-ink">{b.message}</li>)}</ul><div className="mt-5 grid gap-3 sm:grid-cols-2">{snapshot.checks.map((check) => <div key={check.key} className="rounded-xl border border-line p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium text-ink">{check.label}</h2><Badge tone={check.status === "verified" ? "success" : check.status === "failed" ? "danger" : "neutral"}>{check.status === "attested" ? "Evidence only" : check.status}</Badge></div><p className="mt-2 break-words text-xs text-muted">{check.detail ?? "No provider test recorded."}</p></div>)}</div></CardContent></Card>
    <Card><CardHeader><CardTitle>Agency review history</CardTitle></CardHeader><CardContent>{reviews.rows.length === 0 ? <p className="text-sm text-muted">No approval decisions have been recorded.</p> : <ol className="space-y-3">{reviews.rows.map((r) => <li key={r.id} className="rounded-xl border border-line p-3 text-sm"><p className="font-medium text-ink">{r.decision} · {r.full_name}</p><time className="text-xs text-muted" dateTime={new Date(r.created_at).toISOString()}>{new Date(r.created_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })} SGT</time>{r.note && <p className="mt-2 break-words text-muted">{r.note}</p>}</li>)}</ol>}</CardContent></Card>
  </div>;
}
