"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Clock,
  FileEdit,
  Info,
  MessageSquareWarning,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Textarea } from "@/components/ui/primitives";
import { Dialog, Sheet, Tabs } from "@/components/ui/overlays";
import { PageHero,CoverageBar } from "@/components/ui/workspace";
import { approvalEventsAction, decideApprovalAction } from "@/app/actions/approvals";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";

interface Approval {
  id: string;
  kind: string;
  title: string;
  target_type: string | null;
  target_label: string | null;
  reason: string;
  expected_effect: string;
  risk: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "rejected" | "changes_requested" | "expired" | "cancelled";
  execution_status: string;
  execution_detail: string | null;
  expires_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  agent_role: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
}

const KIND_LABEL: Record<string, string> = {
  lead_import: "Import leads",
  outreach: "Outreach",
  follow_up_message: "Follow-up message",
  crm_update: "CRM update",
  campaign_activation: "Campaign activation",
  knowledge_change: "Knowledge change",
  tool_action: "Agent tool action",
  config_change: "Configuration change",
};

const RISK: Record<Approval["risk"], { tone: "success" | "primary" | "warning" | "danger"; label: string }> = {
  low: { tone: "success", label: "Low risk" },
  medium: { tone: "primary", label: "Medium risk" },
  high: { tone: "warning", label: "High risk" },
  critical: { tone: "danger", label: "Critical" },
};

