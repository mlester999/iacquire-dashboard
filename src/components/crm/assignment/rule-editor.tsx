"use client";

import * as React from "react";
import { AlertTriangle, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { completeFilter, FilterBuilder, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import { useCrmAction } from "@/components/crm/ui";
import { createAssignmentRuleAction, updateAssignmentRuleAction } from "@/app/actions/crm-assignment";
import { EMPTY_FILTER, type FilterGroup } from "@/lib/crm/filters";
import type { CrmScope } from "@/server/crm/page";
import type { AssignmentEntity, AssignmentRuleView, AssignmentStrategy } from "@/server/crm/assignment";
import { ENTITY_LABEL, STRATEGY_INFO } from "@/components/crm/assignment/labels";

interface MemberDraft {
  userId: string;
  name: string;
  weight: string;
  priority: string;
  paused: boolean;
  /** From the saved rule, for the working-hours warning. */
  hasWorkingHours?: boolean;
  canOwn?: boolean;
}

const STRATEGIES: AssignmentStrategy[] = ["round_robin", "weighted", "priority", "keep_existing_owner"];

/** Problems that stop the rule from saving, worked out as the person edits (the server checks the same and more). */
function draftIssues(d: { name: string; strategy: AssignmentStrategy; members: MemberDraft[]; fallback: "unassigned" | "fallback_user"; fallbackUserId: string }): string[] {
  const issues: string[] = [];
  if (!d.name.trim()) issues.push("Give the rule a name.");
  if (d.strategy !== "keep_existing_owner" && !d.members.length) issues.push("Add at least one team member.");
  for (const m of d.members) {
    const w = Number(m.weight);
    const p = Number(m.priority);
    if (d.strategy === "weighted" && (!Number.isInteger(w) || w < 1 || w > 100)) issues.push(`${m.name}: a weight is a whole number from 1 to 100.`);
    if (d.strategy === "priority" && (!Number.isInteger(p) || p < 0 || p > 100)) issues.push(`${m.name}: a priority is a whole number from 0 to 100.`);
  }
  if (d.fallback === "fallback_user" && !d.fallbackUserId) issues.push("Choose who gets the record when nobody is available.");
  return issues;
}

export function RuleEditor({
  scope,
  entity,
  rule,
  team,
  options,
  onClose,
}: {
  scope: CrmScope;
  entity: AssignmentEntity;
  rule: AssignmentRuleView | null;
  team: Array<{ id: string; name: string }>;
  options: FilterOptions;
  onClose: () => void;
}) {
  const { run, busy } = useCrmAction();
  const fields = useFilterFields("contact", options);
  const [name, setName] = React.useState(rule?.name ?? "");
  const [filter, setFilter] = React.useState<FilterGroup>(rule?.conditions ?? EMPTY_FILTER);
  const [strategy, setStrategy] = React.useState<AssignmentStrategy>(rule?.strategy ?? "round_robin");
  const [members, setMembers] = React.useState<MemberDraft[]>(
    rule?.members.map((m) => ({ userId: m.userId, name: m.name, weight: String(m.weight), priority: String(m.priority), paused: m.paused, hasWorkingHours: m.hasWorkingHours, canOwn: m.canOwn })) ?? [],
  );
  const [respectHours, setRespectHours] = React.useState(rule?.respectWorkingHours ?? false);
  const [fallback, setFallback] = React.useState<"unassigned" | "fallback_user">(rule?.fallback ?? "unassigned");
  const [fallbackUserId, setFallbackUserId] = React.useState(rule?.fallbackUser?.id ?? "");
  const [reassign, setReassign] = React.useState(rule?.reassignOwned ?? false);
  const [active, setActive] = React.useState(rule?.active ?? true);
  const [adding, setAdding] = React.useState("");
  const [showIssues, setShowIssues] = React.useState(false);
  const ids = React.useId();

  const usesMembers = strategy !== "keep_existing_owner";
  const issues = draftIssues({ name, strategy, members, fallback, fallbackUserId });
  const available = team.filter((t) => !members.some((m) => m.userId === t.id));
  const noun = ENTITY_LABEL[entity];
  const missingHours = respectHours ? members.filter((m) => m.hasWorkingHours === false && !m.paused) : [];

  const addMember = (id: string) => {
    const person = team.find((t) => t.id === id);
    if (!person) return;
    setMembers((list) => [...list, { userId: person.id, name: person.name, weight: "1", priority: "50", paused: false }]);
    setAdding("");
  };
  const patch = (userId: string, p: Partial<MemberDraft>) => setMembers((list) => list.map((m) => (m.userId === userId ? { ...m, ...p } : m)));

  async function save() {
    if (issues.length) {
      setShowIssues(true);
      return;
    }
    const input = {
      name: name.trim(),
      entity,
      conditions: completeFilter(filter, fields),
      strategy,
      respectWorkingHours: usesMembers && respectHours,
      fallback,
      fallbackUserId: fallback === "fallback_user" ? fallbackUserId : null,
      reassignOwned: usesMembers && reassign,
      active,
      members: members.map((m) => ({ userId: m.userId, weight: Number(m.weight) || 1, priority: Number.isInteger(Number(m.priority)) ? Number(m.priority) : 50, paused: m.paused })),
    };
    const ok = rule
      ? await run("save", () => updateAssignmentRuleAction(scope.orgId, rule.id, input), "Rule saved.")
      : await run("save", () => createAssignmentRuleAction(scope.orgId, input), "Rule created.");
    if (ok) onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={rule ? `Edit “${rule.name}”` : `New rule for ${noun.many}`}
      description={`Rules run in order when a new ${noun.one} is created. The first active rule whose conditions match decides who owns it.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy("save")} onClick={save}>{rule ? "Save rule" : "Create rule"}</Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Rule name" htmlFor={`${ids}-name`}>
            <Input id={`${ids}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={entity === "contact" ? "Website leads" : "New deals"} />
          </Field>
          <label className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line px-3 text-[13px] sm:min-h-10">
            <span className="font-medium">Active</span>
            <Switch checked={active} onCheckedChange={setActive} aria-label="Rule is active" />
          </label>
        </div>

        <section aria-labelledby={`${ids}-cond`} className="space-y-2">
          <h3 id={`${ids}-cond`} className="text-[14px] font-semibold text-ink">Which {noun.many}</h3>
          <p className="text-[12.5px] text-muted">
            {entity === "opportunity" ? "Conditions are checked against the deal's contact. A deal without a contact only matches a rule with no conditions." : "Leave empty to match every new contact."}
          </p>
          <div className="rounded-2xl border border-line bg-surface p-3">
            <FilterBuilder value={filter} onChange={setFilter} options={options} />
          </div>
        </section>

        <section aria-labelledby={`${ids}-strategy`} className="space-y-2">
          <h3 id={`${ids}-strategy`} className="text-[14px] font-semibold text-ink">How a person is chosen</h3>
          <div role="radiogroup" aria-labelledby={`${ids}-strategy`} className="grid gap-2 sm:grid-cols-2">
            {STRATEGIES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={strategy === s}
                onClick={() => setStrategy(s)}
                className={cn("rounded-2xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", strategy === s ? "border-primary bg-primary-soft/50" : "border-line bg-surface hover:border-line-strong")}
              >
                <span className="block text-[13.5px] font-semibold text-ink">{STRATEGY_INFO[s].label}</span>
                <span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{STRATEGY_INFO[s].description}</span>
              </button>
            ))}
          </div>
        </section>

        {usesMembers && (
          <section aria-labelledby={`${ids}-members`} className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h3 id={`${ids}-members`} className="text-[14px] font-semibold text-ink">Team members</h3>
              <p className="text-[12.5px] text-muted">{members.length} {members.length === 1 ? "person" : "people"} · paused people are skipped</p>
            </div>
            {members.length ? (
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {members.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{m.name}</span>
                      {m.canOwn === false && <span className="block text-[12px] text-danger-ink">Can no longer own records. Remove them, or ask an owner to restore their access.</span>}
                    </span>
                    {strategy === "weighted" && (
                      <label className="flex items-center gap-2 text-[12.5px] text-muted">
                        Weight
                        <Input aria-label={`Weight for ${m.name}`} inputMode="numeric" className="w-20" value={m.weight} onChange={(e) => patch(m.userId, { weight: e.target.value.replace(/\D/g, "").slice(0, 3) })} />
                      </label>
                    )}
                    {strategy === "priority" && (
                      <label className="flex items-center gap-2 text-[12.5px] text-muted">
                        Priority
                        <Input aria-label={`Priority for ${m.name}`} inputMode="numeric" className="w-20" value={m.priority} onChange={(e) => patch(m.userId, { priority: e.target.value.replace(/\D/g, "").slice(0, 3) })} />
                      </label>
                    )}
                    <label className="flex items-center gap-2 text-[12.5px] text-muted">
                      Paused
                      <Switch checked={m.paused} onCheckedChange={(paused) => patch(m.userId, { paused })} aria-label={`Pause ${m.name}`} />
                    </label>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => setMembers((list) => list.filter((x) => x.userId !== m.userId))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 rounded-2xl border border-dashed border-line-strong px-3 py-4 text-[13px] text-muted"><Users className="size-4" aria-hidden />No one yet. Add the people this rule can choose from.</p>
            )}
            {available.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="Add a team member" value={adding} onChange={(e) => setAdding(e.target.value)} className="min-w-[14rem]">
                  <option value="">Choose a teammate…</option>
                  {available.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
                <Button variant="secondary" size="sm" disabled={!adding} onClick={() => addMember(adding)}><UserPlus className="size-3.5" aria-hidden />Add</Button>
                <Button variant="ghost" size="sm" onClick={() => setMembers((list) => [...list, ...available.map((t) => ({ userId: t.id, name: t.name, weight: "1", priority: "50", paused: false }))])}><Plus className="size-3.5" aria-hidden />Add everyone</Button>
              </div>
            )}

            <label className="flex items-start justify-between gap-3 rounded-2xl border border-line p-3 text-[13px]">
              <span>
                <span className="block font-medium text-ink">Only people who are working now</span>
                <span className="block text-[12.5px] text-muted">Uses each person&apos;s working hours from Availability (in their own time zone, with days off) and skips anyone not accepting new work.</span>
              </span>
              <Switch checked={respectHours} onCheckedChange={setRespectHours} aria-label="Only people who are working now" />
            </label>
            {missingHours.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-[12.5px] text-warning-ink">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {missingHours.map((m) => m.name).join(", ")} {missingHours.length === 1 ? "has" : "have"} no working hours set, so they are never chosen while this is on. Set hours in Availability.
              </p>
            )}

            <label className="flex items-start justify-between gap-3 rounded-2xl border border-line p-3 text-[13px]">
              <span>
                <span className="block font-medium text-ink">Also reassign {noun.many} that already have an owner</span>
                <span className="block text-[12.5px] text-muted">Off: an owner someone already chose is always kept. On: the rule picks again, for example when a workflow sends an owned record through it.</span>
              </span>
              <Switch checked={reassign} onCheckedChange={setReassign} aria-label={`Reassign ${noun.many} that already have an owner`} />
            </label>
          </section>
        )}

        <section aria-labelledby={`${ids}-fallback`} className="space-y-2">
          <h3 id={`${ids}-fallback`} className="text-[14px] font-semibold text-ink">When nobody is available</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select aria-labelledby={`${ids}-fallback`} value={fallback} onChange={(e) => setFallback(e.target.value as "unassigned" | "fallback_user")}>
              <option value="unassigned">Leave it unassigned</option>
              <option value="fallback_user">Give it to a person</option>
            </Select>
            {fallback === "fallback_user" && (
              <Select aria-label="Fallback person" value={fallbackUserId} onChange={(e) => setFallbackUserId(e.target.value)}>
                <option value="">Choose a teammate…</option>
                {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
          </div>
        </section>

        {showIssues && issues.length > 0 && (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft p-3 text-[13px] text-danger-ink">
            <p className="font-medium">Before saving:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        )}
        {!rule && <p className="text-[12px] text-muted"><Badge tone="neutral">Tip</Badge> New rules go to the end of the list. Move them up to run earlier.</p>}
      </div>
    </Dialog>
  );
}
