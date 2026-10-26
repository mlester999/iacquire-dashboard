"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, Clock, History, Info, Pencil, Plus, Route, Trash2, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Segmented, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, RecordPicker, useCrmAction } from "@/components/crm/ui";
import { describeFilter, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import { deleteAssignmentRuleAction, moveAssignmentRuleAction, setAssignmentRuleActiveAction } from "@/app/actions/crm-assignment";
import { searchContactsAction } from "@/app/actions/crm";
import { RuleEditor } from "@/components/crm/assignment/rule-editor";
import { ENTITY_LABEL, OUTCOME_INFO, STRATEGY_INFO } from "@/components/crm/assignment/labels";
import type { CrmScope } from "@/server/crm/page";
import type { AssignmentDecisionView, AssignmentEntity, AssignmentRuleView } from "@/server/crm/assignment";

export interface AssignmentWorkspaceProps {
  scope: CrmScope;
  rules: AssignmentRuleView[];
  recent: AssignmentDecisionView[];
  recordHistory: { entity: AssignmentEntity; id: string; label: string | null; decisions: AssignmentDecisionView[] } | null;
  initialEntity: AssignmentEntity;
  canManage: boolean;
  canSeeDeals: boolean;
  members: Array<{ id: string; name: string }>;
  options: FilterOptions;
}

const recordHref = (scope: CrmScope, entity: AssignmentEntity, id: string) => `${scope.base}/${entity === "contact" ? "contacts" : "opportunities"}/${id}`;
const historyHref = (scope: CrmScope, entity: AssignmentEntity, id: string) => `${scope.base}/settings/assignment?record=${entity}:${id}`;

/** Settings → Lead Assignment: ordered rules per kind of record, the editor, and every automatic decision with its reason. */
export function AssignmentWorkspace({ scope, rules, recent, recordHistory, initialEntity, canManage, canSeeDeals, members, options }: AssignmentWorkspaceProps) {
  const [entity, setEntity] = React.useState<AssignmentEntity>(initialEntity);
  const [editing, setEditing] = React.useState<AssignmentRuleView | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<AssignmentRuleView | null>(null);
  const { run, busy } = useCrmAction();
  const fields = useFilterFields("contact", options);
  const list = rules.filter((r) => r.entity === entity);
  const noun = ENTITY_LABEL[entity];

  return (
    <div className="space-y-8">
      <PageTitle
        title="Lead assignment"
        description="Give every new contact and deal an owner automatically. Rules run in order and the first active rule that matches decides. An owner someone already chose is kept unless a rule says otherwise."
        actions={canManage ? <Button onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />New rule</Button> : undefined}
      />
      {!canManage && <ReadOnlyNotice>{scope.agency ? "You can see these rules in this support session. Changing them needs a write session." : undefined}</ReadOnlyNotice>}

      {recordHistory ? (
        <RecordHistory scope={scope} history={recordHistory} />
      ) : (
        <>
          <section aria-labelledby="rules-heading" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="rules-heading" className="text-[15px] font-semibold text-ink">Rules for new {noun.many}</h3>
              {canSeeDeals && (
                <Segmented
                  id="assignment-entity"
                  ariaLabel="Which records"
                  value={entity}
                  onChange={setEntity}
                  options={[
                    { value: "contact", label: `Contacts (${rules.filter((r) => r.entity === "contact").length})` },
                    { value: "opportunity", label: `Deals (${rules.filter((r) => r.entity === "opportunity").length})` },
                  ]}
                />
              )}
            </div>

            {!list.length ? (
              <Card>
                <EmptyState
                  icon={<Route className="size-5" />}
                  title={`No rules for ${noun.many} yet`}
                  description={`New ${noun.many} stay with whoever created them, or unassigned. Add a rule to share them out by round robin, weight or priority.`}
                  action={canManage ? <Button onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />New rule</Button> : undefined}
                />
              </Card>
            ) : (
              <ol className="space-y-3">
                {list.map((r, i) => (
                  <li key={r.id}>
                    <Card className={cn("p-4", !r.active && "opacity-80")}>
                      <div className="flex flex-wrap items-start gap-3">
                        <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold text-ink-2">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-[14.5px] font-semibold text-ink">{r.name}</h4>
                            <Badge tone={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Off"}</Badge>
                            <Badge tone="primary">{STRATEGY_INFO[r.strategy].label}</Badge>
                            {r.respectWorkingHours && <Badge tone="neutral"><Clock className="size-3" aria-hidden />Working hours</Badge>}
                            {r.reassignOwned && <Badge tone="warning">Reassigns owned</Badge>}
                          </div>
                          <p className="mt-1 text-[13px] text-muted">
                            {r.conditionsValid ? <>Matches: {describeFilter(r.conditions, fields, options)}{r.entity === "opportunity" && r.conditions.conditions.length ? " (the deal's contact)" : ""}</> : <span className="text-danger-ink">Its conditions are no longer valid, so it never matches. Edit it to fix them.</span>}
                          </p>
                          {r.strategy !== "keep_existing_owner" && (
                            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Members">
                              {r.members.map((m) => (
                                <li key={m.userId} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px]", m.paused || !m.canOwn ? "border-dashed border-line-strong text-muted" : "border-line bg-surface text-ink-2")}>
                                  <span className="font-medium">{m.name}</span>
                                  {r.strategy === "weighted" && <span className="text-faint">×{m.weight}</span>}
                                  {r.strategy === "priority" && <span className="text-faint">p{m.priority}</span>}
                                  {m.paused && <span>· paused</span>}
                                  {!m.canOwn && <span className="text-danger-ink">· no access</span>}
                                  {r.respectWorkingHours && !m.paused && m.canOwn && <span className={m.workingNow && m.accepting ? "text-success-ink" : "text-faint"}>· {!m.hasWorkingHours ? "no hours set" : !m.accepting ? "not accepting" : m.workingNow ? "working now" : "off now"}</span>}
                                  <span className="text-faint">· {m.assigned30d} in 30 days</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="mt-2 text-[12px] text-faint">
                            Nobody available: {r.fallback === "fallback_user" ? `give it to ${r.fallbackUser?.name ?? "the fallback person"}` : "leave it unassigned"}
                            {" · "}Last 30 days: {r.decisions30d.assigned} assigned, {r.decisions30d.fallback} fallback, {r.decisions30d.kept_owner} kept, {r.decisions30d.unassigned} unassigned
                          </p>
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 flex-wrap items-center gap-1">
                            <Switch checked={r.active} disabled={busy(`active-${r.id}`)} aria-label={`${r.name} is active`}
                              onCheckedChange={(next) => run(`active-${r.id}`, () => setAssignmentRuleActiveAction(scope.orgId, r.id, next), next ? "Rule switched on." : "Rule switched off.")} />
                            <Button variant="ghost" size="icon-sm" aria-label={`Move ${r.name} up`} disabled={i === 0 || busy(`move-${r.id}`)} onClick={() => run(`move-${r.id}`, () => moveAssignmentRuleAction(scope.orgId, r.id, "up"))}><ArrowUp className="size-4" /></Button>
                            <Button variant="ghost" size="icon-sm" aria-label={`Move ${r.name} down`} disabled={i === list.length - 1 || busy(`move-${r.id}`)} onClick={() => run(`move-${r.id}`, () => moveAssignmentRuleAction(scope.orgId, r.id, "down"))}><ArrowDown className="size-4" /></Button>
                            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil className="size-4" /></Button>
                            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><Trash2 className="size-4" /></Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  </li>
                ))}
              </ol>
            )}
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Rules run a moment after a {noun.one} is created, and once per record. Contacts from a spreadsheet import keep the owner chosen in the import. Workflows can also send a record through a rule.
            </p>
          </section>

          <section aria-labelledby="decisions-heading" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 id="decisions-heading" className="text-[15px] font-semibold text-ink">Recent decisions</h3>
                <p className="text-[13px] text-muted">The latest 50 automatic assignments and why each went the way it did.</p>
              </div>
              <ContactLookup scope={scope} />
            </div>
            <DecisionList scope={scope} decisions={recent} showRecord />
          </section>
        </>
      )}

      {editing && (
        <RuleEditor
          scope={scope}
          entity={editing === "new" ? entity : editing.entity}
          rule={editing === "new" ? null : editing}
          team={members}
          options={options}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting?.hasHistory ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`“${deleting.name}” is kept for its history`}
          description={deleting.active
            ? "This rule has already assigned records, and the assignment history names it, so it can't be deleted. Switch it off to stop it assigning new records."
            : "This rule has already assigned records, and the assignment history names it, so it can't be deleted. It is switched off and assigns nothing new."}
          confirmLabel={deleting.active ? "Switch it off" : "Close"}
          loading={busy("delete")}
          onConfirm={async () => {
            if (!deleting.active) return setDeleting(null);
            if (await run("delete", () => setAssignmentRuleActiveAction(scope.orgId, deleting.id, false), "Rule switched off.")) setDeleting(null);
          }}
        />
      ) : (
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete “${deleting?.name}”?`}
          description="New records stop going through this rule. It hasn't assigned anything yet, so nothing else changes."
          confirmLabel="Delete rule"
          danger
          loading={busy("delete")}
          onConfirm={async () => {
            if (deleting && (await run("delete", () => deleteAssignmentRuleAction(scope.orgId, deleting.id), "Rule deleted."))) setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

/** Find a contact and open its assignment history. */
function ContactLookup({ scope }: { scope: CrmScope }) {
  const router = useRouter();
  const search = React.useCallback(async (q: string) => {
    const res = await searchContactsAction(scope.orgId, q);
    return res.ok ? res.data : [];
  }, [scope.orgId]);
  return (
    <div className="w-full sm:w-72">
      <RecordPicker
        id="assignment-contact-lookup"
        label="Find a contact's assignment history"
        placeholder="Find a contact's history…"
        search={search}
        render={(c) => (
          <span className="block min-w-0">
            <span className="block truncate font-medium text-ink">{c.name}</span>
            {(c.email || c.phone) && <span className="block truncate text-[12px] text-muted">{c.email ?? c.phone}</span>}
          </span>
        )}
        onPick={(c) => router.push(historyHref(scope, "contact", c.id))}
      />
    </div>
  );
}

function RecordHistory({ scope, history }: { scope: CrmScope; history: NonNullable<AssignmentWorkspaceProps["recordHistory"]> }) {
  const noun = ENTITY_LABEL[history.entity];
  return (
    <section aria-labelledby="record-history" className="space-y-3">
      <Link href={`${scope.base}/settings/assignment${history.entity === "opportunity" ? "?entity=opportunity" : ""}`} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-0">
        <ArrowLeft className="size-4" aria-hidden />All rules and decisions
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="record-history" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><History className="size-4" aria-hidden />Assignment history</h3>
          <p className="text-[14px] text-muted">
            {history.label ? <>For the {noun.one} <Link className="font-medium text-ink hover:text-primary" href={recordHref(scope, history.entity, history.id)}>{history.label}</Link></> : `For a ${noun.one} you can't open`}
          </p>
        </div>
      </div>
      <DecisionList scope={scope} decisions={history.decisions} showRecord={false} emptyText={`No rule has decided anything for this ${noun.one}. Owners set by hand are on its timeline.`} />
    </section>
  );
}

function DecisionList({ scope, decisions, showRecord, emptyText }: { scope: CrmScope; decisions: AssignmentDecisionView[]; showRecord: boolean; emptyText?: string }) {
  if (!decisions.length) {
    return (
      <Card>
        <EmptyState compact icon={<UserCheck className="size-5" />} title="No decisions yet" description={emptyText ?? "When a rule assigns a new contact or deal, it shows up here with the reason."} />
      </Card>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
      {decisions.map((d) => (
        <li key={d.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={OUTCOME_INFO[d.outcome].tone}>{OUTCOME_INFO[d.outcome].label}</Badge>
              {d.userName && <span className="text-[14px] font-medium text-ink">{d.userName}</span>}
              {showRecord && (
                <span className="text-[14px] text-muted">
                  {d.recordLive && d.recordLabel ? <Link href={recordHref(scope, d.entity, d.entityId)} className="font-medium text-ink-2 hover:text-primary">{d.recordLabel}</Link> : <span>{d.recordLabel ?? `A ${ENTITY_LABEL[d.entity].one}`}{!d.recordLive ? " (archived or removed)" : ""}</span>}
                  {" · "}
                  <Link href={historyHref(scope, d.entity, d.entityId)} className="underline-offset-2 hover:underline">history</Link>
                </span>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{d.reason}</p>
            <p className="mt-0.5 text-[12px] text-faint">{d.ruleName ? `Rule: ${d.ruleName}` : "Rule deleted"}</p>
          </div>
          <RelativeTime iso={d.at} timezone={scope.timezone} className="text-[12px] text-faint sm:text-right" />
        </li>
      ))}
    </ul>
  );
}
