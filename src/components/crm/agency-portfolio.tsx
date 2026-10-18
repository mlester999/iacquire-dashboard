import Link from "next/link";
import { Contact } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { CRM_MODE_LABELS } from "@/lib/crm/types";
import type { AgencyCrmRow } from "@/server/crm/agency";
import { RelativeTime } from "@/components/crm/relative-time";

/** Counts across client CRMs, with no client records on the page. Opening one goes through its support-session gate. */
export function AgencyCrmPortfolio({ rows }: { rows: AgencyCrmRow[] }) {
  const totals = rows.reduce((t, r) => ({ contacts: t.contacts + r.contacts, deals: t.deals + r.openDeals, overdue: t.overdue + r.overdueTasks, native: t.native + (r.mode === "native" ? 1 : 0) }), { contacts: 0, deals: 0, overdue: 0, native: 0 });
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">Client CRMs</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
          Counts only. Client records belong to the client: opening one asks for a reason, is time-limited, and shows up in the client&rsquo;s Support Access log.
        </p>
        <Link href="/admin/crm/reports" className="mt-2 inline-flex min-h-11 items-center text-[13px] font-medium text-primary hover:underline sm:min-h-8">CRM operations report: failures, setup, billing and support across clients</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Workspaces", value: rows.length, sub: `${totals.native} on iAcquire CRM` },
          { label: "Contacts", value: totals.contacts, sub: "Across your clients" },
          { label: "Open deals", value: totals.deals, sub: "In native pipelines" },
          { label: "Overdue tasks", value: totals.overdue, sub: "Across your clients" },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <p className="text-[12.5px] font-medium text-muted">{s.label}</p>
            <p className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-ink tabular-nums">{s.value.toLocaleString("en-US")}</p>
            <p className="text-[12px] text-faint">{s.sub}</p>
          </Card>
        ))}
      </div>
      {!rows.length ? (
        <Card><EmptyState icon={<Contact className="size-5" />} title="No client workspaces" description="Clients you're assigned to appear here." /></Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-[13px]">
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">Client</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">CRM</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Contacts</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">New (7 days)</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Open deals</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Overdue tasks</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Last activity</th>
                  <th scope="col" className="px-3 py-2.5"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.orgId} className="hover:bg-surface-2/50">
                    <td className="px-4 py-2.5">
                      <Link href={`/admin/clients/${r.orgId}`} className="font-medium text-ink hover:text-primary">{r.name}</Link>
                      {r.status !== "active" && <Badge tone="neutral" className="ml-2 capitalize">{r.status}</Badge>}
                    </td>
                    <td className="px-3 py-2.5"><Badge tone={r.mode === "native" ? "primary" : "warning"}>{CRM_MODE_LABELS[r.mode].label}</Badge></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.contacts.toLocaleString("en-US")}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.newContacts7d.toLocaleString("en-US")}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.openDeals.toLocaleString("en-US")}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.overdueTasks ? <span className="font-medium text-danger-ink">{r.overdueTasks}</span> : 0}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">{r.lastActivityAt ? <RelativeTime iso={r.lastActivityAt} /> : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <Link href={`/admin/clients/${r.orgId}/crm`} className="inline-flex min-h-9 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-primary hover:bg-primary-soft">
                        {r.mySession ? `Continue (${r.mySession.mode === "write" ? "changes" : "view only"})` : "Open CRM"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
