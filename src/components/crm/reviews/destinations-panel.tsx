"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ExternalLink, Link2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Switch } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  createReviewDestinationAction, deleteReviewDestinationAction, moveReviewDestinationAction, setReviewDestinationActiveAction, updateReviewDestinationAction,
} from "@/app/actions/crm-reviews";
import { cn } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { ReviewDestinationView } from "@/server/crm/reviews";
import { PLATFORM_HINTS, PLATFORM_KEYS, PLATFORM_LABELS, type ReviewPlatformKey } from "@/components/crm/reviews/model";

interface Draft {
  platform: ReviewPlatformKey;
  label: string;
  url: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * The business's public review links, in the order customers see them. Owners and managers add, edit, reorder, hide and remove them;
 * everyone else sees the list read-only. At most `maxActive` are shown to customers at once.
 */
export function DestinationsPanel({ scope, destinations, canManage, maxActive, maxTotal }: { scope: CrmScope; destinations: ReviewDestinationView[]; canManage: boolean; maxActive: number; maxTotal: number }) {
  const { run, busy } = useCrmAction();
  const [editing, setEditing] = React.useState<{ id: string | null; draft: Draft } | null>(null);
  const [removing, setRemoving] = React.useState<ReviewDestinationView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const ids = React.useId();
  const active = destinations.filter((d) => d.active).length;

  const save = async () => {
    if (!editing) return;
    setError(null);
    const d = editing.draft;
    if (!d.url.trim()) return setError("Paste the link where customers leave a review.");
    if (!/^https:\/\//i.test(d.url.trim())) return setError("Review links must start with https://.");
    const input = { platform: d.platform, label: d.label.trim() || null, url: d.url.trim() };
    const ok = await run("save-dest", () => (editing.id ? updateReviewDestinationAction(scope.orgId, editing.id, input) : createReviewDestinationAction(scope.orgId, input)), editing.id ? "Review link saved." : "Review link added.");
    if (ok) setEditing(null);
  };

  return (
    <section aria-labelledby={`${ids}-title`}>
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${ids}-title`} className="text-[15px] font-semibold text-ink">Public review links</h2>
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
              Every customer you ask sees these links, in this order, whatever they tell you privately. {active} of {maxActive} shown.
            </p>
          </div>
          {canManage && (
            <Button variant="secondary" size="sm" disabled={destinations.length >= maxTotal} onClick={() => { setError(null); setEditing({ id: null, draft: { platform: "google", label: "", url: "" } }); }}>
              <Plus className="size-4" aria-hidden />Add link
            </Button>
          )}
        </div>

        {destinations.length ? (
          <ol className="mt-4 divide-y divide-line rounded-xl border border-line" aria-label="Review links in the order customers see them">
            {destinations.map((d, i) => (
              <li key={d.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap", !d.active && "bg-surface-2/50")}>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><Link2 className="size-4" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[13.5px] font-medium text-ink">{d.label}</p>
                    <Badge tone="outline">{PLATFORM_LABELS[d.platform as ReviewPlatformKey] ?? d.platform}</Badge>
                    {!d.active && <Badge tone="neutral">Hidden</Badge>}
                  </div>
                  <a href={d.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-[12.5px] text-muted hover:text-ink">
                    <span className="truncate">{hostOf(d.url)}</span><ExternalLink className="size-3 shrink-0" aria-hidden /><span className="sr-only">(opens in a new tab)</span>
                  </a>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={d.active}
                      aria-label={d.active ? `Hide ${d.label} from customers` : `Show ${d.label} to customers`}
                      disabled={busy(`active-${d.id}`)}
                      onCheckedChange={(v) => run(`active-${d.id}`, () => setReviewDestinationActiveAction(scope.orgId, d.id, v), v ? "Shown to customers." : "Hidden from customers.")}
                    />
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${d.label} up`} disabled={i === 0 || busy(`move-${d.id}`)} onClick={() => run(`move-${d.id}`, () => moveReviewDestinationAction(scope.orgId, d.id, "up"))}><ArrowUp className="size-4" /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${d.label} down`} disabled={i === destinations.length - 1 || busy(`move-${d.id}`)} onClick={() => run(`move-${d.id}`, () => moveReviewDestinationAction(scope.orgId, d.id, "down"))}><ArrowDown className="size-4" /></Button>
                    <Menu>
                      <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${d.label}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => { setError(null); setEditing({ id: d.id, draft: { platform: d.platform as ReviewPlatformKey, label: d.label, url: d.url } }); }}><Pencil className="size-4" aria-hidden />Edit</MenuItem>
                        <MenuSeparator />
                        <MenuItem destructive onSelect={() => setRemoving(d)}><Trash2 className="size-4" aria-hidden />Remove</MenuItem>
                      </MenuContent>
                    </Menu>
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            compact
            className="mt-4"
            icon={<Link2 className="size-5" />}
            title="No review links yet"
            description={canManage ? "Add the page where customers leave a review, such as your Google Business Profile review link. Requests can't be sent until there is one." : "An owner or manager adds the business's review links. Requests can't be sent until there is one."}
          />
        )}
      </Card>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? "Edit review link" : "Add a review link"}
        description="Use the review site's own link for your business. Customers open it from their private feedback page."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={busy("save-dest")} onClick={save}>{editing?.id ? "Save" : "Add link"}</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Review site" htmlFor={`${ids}-platform`} hint={PLATFORM_HINTS[editing.draft.platform]}>
              <Select id={`${ids}-platform`} value={editing.draft.platform} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, platform: e.target.value as ReviewPlatformKey } })}>
                {PLATFORM_KEYS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
              </Select>
            </Field>
            <Field label="Link" htmlFor={`${ids}-url`} error={error}>
              <Input id={`${ids}-url`} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={editing.draft.url} aria-invalid={error ? true : undefined}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, url: e.target.value } })} />
            </Field>
            <Field label="Button text" htmlFor={`${ids}-label`} optional hint={`What customers see. Leave empty for "${PLATFORM_LABELS[editing.draft.platform]}".`}>
              <Input id={`${ids}-label`} maxLength={80} value={editing.draft.label} placeholder={PLATFORM_LABELS[editing.draft.platform]} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, label: e.target.value } })} />
            </Field>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.label ?? "this link"}?`}
        description="Customers won't see it any more, including people who were already sent a request. To stop showing it for a while instead, switch it off."
        confirmLabel="Remove"
        danger
        loading={busy("remove-dest")}
        onConfirm={async () => {
          if (!removing) return;
          if (await run("remove-dest", () => deleteReviewDestinationAction(scope.orgId, removing.id), "Review link removed.")) setRemoving(null);
        }}
      />
    </section>
  );
}
