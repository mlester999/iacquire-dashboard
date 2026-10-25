"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuTrigger, Segmented, Switch } from "@/components/ui/overlays";
import { Button } from "@/components/ui/button";
import { TagChip } from "@/components/crm/ui";
import { Section } from "@/components/crm/forms/parts";
import { namedChannels, type ConsentChannel } from "@/lib/crm/forms/consent";
import { collectsIdentity, FORM_LIMITS, NOTIFY_ROLES, type FormDraft, type FormKind, type NotifyRole } from "@/lib/crm/forms/spec";
import type { FormBuilderOptions } from "@/components/crm/forms/types";
import type { CrmScope } from "@/server/crm/page";

const ROLE_LABELS: Record<NotifyRole, string> = { owner: "Owners", admin: "Managers", sales_rep: "Sales reps", support: "Support", appointment_setter: "Appointment setters" };
const NAME_TOKENS = [
  { token: "{{contact.full_name}}", label: "Full name" },
  { token: "{{contact.first_name}}", label: "First name" },
  { token: "{{contact.last_name}}", label: "Last name" },
  { token: "{{form.name}}", label: "Form name" },
];

const CHANNEL_WORDS: Record<ConsentChannel, string> = { email: "email", sms: "text messages", whatsapp: "WhatsApp" };

