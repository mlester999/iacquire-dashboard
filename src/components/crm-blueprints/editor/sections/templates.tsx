"use client";

import * as React from "react";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { CustomValueTokensProvider } from "@/components/crm/custom-values/token-catalog";
import { TokenPicker, ValidationList, insertAtCaret } from "@/components/crm/templates/parts";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { tokenText } from "@/lib/messaging/tokens";
import { MESSAGE_CHANNELS, type MessageChannel, type MessageTemplateAsset } from "@/lib/crm/blueprints/types";
import { blueprintTemplateCheck, valueTokenDefs } from "@/components/crm-blueprints/editor/template-check";
import { keysIn, updateAsset } from "@/components/crm-blueprints/editor/model";
import { AssetWorkspace, DetailCard, DetailHeader, FieldGrid, FolderSelect, IssueNotes, SectionNote, issuesOf, orNull, useAdder, useEditor } from "@/components/crm-blueprints/editor/parts";
import { KeyInput, ToggleRow } from "@/components/crm-blueprints/editor/inputs";

const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;

export function TemplatesSection() {
  const { content, remove, issues } = useEditor();
  const add = useAdder("messageTemplates");
  const items = content.assets.messageTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    detail: `${t.kind === "canned_reply" ? "Canned reply" : "Template"} · ${t.channel ? CHANNEL_LABELS[t.channel] : "Any channel"}${t.placeholder ? " · to write" : ""}`,
  }));
  const values = React.useMemo(() => valueTokenDefs(content), [content]);
  return (
    <CustomValueTokensProvider values={values}>
      <AssetWorkspace
        section="messageTemplates"
        title="Message templates"
        intro="Email, SMS and WhatsApp wording, and canned replies for the inbox. Placeholders such as {{contact.first_name}} and this Blueprint's configuration values are filled in when a message is sent."
        items={items}
        addLabel="Add template"
        onAdd={add.open}
        emptyText="Add the messages this kind of business sends: confirmations, reminders, follow-ups."
      >
        {(id) => {
          const t = content.assets.messageTemplates.find((x) => x.id === id)!;
          return (
            <DetailCard>
              <DetailHeader id={t.id} title={t.name} kind={t.kind === "canned_reply" ? "Canned reply" : "Message template"} onRemove={() => remove(t.id, t.name)} />
              <SectionNote>
                Templates arrive in a client&apos;s CRM as drafts: someone there approves the wording before any automated message uses it.
                {t.channel === "whatsapp" ? " WhatsApp templates also need Meta's approval for the client's own WhatsApp Business account." : ""}
              </SectionNote>
              <IssueNotes issues={issuesOf(issues, t.id).filter((i) => i.code !== "native_template" && i.code !== "unknown_value_token")} />
              <TemplateForm key={t.id} template={t} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </CustomValueTokensProvider>
  );
}

function TemplateForm({ template: t }: { template: MessageTemplateAsset }) {
  const { content, edit, readOnly } = useEditor();
  const set = (patch: Partial<MessageTemplateAsset>) => edit((c) => updateAsset(c, "messageTemplates", t.id, (x) => ({ ...x, ...patch })));
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const [focus, setFocus] = React.useState<"subject" | "body">("body");
  const check = React.useMemo(() => blueprintTemplateCheck(t, content), [t, content]);
  const taken = keysIn(content, "messageTemplates").filter((k) => k !== t.key);
  const hasSubject = t.kind === "template" && t.channel === "email";
  const setChannel = (channel: MessageChannel | null) => {
    set({
      channel,
      subject: t.kind === "template" && channel === "email" ? t.subject ?? "" : null,
      whatsapp: channel === "whatsapp" && t.kind === "template" ? t.whatsapp : null,
    });
  };
  const setKind = (kind: MessageTemplateAsset["kind"]) => {
    const channel = kind === "template" && !t.channel ? "email" : t.channel;
    set({ kind, channel, subject: kind === "template" && channel === "email" ? t.subject ?? "" : null, whatsapp: kind === "template" && channel === "whatsapp" ? t.whatsapp : null });
  };
  const insert = (key: Parameters<typeof tokenText>[0]) => {
    if (focus === "subject" && hasSubject) insertAtCaret(subjectRef.current, t.subject ?? "", tokenText(key), (subject) => set({ subject }));
    else insertAtCaret(bodyRef.current, t.body, tokenText(key), (body) => set({ body }));
  };
  return (
    <div className="space-y-4">
      <FieldGrid>
        <Field label="Name" htmlFor="mt-name"><Input id="mt-name" value={t.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Key" htmlFor="mt-key" hint="How a client's CRM recognises this template when it is applied again.">
          <KeyInput id="mt-key" value={t.key} pattern={KEY_RE} taken={taken} disabled={readOnly} invalidText="Lower-case letters, numbers, - and _ (48 at most)." onCommit={(key) => set({ key })} />
        </Field>
        <Field label="Kind" htmlFor="mt-kind">
          <Select id="mt-kind" value={t.kind} disabled={readOnly} onChange={(e) => setKind(e.target.value as MessageTemplateAsset["kind"])}>
            <option value="template">Template (sent by people and workflows)</option>
            <option value="canned_reply">Canned reply (inserted in the inbox)</option>
          </Select>
        </Field>
        <Field label="Channel" htmlFor="mt-channel">
          <Select id="mt-channel" value={t.channel ?? ""} disabled={readOnly} onChange={(e) => setChannel((e.target.value || null) as MessageChannel | null)}>
            {t.kind === "canned_reply" && <option value="">Any channel</option>}
            {MESSAGE_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
          </Select>
        </Field>
        <Field label="Purpose" htmlFor="mt-purpose" hint={t.purpose === "marketing" ? "Marketing messages go only to people who agreed to receive them." : "Replies, confirmations and reminders about something the person asked for."}>
          <Select id="mt-purpose" value={t.purpose} disabled={readOnly} onChange={(e) => set({ purpose: e.target.value as MessageTemplateAsset["purpose"] })}>
            <option value="service">Service</option>
            <option value="marketing">Marketing</option>
          </Select>
        </Field>
        <Field label="Category" htmlFor="mt-cat" optional><Input id="mt-cat" value={t.category ?? ""} maxLength={40} disabled={readOnly} onChange={(e) => set({ category: orNull(e.target.value) })} /></Field>
        <FolderSelect id="mt-folder" kind="template" value={t.folder} onChange={(folder) => set({ folder })} />
      </FieldGrid>
      {hasSubject && (
        <Field label="Subject" htmlFor="mt-subject">
          <Input id="mt-subject" ref={subjectRef} value={t.subject ?? ""} maxLength={200} disabled={readOnly} onFocus={() => setFocus("subject")} onChange={(e) => set({ subject: e.target.value })} />
        </Field>
      )}
      <Field label="Message" htmlFor="mt-body" hint={t.channel === "sms" ? "SMS: at most 1,600 characters." : t.channel === "whatsapp" && t.whatsapp ? "WhatsApp templates sent to Meta: at most 1,024 characters." : undefined}>
        <div className="space-y-2">
          {!readOnly && <TokenPicker onPick={insert} label={focus === "subject" && hasSubject ? "Insert into subject" : "Insert placeholder"} />}
          <Textarea id="mt-body" ref={bodyRef} rows={7} maxLength={5000} value={t.body} disabled={readOnly} onFocus={() => setFocus("body")} onChange={(e) => set({ body: e.target.value })} aria-describedby="mt-checks" />
        </div>
      </Field>
      <div id="mt-checks"><ValidationList check={check} /></div>
      {t.kind === "template" && t.channel === "whatsapp" && (
        <WhatsappDetails template={t} onChange={(whatsapp) => set({ whatsapp })} readOnly={readOnly} />
      )}
      {t.placeholder && (
        <ToggleRow
          id="mt-placeholder"
          label="Only the name is known"
          hint="This template came over without its wording. Write it, then switch this off: until then each client is asked to write it."
          checked={t.placeholder}
          disabled={readOnly}
          onChange={(placeholder) => set({ placeholder })}
        />
      )}
    </div>
  );
}

function WhatsappDetails({ template: t, onChange, readOnly }: { template: MessageTemplateAsset; onChange: (w: MessageTemplateAsset["whatsapp"]) => void; readOnly: boolean }) {
  const w = t.whatsapp;
  return (
    <div className="space-y-3 rounded-2xl border border-line p-3.5">
      <ToggleRow
        id="mt-wa"
        label="Submit to Meta as a WhatsApp template"
        hint="Needed to message people outside WhatsApp's 24-hour reply window. Each client submits it from its own WhatsApp Business account; the link to Meta's approval is never copied."
        checked={!!w}
        disabled={readOnly}
        onChange={(on) => onChange(on ? { name: t.key.replace(/-/g, "_").replace(/[^a-z0-9_]/g, ""), language: "en", category: t.purpose === "marketing" ? "marketing" : "utility" } : null)}
      />
      {w && (
        <FieldGrid className="sm:grid-cols-3">
          <Field label="Name at Meta" htmlFor="mt-wa-name" hint="Lower-case letters, numbers and _.">
            <Input id="mt-wa-name" value={w.name} maxLength={512} className="font-mono" disabled={readOnly} onChange={(e) => onChange({ ...w, name: e.target.value.toLowerCase() })} />
          </Field>
          <Field label="Language" htmlFor="mt-wa-lang" hint="For example en or en_US.">
            <Input id="mt-wa-lang" value={w.language} maxLength={6} className="font-mono" disabled={readOnly} onChange={(e) => onChange({ ...w, language: e.target.value })} />
          </Field>
          <Field label="Category" htmlFor="mt-wa-cat">
            <Select id="mt-wa-cat" value={w.category} disabled={readOnly} onChange={(e) => onChange({ ...w, category: e.target.value as NonNullable<MessageTemplateAsset["whatsapp"]>["category"] })}>
              <option value="utility">Utility</option>
              <option value="marketing">Marketing</option>
              <option value="authentication">Authentication</option>
            </Select>
          </Field>
        </FieldGrid>
      )}
    </div>
  );
}