const STATUS: Record<Approval["status"], { tone: "warning" | "success" | "danger" | "neutral" | "violet"; label: string }> = {
  pending: { tone: "warning", label: "Pending" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
  changes_requested: { tone: "violet", label: "Changes requested" },
  expired: { tone: "neutral", label: "Expired" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

function Requester({ a }: { a: Approval }) {
  if (a.agent_role && isAgentRoleKey(a.agent_role)) {
    const meta = AGENT_BY_KEY[a.agent_role];
    return (
      <span className="flex items-center gap-2">
        <AgentAvatar role={meta} size="xs" /> <span className="text-[12.5px] text-ink-2">{meta.shortName}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-[12.5px] text-ink-2">
      <span className="flex size-6 items-center justify-center rounded-md bg-surface-2">
        <User className="size-3.5" />
      </span>
      {a.requested_by_name ?? "System"}
    </span>
  );
}

export function ApprovalCenter({ approvals, canDecide, canDecideHigh, timeZone }: { approvals: Approval[]; canDecide: boolean; canDecideHigh: boolean; timeZone: string }) {
  const router = useRouter();
  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");
  const [tab, setTab] = React.useState(pending.length ? "pending" : "history");
  const [selected, setSelected] = React.useState<Approval | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [noteFor, setNoteFor] = React.useState<{ a: Approval; decision: "reject" | "request_changes" } | null>(null);
  const [note, setNote] = React.useState("");

  const decide = async (a: Approval, decision: "approve" | "reject" | "request_changes", n?: string) => {
    if (busy) return;
    setBusy(a.id);
    const res = await decideApprovalAction(a.id, decision, n);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error);
      router.refresh();
      return;
    }
    const outcome = res.data.outcome;
    if (decision !== "approve") toast.success(decision === "reject" ? "Rejected — it won't run" : "Changes requested");
    else if (!outcome || outcome.status === "succeeded") toast.success("Approved", { description: outcome?.detail });
    else if (outcome.status === "blocked") toast.warning("Approved, but held", { description: outcome.detail });
    else toast.error("Approved, but it couldn't run", { description: outcome.detail });
    setSelected(null);
    setNoteFor(null);
    setNote("");
    router.refresh();
  };

  const list = tab === "pending" ? pending : history;

  return (
    <div className="space-y-6">
      <PageHero eyebrow="Human control, by design" title="Your team's ideas. Your final say." description="Review what your AI employees propose before customer-facing or CRM actions run. Every decision stays in the history; rejected or expired requests never execute." icon={<ShieldCheck className="size-4"/>} tone="neutral" aside={<div className="rounded-2xl border border-line bg-surface p-5"><p className="text-[11px] font-medium uppercase tracking-wider text-muted">Decision queue</p><p className="mt-2 text-[36px] font-semibold tracking-tight">{pending.length}<span className="ml-2 text-[13px] font-normal tracking-normal text-muted">awaiting review</span></p><div className="mt-3"><CoverageBar label="Approval request status" parts={[{label:"Pending",count:pending.length,color:"var(--warning)"},{label:"History",count:history.length,color:"var(--primary)"}]}/></div></div>}/>
      {!canDecide && (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-muted">
          <Info className="size-4" /> You can view approvals. Workspace owners and admins make the decisions.
        </p>
      )}
      <Tabs
        id="approvals"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "pending", label: "Pending", count: pending.length },
          { value: "history", label: "History", count: history.length },
        ]}
      >
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<ShieldCheck className="size-5" />} title={tab === "pending" ? "Nothing waiting for you" : "No decisions yet"} description={tab === "pending" ? "When an AI employee needs your go-ahead, it will appear here and in your notifications." : "Approved, rejected and expired requests will be listed here."} />
        </Card>
      ) : (
        <ul className="space-y-3">
          <AnimatePresence initial={false}>
            {list.map((a, i) => {
              const highRiskBlocked = (a.risk === "high" || a.risk === "critical") && !canDecideHigh;
              return (
                <motion.li key={a.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} transition={{ duration: 0.25, delay: i * 0.02 }}>
                  <Card className={cn("overflow-hidden border-l-[3px] transition hover:shadow-float",a.risk==="high"||a.risk==="critical"?"border-l-warning":"border-l-primary")}>
                    <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center">
                      <button type="button" onClick={() => setSelected(a)} className="min-w-0 flex-1 text-left">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="outline">{KIND_LABEL[a.kind] ?? sentenceCase(a.kind)}</Badge>
                          <Badge tone={RISK[a.risk].tone}>{a.risk === "high" || a.risk === "critical" ? <AlertTriangle className="size-3" /> : null}{RISK[a.risk].label}</Badge>
                          {a.status !== "pending" && <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>}
                          {a.status === "approved" && a.execution_status === "blocked" && <Badge tone="neutral">Held — integration not enabled</Badge>}
                          {a.status === "approved" && a.execution_status === "succeeded" && <Badge tone="success">Completed</Badge>}
                          {a.status === "approved" && a.execution_status === "failed" && <Badge tone="danger">Failed</Badge>}
                        </div>
                        <p className="mt-2 text-[15px] font-semibold text-ink">{a.title}</p>
                        {a.target_label && <p className="mt-0.5 truncate text-[13px] text-muted">Target: {a.target_label}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-faint">
                          <Requester a={a} />
                          <span>{relativeTime(a.created_at)}</span>
                          {a.status === "pending" && a.expires_at && (
                            <span className="flex items-center gap-1">
                              <Clock className="size-3" /> Expires {relativeTime(a.expires_at)}
                            </span>
                          )}
                        </div>
                      </button>
                      {a.status === "pending" && canDecide && (
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setNoteFor({ a, decision: "request_changes" })} disabled={busy === a.id}>
                            <FileEdit className="size-3.5" /> Request changes
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setNoteFor({ a, decision: "reject" })} disabled={busy === a.id}>
                            <X className="size-3.5" /> Reject
                          </Button>
                          <Button size="sm" variant="brand" loading={busy === a.id} disabled={highRiskBlocked} title={highRiskBlocked ? "Needs the workspace owner" : undefined} onClick={() => decide(a, "approve")}>
                            <Check className="size-3.5" /> Approve
                          </Button>
                        </div>
                      )}
                    </div>
                  </Card>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      </Tabs>
      <ApprovalSheet approval={selected} onClose={() => setSelected(null)} timeZone={timeZone} />

      <Dialog
        open={Boolean(noteFor)}
        onOpenChange={(o) => !o && setNoteFor(null)}
        title={noteFor?.decision === "reject" ? "Reject this request?" : "Request changes"}
        description={noteFor?.decision === "reject" ? "It won't run. Add a note so your team knows why (optional)." : "Explain what should be different. The request won't run."}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNoteFor(null)}>
              Cancel
            </Button>
            <Button
              variant={noteFor?.decision === "reject" ? "danger" : "primary"}
              loading={Boolean(noteFor && busy === noteFor.a.id)}
              disabled={noteFor?.decision === "request_changes" && !note.trim()}
              onClick={() => noteFor && decide(noteFor.a, noteFor.decision, note)}
            >
              {noteFor?.decision === "reject" ? "Reject" : "Send"}
            </Button>
          </>
        }
      >
        <Field label="Note" htmlFor="approval-note" optional={noteFor?.decision === "reject"}>
          <Textarea id="approval-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} />
        </Field>
      </Dialog>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: "Requested",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  expired: "Expired",
  cancelled: "Cancelled",
  execution_started: "Started running",
  execution_succeeded: "Completed",
  execution_failed: "Failed",
  execution_blocked: "Held",
};

function ApprovalSheet({ approval, onClose, timeZone }: { approval: Approval | null; onClose: () => void; timeZone: string }) {
  // Events are tagged with their approval so a stale list never shows for a different item.
  const [loaded, setLoaded] = React.useState<{ id: string; events: Array<{ event: string; note: string | null; created_at: string; actor_kind: string; actor_name: string | null }> } | null>(null);
  const events = approval && loaded?.id === approval.id ? loaded.events : null;
  React.useEffect(() => {
    if (!approval) return;
    let live = true;
    approvalEventsAction(approval.id).then((r) => live && setLoaded({ id: approval.id, events: r.ok ? r.data : [] }));
    return () => {
      live = false;
    };
  }, [approval]);
  return (
    <Sheet open={Boolean(approval)} onOpenChange={(o) => !o && onClose()} title={approval?.title ?? "Approval"} description={approval ? (KIND_LABEL[approval.kind] ?? approval.kind) : undefined}>
      {approval && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap gap-2">
            <Badge tone={RISK[approval.risk].tone}>{RISK[approval.risk].label}</Badge>
            <Badge tone={STATUS[approval.status].tone}>{STATUS[approval.status].label}</Badge>
          </div>
          <dl className="space-y-4 text-[13.5px]">
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Requested by</dt>
              <dd className="mt-1">
                <Requester a={approval} />
              </dd>
            </div>
            {approval.target_label && (
              <div>
                <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Target</dt>
                <dd className="mt-1 text-ink">{approval.target_label}</dd>
              </div>
            )}
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Why</dt>
              <dd className="mt-1 leading-relaxed text-ink">{approval.reason || "—"}</dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Expected effect</dt>
              <dd className="mt-1 leading-relaxed text-ink">{approval.expected_effect || "—"}</dd>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Created</dt>
                <dd className="mt-1">{formatDateTime(approval.created_at, timeZone)}</dd>
              </div>
              <div>
                <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Expires</dt>
                <dd className="mt-1">{approval.expires_at ? formatDateTime(approval.expires_at, timeZone) : "No expiry"}</dd>
              </div>
            </div>
            {approval.execution_detail && (
              <div className="rounded-xl bg-surface-2 p-3">
                <dt className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
                  {approval.execution_status === "succeeded" ? <CheckCircle2 className="size-3.5 text-success" /> : approval.execution_status === "blocked" ? <Ban className="size-3.5" /> : <MessageSquareWarning className="size-3.5 text-danger" />}
                  Outcome
                </dt>
                <dd className="mt-1 text-[13px] text-ink">{approval.execution_detail}</dd>
              </div>
            )}
            {approval.decision_note && (
              <div>
                <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Decision note</dt>
                <dd className="mt-1 italic text-ink-2">“{approval.decision_note}”</dd>
              </div>
            )}
          </dl>
          <div>
            <p className="mb-3 text-[12px] font-medium uppercase tracking-wider text-faint">Activity</p>
            {events === null ? (
              <div className="space-y-2">
                <div className="skeleton h-10 rounded-lg" />
                <div className="skeleton h-10 rounded-lg" />
              </div>
            ) : (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {events.map((e, i) => (
                  <li key={i} className="relative">
                    <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-4 ring-surface", e.event.includes("fail") || e.event === "rejected" ? "bg-danger" : e.event.includes("succeed") || e.event === "approved" ? "bg-success" : "bg-primary")} />
                    <p className="text-[13px] text-ink">
                      {EVENT_LABEL[e.event] ?? e.event}
                      <span className="text-muted"> · {e.actor_name ?? sentenceCase(e.actor_kind)}</span>
                    </p>
                    {e.note && <p className="text-[12.5px] text-muted">{e.note}</p>}
                    <p className="text-[11.5px] text-faint">{formatDateTime(e.created_at, timeZone)}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
