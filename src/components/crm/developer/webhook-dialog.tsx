"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { useCrmAction } from "@/components/crm/ui";
import { createWebhookAction, updateWebhookAction } from "@/app/actions/crm-developer";
import type { CrmScope } from "@/server/crm/page";
import type { WebhookSubscriptionView } from "@/server/crm/webhooks";

export interface EventInfo {
  type: string;
  group: string;
  label: string;
}

/** Adds a webhook, or edits one: a name, a public https address and the events it receives. Creating returns the signing secret once. */
export function WebhookDialog({ scope, events, editing, onClose, onCreated }: { scope: CrmScope; events: EventInfo[]; editing: WebhookSubscriptionView | null; onClose: () => void; onCreated: (secret: string) => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(editing?.name ?? "");
  const [url, setUrl] = React.useState(editing?.url ?? "");
  const [picked, setPicked] = React.useState<string[]>(editing?.eventTypes ?? []);
  const groups = React.useMemo(() => {
    const out = new Map<string, EventInfo[]>();
    for (const e of events) out.set(e.group, [...(out.get(e.group) ?? []), e]);
    return [...out.entries()];
  }, [events]);
  const set = (types: string[], on: boolean) => setPicked((p) => (on ? [...new Set([...p, ...types])] : p.filter((t) => !types.includes(t))));
  const valid = name.trim() && /^https:\/\/\S+$/i.test(url.trim()) && picked.length > 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={editing ? `Edit “${editing.name}”` : "Add a webhook"}
      description="iAcquire sends a signed POST request to this address each time one of the chosen events happens."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy("save")}
            disabled={!valid}
            onClick={async () => {
              const input = { name, url: url.trim(), eventTypes: picked };
              if (editing) {
                if (await run("save", () => updateWebhookAction(scope.orgId, editing.id, input), "Webhook saved.")) onClose();
                return;
              }
              const res = await run("save", () => createWebhookAction(scope.orgId, input), "Webhook added.");
              if (res && typeof res === "object") onCreated(res.secret);
            }}
          >
            {editing ? "Save" : "Add webhook"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="wh-name" hint="For example the app that receives the events.">
          <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <Field
          label="Endpoint address"
          htmlFor="wh-url"
          hint="A public https:// address on the standard port. Private, local and internal network addresses are refused. The address is checked when you save."
        >
          <Input id="wh-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/iacquire" maxLength={500} autoComplete="off" spellCheck={false} />
        </Field>
        <fieldset>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <legend className="text-[13px] font-medium text-ink-2">Events</legend>
            <span className="text-[12px] text-muted" aria-live="polite">{picked.length} selected</span>
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {groups.map(([group, items]) => {
              const all = items.every((e) => picked.includes(e.type));
              const some = !all && items.some((e) => picked.includes(e.type));
              return (
                <div key={group} className="rounded-xl border border-line p-3">
                  <label className="flex items-center gap-2.5 text-[13px] font-medium text-ink">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-[var(--primary)]"
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = some;
                      }}
                      onChange={(e) => set(items.map((i) => i.type), e.target.checked)}
                      aria-label={`All ${group.toLowerCase()} events`}
                    />
                    {group}
                  </label>
                  <ul className="mt-2 space-y-1.5 pl-1">
                    {items.map((e) => (
                      <li key={e.type}>
                        <label className="flex items-start gap-2.5 text-[13px] leading-snug text-ink-2">
                          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={picked.includes(e.type)} onChange={(ev) => set([e.type], ev.target.checked)} />
                          <span className="min-w-0">
                            {e.label}
                            <span className="block font-mono text-[12px] text-muted">{e.type}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