/** The channels wording names, in words ("email and text messages"), or "" when it names none. */
function coverage(wording: string): string {
  const named = namedChannels(wording).map((c) => CHANNEL_WORDS[c]);
  return named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** What a submission does and what people agree to: consent wording, tags, a deal, an assignment rule, notifications, the thank-you. */
export function AfterEditor({
  draft, onChange, options, readOnly, kind, scope,
}: {
  draft: FormDraft;
  onChange: (d: FormDraft) => void;
  options: FormBuilderOptions;
  readOnly: boolean;
  kind: FormKind;
  scope: CrmScope;
}) {
  const a = draft.actions;
  const setActions = (patch: Partial<FormDraft["actions"]>) => onChange({ ...draft, actions: { ...a, ...patch } });
  const setConsent = (patch: Partial<FormDraft["consent"]>) => onChange({ ...draft, consent: { ...draft.consent, ...patch } });
  const setSettings = (patch: Partial<FormDraft["settings"]>) => onChange({ ...draft, settings: { ...draft.settings, ...patch } });
  const identity = collectsIdentity(draft.questions);
  const tagsById = new Map(options.tags.map((t) => [t.id, t]));
  const pipeline = a.opportunity ? options.pipelines.find((p) => p.id === a.opportunity!.pipelineId) : undefined;
  const numberQuestions = draft.questions.filter((q) => q.type === "number");
  const covers = coverage(draft.consent.text);
  const marketingCovers = coverage(draft.consent.marketing.text);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const insertToken = (token: string) => {
    if (!a.opportunity) return;
    const el = nameRef.current;
    const cur = a.opportunity.name;
    const at = el?.selectionStart ?? cur.length;
    const next = `${cur.slice(0, at)}${token}${cur.slice(el?.selectionEnd ?? at)}`.slice(0, 200);
    setActions({ opportunity: { ...a.opportunity, name: next } });
    requestAnimationFrame(() => el?.focus());
  };

  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <Section
        title="Consent"
        description="These exact words are shown next to the boxes and saved with every submission, so you can always show what someone agreed to."
      >
        <Field
          label="Consent to be contacted"
          htmlFor="fa-consent"
          optional={!identity}
          hint={identity
            ? `People must tick this to send the form. ${covers ? `It covers ${covers}, and only those.` : "It names no channel yet, so it records no consent: say how you'll reply, such as by email or text message."}`
            : "Only needed when the form asks for an email address or phone number."}
        >
          <Textarea id="fa-consent" rows={3} value={draft.consent.text} maxLength={FORM_LIMITS.consentText} onChange={(e) => setConsent({ text: e.target.value })} />
        </Field>
        <div className="space-y-3 rounded-xl border border-line p-3.5">
          <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
            <Switch checked={draft.consent.marketing.enabled} onCheckedChange={(v) => setConsent({ marketing: { ...draft.consent.marketing, enabled: v } })} aria-label="Offer a marketing opt-in" />
            <span>
              <span className="block font-medium text-ink">Offer a marketing opt-in</span>
              <span className="block text-[12px] text-muted">A separate, unticked box. Only people who tick it can receive campaigns, and only on the channels its wording names.</span>
            </span>
          </label>
          {draft.consent.marketing.enabled && (
            <Field
              label="Opt-in wording"
              htmlFor="fa-marketing"
              hint={marketingCovers ? `Ticking it allows marketing by ${marketingCovers}, and only those.` : "It names no channel yet, so ticking it records nothing: name it, such as “Email me news and offers”."}
            >
              <Textarea id="fa-marketing" rows={2} value={draft.consent.marketing.text} maxLength={FORM_LIMITS.consentText} onChange={(e) => setConsent({ marketing: { ...draft.consent.marketing, text: e.target.value } })} />
            </Field>
          )}
        </div>
      </Section>

      {kind === "form" || identity ? (
        <Section title="When someone sends it" description={identity ? "Processing matches an existing contact only by the exact email address or phone number given, or adds a new contact. It never adds a new address to a contact you already have." : "Add an email or phone question saved to the contact to create or update contacts, add tags or create deals."}>
          <Field label="Add tags" hint={options.tags.length ? undefined : <>There are no tags yet. <Link className="font-medium text-primary-ink hover:underline" href={`${scope.base}/tags`}>Create tags</Link>.</>}>
            <div className="flex flex-wrap items-center gap-1.5">
              {a.tagIds.map((id) => {
                const t = tagsById.get(id);
                return <TagChip key={id} name={t?.name ?? "A tag that no longer exists"} color={t?.color ?? "#98a2b3"} onRemove={readOnly ? undefined : () => setActions({ tagIds: a.tagIds.filter((x) => x !== id) })} />;
              })}
              {!readOnly && options.tags.some((t) => !a.tagIds.includes(t.id)) && a.tagIds.length < FORM_LIMITS.tags && (
                <Menu>
                  <MenuTrigger asChild><Button variant="ghost" size="sm" disabled={!identity}><Plus className="size-3.5" aria-hidden />Add a tag</Button></MenuTrigger>
                  <MenuContent align="start" className="max-h-72 overflow-y-auto">
                    {options.tags.filter((t) => !a.tagIds.includes(t.id)).map((t) => (
                      <MenuItem key={t.id} onSelect={() => setActions({ tagIds: [...a.tagIds, t.id] })}><i className="size-2.5 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}</MenuItem>
                    ))}
                  </MenuContent>
                </Menu>
              )}
            </div>
          </Field>

          <div className="space-y-3 rounded-xl border border-line p-3.5">
            <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
              <Switch
                checked={Boolean(a.opportunity)}
                disabled={!identity || !options.pipelines.length}
                onCheckedChange={(v) => {
                  if (!v) return setActions({ opportunity: null });
                  const p = options.pipelines[0];
                  const s = p?.stages.find((x) => x.kind === "open");
                  if (p && s) setActions({ opportunity: { pipelineId: p.id, stageId: s.id, name: "{{contact.full_name}} – {{form.name}}", valueQuestion: null } });
                }}
                aria-label="Create a deal"
              />
              <span>
                <span className="block font-medium text-ink">Create a deal</span>
                <span className="block text-[12px] text-muted">{options.pipelines.length ? "One deal per submission, linked to the contact. Sending the same answers twice never makes two." : "There's no pipeline yet. Create one in Pipelines first."}</span>
              </span>
            </label>
            {a.opportunity && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Pipeline" htmlFor="fa-pipe">
                  <Select id="fa-pipe" value={a.opportunity.pipelineId} onChange={(e) => {
                    const p = options.pipelines.find((x) => x.id === e.target.value);
                    const s = p?.stages.find((x) => x.kind === "open");
                    if (p && s) setActions({ opportunity: { ...a.opportunity!, pipelineId: p.id, stageId: s.id } });
                  }}>
                    {!pipeline && <option value={a.opportunity.pipelineId}>A pipeline that no longer exists</option>}
                    {options.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label="Starts in stage" htmlFor="fa-stage">
                  <Select id="fa-stage" value={a.opportunity.stageId} onChange={(e) => setActions({ opportunity: { ...a.opportunity!, stageId: e.target.value } })}>
                    {!pipeline?.stages.some((s) => s.id === a.opportunity!.stageId) && <option value={a.opportunity.stageId}>A stage that no longer exists</option>}
                    {(pipeline?.stages ?? []).filter((s) => s.kind === "open").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label="Deal name" htmlFor="fa-dealname" className="sm:col-span-2" hint="Placeholders without an answer are left out.">
                  <Input id="fa-dealname" ref={nameRef} value={a.opportunity.name} maxLength={200} onChange={(e) => setActions({ opportunity: { ...a.opportunity!, name: e.target.value } })} />
                  {!readOnly && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {NAME_TOKENS.map((t) => <button key={t.token} type="button" onClick={() => insertToken(t.token)} className="rounded-full border border-line bg-surface px-2 py-0.5 text-[12px] text-ink-2 hover:bg-surface-2">+ {t.label}</button>)}
                      {draft.questions.filter((q) => q.type !== "hidden").slice(0, 8).map((q) => (
                        <button key={q.key} type="button" onClick={() => insertToken(`{{answer.${q.key}}}`)} className="max-w-[12rem] truncate rounded-full border border-line bg-surface px-2 py-0.5 text-[12px] text-ink-2 hover:bg-surface-2">+ {q.label || q.key}</button>
                      ))}
                    </div>
                  )}
                </Field>
                <Field label="Deal value from" htmlFor="fa-dealvalue" optional hint={numberQuestions.length ? undefined : "Add a number question to take the value from an answer."}>
                  <Select id="fa-dealvalue" value={a.opportunity.valueQuestion ?? ""} onChange={(e) => setActions({ opportunity: { ...a.opportunity!, valueQuestion: e.target.value || null } })}>
                    <option value="">No value</option>
                    {numberQuestions.map((q) => <option key={q.key} value={q.key}>{q.label || q.key}</option>)}
                  </Select>
                </Field>
              </div>
            )}
          </div>

          <Field
            label="Assign through a rule"
            htmlFor="fa-rule"
            optional
            hint={options.assignmentRules.length
              ? "A contact rule gives the contact an owner; a deal rule assigns the deal. The rule's conditions, working hours and fallback apply."
              : <>No assignment rules {scope.can["contacts.assign"] ? "yet" : "you can see"}. {scope.can["contacts.assign"] && <Link className="font-medium text-primary-ink hover:underline" href={`${scope.base}/settings/assignment`}>Set one up</Link>}</>}
          >
            <Select id="fa-rule" value={a.assignmentRuleId ?? ""} disabled={!identity} onChange={(e) => setActions({ assignmentRuleId: e.target.value || null })}>
              <option value="">Don&apos;t assign</option>
              {options.assignmentRules.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.entity === "contact" ? "contacts" : "deals"})</option>)}
              {a.assignmentRuleId && !options.assignmentRules.some((r) => r.id === a.assignmentRuleId) && <option value={a.assignmentRuleId}>A rule chosen by someone else</option>}
            </Select>
          </Field>
        </Section>
      ) : null}

      <Section title="Tell the team" description="An in-app notification for each submission, only to people who can see contacts.">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {NOTIFY_ROLES.map((r) => (
            <label key={r} className="inline-flex min-h-11 items-center gap-2 text-[13px] text-ink-2 sm:min-h-9">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={a.notify.roles.includes(r)} onChange={(e) => setActions({ notify: { ...a.notify, roles: e.target.checked ? [...a.notify.roles, r] : a.notify.roles.filter((x) => x !== r) } })} />
              {ROLE_LABELS[r]}
            </label>
          ))}
          <label className="inline-flex min-h-11 items-center gap-2 text-[13px] text-ink-2 sm:min-h-9">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={a.notify.contactOwner} onChange={(e) => setActions({ notify: { ...a.notify, contactOwner: e.target.checked } })} />
            The contact&apos;s owner
          </label>
        </div>
      </Section>

      <Section title="After sending" description="What people see once their answers are in. On your website, they see the website's own thank-you page.">
        <Segmented
          id="fa-after"
          ariaLabel="After sending"
          value={a.after.kind}
          onChange={(k) => setActions({ after: k === "message" ? { kind: "message", message: a.after.kind === "message" ? a.after.message : "Thank you. We've received your details and will be in touch soon." } : { kind: "redirect", url: a.after.kind === "redirect" ? a.after.url : "https://" } })}
          options={[{ value: "message", label: "Show a message" }, { value: "redirect", label: "Go to a page" }]}
        />
        {a.after.kind === "message" ? (
          <Field label="Thank-you message" htmlFor="fa-thanks">
            <Textarea id="fa-thanks" rows={3} value={a.after.message} maxLength={FORM_LIMITS.successMessage} onChange={(e) => setActions({ after: { kind: "message", message: e.target.value } })} />
          </Field>
        ) : (
          <Field label="Page address" htmlFor="fa-redirect" hint="A full https:// address, such as your own thank-you page.">
            <Input id="fa-redirect" type="url" inputMode="url" value={a.after.url} maxLength={500} onChange={(e) => setActions({ after: { kind: "redirect", url: e.target.value } })} />
          </Field>
        )}
      </Section>

      <Section title="Page text" description="Used on the form's own page (and the heading of the preview).">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Heading" htmlFor="fa-title" optional hint="Empty uses the form's name.">
            <Input id="fa-title" value={draft.settings.title} maxLength={120} onChange={(e) => setSettings({ title: e.target.value })} />
          </Field>
          <Field label="Send button" htmlFor="fa-submit">
            <Input id="fa-submit" value={draft.settings.submitLabel} maxLength={40} onChange={(e) => setSettings({ submitLabel: e.target.value })} />
          </Field>
        </div>
        <Field label="Introduction" htmlFor="fa-intro" optional>
          <Textarea id="fa-intro" rows={3} value={draft.settings.intro} maxLength={FORM_LIMITS.intro} onChange={(e) => setSettings({ intro: e.target.value })} />
        </Field>
      </Section>
    </fieldset>
  );
}
