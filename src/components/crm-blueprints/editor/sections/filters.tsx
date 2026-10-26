"use client";

import * as React from "react";
import { Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { FilterBuilder, describeFilter, useFilterFields } from "@/components/crm/filter-builder";
import { conditionsText, namesFrom } from "@/components/crm/workflows/summaries";
import { STRATEGY_INFO } from "@/components/crm/assignment/labels";
import { CONTACT_COLUMNS, CONTACT_COLUMN_LABELS, CONTACT_SORTS, CONTACT_SORT_LABELS, type FilterGroup } from "@/lib/crm/filters";
import { ASSIGNMENT_STRATEGIES, refId, toRef, type AssignmentRuleAsset, type AssignmentStrategy, type BlueprintContent, type SmartListAsset } from "@/lib/crm/blueprints/types";
import { updateAsset, withSection } from "@/components/crm-blueprints/editor/model";
import { assignmentRuleArrival } from "@/components/crm-blueprints/asset-index";
import { filterEditProblem, filterFromBuilder, filterOptionsFor, filterToBuilder, namesSourceFor, type FilterEntity } from "@/components/crm-blueprints/editor/bridge";
import {
  AssetWorkspace, DetailCard, DetailHeader, ENTITY_LABELS, FieldGrid, FolderSelect, IssueNotes, NumberInput, SectionNote, SlotSelect, issuesOf, orNull, refName, useAdder, useEditor,
} from "@/components/crm-blueprints/editor/parts";
import { ToggleRow } from "@/components/crm-blueprints/editor/inputs";

// ---------------------------------------------------------------------------
// Conditions: the builder for the safe subset, a readable summary for everything else
// ---------------------------------------------------------------------------

/**
 * A filter of this Blueprint. Contact and company filters the builder can show completely are edited with the CRM's own filter builder,
 * whose choices are this Blueprint's tags, roles, pipelines and fields; anything else is shown as a readable sentence, read-only, so
 * editing can never quietly drop part of a condition.
 */
function ConditionsEditor({ id, filter, entity, onChange, title, emptyText }: { id: string; filter: FilterGroup; entity: "contact" | "company" | "opportunity"; onChange: (g: FilterGroup) => void; title: string; emptyText: string }) {
  const { content, readOnly } = useEditor();
  const problem = filterEditProblem(filter, entity, content);
  const builderEntity: FilterEntity = entity === "company" ? "company" : "contact";
  const options = React.useMemo(() => filterOptionsFor(content, builderEntity), [content, builderEntity]);
  const fields = useFilterFields(builderEntity, options);
  const builderValue = React.useMemo(() => filterToBuilder(filter, builderEntity, content), [filter, builderEntity, content]);
  const summary = React.useMemo(() => {
    if (entity === "opportunity") return filter.conditions.length ? conditionsText(filter, "opportunity", namesFrom(namesSourceFor(content))) : "";
    return filter.conditions.length ? describeFilter(builderValue, fields, options) : "";
  }, [entity, filter, builderValue, fields, options, content]);
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2">
      <h4 id={`${id}-title`} className="text-[14px] font-semibold text-ink">{title}</h4>
      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px] leading-relaxed text-ink-2"><span className="font-medium text-ink">In words: </span>{summary || emptyText}</p>
      {problem ? (
        <p className="flex gap-2 text-[13px] leading-relaxed text-muted"><Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />{problem} It is kept exactly as it is; it can be changed in a client&apos;s CRM after applying.</p>
      ) : readOnly ? null : (
        <FilterBuilder entity={builderEntity} value={builderValue} options={options} onChange={(g) => onChange(filterFromBuilder(g, builderEntity, content))} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Smart Lists
// ---------------------------------------------------------------------------

const columnLabel = (content: BlueprintContent, col: string) =>
  col.startsWith("@") ? refName(content, col) : (CONTACT_COLUMN_LABELS as Record<string, string>)[col] ?? col.replace(/_/g, " ");

export function SmartListsSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("smartLists", ["contact", "company", "opportunity"]);
  const items = content.assets.smartLists.map((s) => ({ id: s.id, name: s.name, detail: `${ENTITY_LABELS[s.entity]}${s.isDefault ? " · default view" : ""}` }));
  return (
    <>
      <AssetWorkspace
        section="smartLists"
        title="Smart Lists"
        intro="Saved views a client's team starts with. Blueprint lists are shared with the whole team in each workspace."
        items={items}
        addLabel="Add Smart List"
        onAdd={add.open}
        emptyText="Add the views this kind of business checks every day, such as new leads or customers to follow up."
      >
        {(id) => {
          const s = content.assets.smartLists.find((x) => x.id === id)!;
          const set = (patch: Partial<SmartListAsset>) => edit((c) => updateAsset(c, "smartLists", id, (x) => ({ ...x, ...patch })));
          const setDefault = (on: boolean) => edit((c) => withSection(c, "smartLists", c.assets.smartLists.map((x) => ({ ...x, isDefault: x.id === id ? on : on && x.entity === s.entity ? false : x.isDefault }))));
          return (
            <DetailCard>
              <DetailHeader id={s.id} title={s.name} kind={`${ENTITY_LABELS[s.entity]} Smart List`} onRemove={() => remove(s.id, s.name)} />
              <IssueNotes issues={issuesOf(issues, s.id)} />
              <FieldGrid>
                <Field label="Name" htmlFor="sl-name"><Input id="sl-name" value={s.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
                <FolderSelect id="sl-folder" kind="smart_list" value={s.folder} onChange={(folder) => set({ folder })} />
              </FieldGrid>
              <Field label="Description" htmlFor="sl-desc" optional><Textarea id="sl-desc" rows={2} maxLength={300} value={s.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
              <ToggleRow id="sl-default" label={`Default ${ENTITY_LABELS[s.entity].toLowerCase()} view`} hint="Used only when the client has no default view of its own." checked={s.isDefault} disabled={readOnly} onChange={setDefault} />
              <ConditionsEditor id={`sl-filter-${s.id}`} filter={s.filter} entity={s.entity} onChange={(filter) => set({ filter })} title="Who is in it" emptyText="Everyone." />
              <ColumnsEditor list={s} onChange={(columns) => set({ columns })} />
              {s.entity === "contact" && (
                <FieldGrid>
                  <Field label="Sorted by" htmlFor="sl-sort">
                    <Select id="sl-sort" value={s.sort.by ?? ""} disabled={readOnly} onChange={(e) => set({ sort: e.target.value ? { by: e.target.value, dir: s.sort.dir ?? "desc" } : {} })}>
                      <option value="">The CRM&apos;s usual order</option>
                      {CONTACT_SORTS.map((k) => <option key={k} value={k}>{CONTACT_SORT_LABELS[k]}</option>)}
                      {s.sort.by && !(CONTACT_SORTS as readonly string[]).includes(s.sort.by) && <option value={s.sort.by}>{s.sort.by}</option>}
                    </Select>
                  </Field>
                  {s.sort.by && (
                    <Field label="Order" htmlFor="sl-dir">
                      <Select id="sl-dir" value={s.sort.dir ?? "desc"} disabled={readOnly} onChange={(e) => set({ sort: { ...s.sort, dir: e.target.value as "asc" | "desc" } })}>
                        <option value="desc">Newest or highest first</option>
                        <option value="asc">Oldest or lowest first</option>
                      </Select>
                    </Field>
                  )}
                </FieldGrid>
              )}
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function ColumnsEditor({ list, onChange }: { list: SmartListAsset; onChange: (c: string[]) => void }) {
  const { content, readOnly } = useEditor();
  const builtIn = list.entity === "contact" ? (CONTACT_COLUMNS as readonly string[]) : [];
  const fieldCols = content.assets.customFields.filter((f) => f.entity === list.entity).map((f) => toRef(f.id));
  const choices = [...builtIn, ...fieldCols].filter((c) => !list.columns.includes(c));
  return (
    <Field label="Columns" htmlFor={`sl-cols-${list.id}`} hint={list.entity === "contact" ? "Shown in this order." : "Custom field columns of this record type; the CRM adds its own standard columns."}>
      <div className="space-y-2">
        {list.columns.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Columns">
            {list.columns.map((c) => (
              <li key={c}>
                <Badge tone="outline" className="h-8 gap-1 pr-1">
                  {columnLabel(content, c)}
                  {!readOnly && <button type="button" onClick={() => onChange(list.columns.filter((x) => x !== c))} aria-label={`Remove column ${columnLabel(content, c)}`} className="inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"><Trash2 className="size-3" /></button>}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <Select id={`sl-cols-${list.id}`} value="" disabled={!choices.length || list.columns.length >= 30} onChange={(e) => e.target.value && onChange([...list.columns, e.target.value])}>
            <option value="">{choices.length ? "Add a column…" : "No more columns to add"}</option>
            {choices.map((c) => <option key={c} value={c}>{columnLabel(content, c)}</option>)}
          </Select>
        )}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Lead assignment rules
// ---------------------------------------------------------------------------

export function AssignmentRulesSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("assignmentRules", ["contact", "opportunity"]);
  const items = content.assets.assignmentRules.map((r) => ({ id: r.id, name: r.name, detail: `${r.entity === "contact" ? "Contacts" : "Deals"} · ${STRATEGY_INFO[r.strategy].label}` }));
  return (
    <>
      <AssetWorkspace
        section="assignmentRules"
        title="Lead assignment rules"
        intro="Who new contacts or deals go to. Members are roles: each client maps them to its own people. A rule from a Blueprint arrives switched off unless all its people are mapped when it's applied."
        items={items}
        addLabel="Add rule"
        onAdd={add.open}
        emptyText="Add a rule to share new leads between a client's team."
      >
        {(id) => {
          const r = content.assets.assignmentRules.find((x) => x.id === id)!;
          const set = (patch: Partial<AssignmentRuleAsset>) => edit((c) => updateAsset(c, "assignmentRules", id, (x) => ({ ...x, ...patch })));
          const usesMembers = r.strategy !== "keep_existing_owner";
          return (
            <DetailCard>
              <DetailHeader id={r.id} title={r.name} kind={`Assignment rule for ${r.entity === "contact" ? "contacts" : "deals"}`} onRemove={() => remove(r.id, r.name)} />
              <SectionNote>{assignmentRuleArrival(r).text}</SectionNote>
              <IssueNotes issues={issuesOf(issues, r.id)} />
              <FieldGrid>
                <Field label="Name" htmlFor="ar-name"><Input id="ar-name" value={r.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="How it chooses" htmlFor="ar-strategy" hint={STRATEGY_INFO[r.strategy].description}>
                  <Select id="ar-strategy" value={r.strategy} disabled={readOnly} onChange={(e) => set({ strategy: e.target.value as AssignmentStrategy })}>
                    {ASSIGNMENT_STRATEGIES.map((s) => <option key={s} value={s}>{STRATEGY_INFO[s].label}</option>)}
                  </Select>
                </Field>
              </FieldGrid>
              <ConditionsEditor
                id={`ar-cond-${r.id}`}
                filter={r.conditions}
                entity="contact"
                onChange={(conditions) => set({ conditions })}
                title={r.entity === "contact" ? "Which contacts" : "Which deals (checked on the deal's contact)"}
                emptyText={r.entity === "contact" ? "Every new contact." : "Every new deal."}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <ToggleRow id="ar-hours" label="Only people who are working" hint="Skips people outside their working hours." checked={r.respectWorkingHours} disabled={readOnly} onChange={(respectWorkingHours) => set({ respectWorkingHours })} />
                <ToggleRow id="ar-reassign" label="Reassign records that have an owner" hint="Off: only unowned records are assigned." checked={r.reassignOwned} disabled={readOnly} onChange={(reassignOwned) => set({ reassignOwned })} />
              </div>
              {usesMembers && <MembersEditor rule={r} onChange={(members) => set({ members })} />}
              <FieldGrid>
                <Field label="When nobody is available" htmlFor="ar-fallback">
                  <Select id="ar-fallback" value={r.fallback} disabled={readOnly} onChange={(e) => {
                    const fallback = e.target.value as AssignmentRuleAsset["fallback"];
                    set({ fallback, fallbackMember: fallback === "fallback_user" ? r.fallbackMember : null });
                  }}>
                    <option value="unassigned">Leave it unassigned</option>
                    <option value="fallback_user">Give it to one person</option>
                  </Select>
                </Field>
                {r.fallback === "fallback_user" && (
                  <SlotSelect id="ar-fallback-member" kind="member" label="Fallback role" value={r.fallbackMember} allowNone={false} onChange={(fallbackMember) => set({ fallbackMember })} />
                )}
              </FieldGrid>
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function MembersEditor({ rule, onChange }: { rule: AssignmentRuleAsset; onChange: (m: AssignmentRuleAsset["members"]) => void }) {
  const { content, readOnly } = useEditor();
  const slots = content.slots.filter((s) => s.id.startsWith("member."));
  const rest = slots.filter((s) => !rule.members.some((m) => refId(m.member) === s.id));
  const setAt = (i: number, patch: Partial<AssignmentRuleAsset["members"][number]>) => onChange(rule.members.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-[14px] font-medium text-ink-2">Member roles</legend>
      {!rule.members.length && <p className="text-[13px] text-muted">No roles yet: each client adds its people to this rule. Add roles here when the rule should name who takes part (for example Closer).</p>}
      <ul className="space-y-2">
        {rule.members.map((m, i) => (
          <li key={m.member} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2">
            <span className="min-w-0 flex-1 text-[14px] font-medium text-ink">{refName(content, m.member)}</span>
            {rule.strategy === "weighted" && <label className="flex items-center gap-2 text-[13px] text-muted">Weight <NumberInput id={`ar-w-${i}`} ariaLabel={`Weight for ${refName(content, m.member)}`} value={m.weight} min={1} max={100} disabled={readOnly} onChange={(v) => v !== null && setAt(i, { weight: v })} /></label>}
            {rule.strategy === "priority" && <label className="flex items-center gap-2 text-[13px] text-muted">Priority <NumberInput id={`ar-p-${i}`} ariaLabel={`Priority for ${refName(content, m.member)}`} value={m.priority} min={0} max={100} disabled={readOnly} onChange={(v) => v !== null && setAt(i, { priority: v })} /></label>}
            {!readOnly && <Button variant="ghost" size="icon-sm" onClick={() => onChange(rule.members.filter((_, j) => j !== i))} aria-label={`Remove ${refName(content, m.member)} from the rule`}><Trash2 className="size-4" /></Button>}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <SlotSelect id="ar-add-member" kind="member" label="Add a role" value={null} noneLabel={rest.length ? "Choose a role…" : "No more roles to add"} onChange={(v) => v && !rule.members.some((m) => m.member === v) && onChange([...rule.members, { member: v, weight: 1, priority: 50 }])} />
          </div>
        </div>
      )}
    </fieldset>
  );
}
