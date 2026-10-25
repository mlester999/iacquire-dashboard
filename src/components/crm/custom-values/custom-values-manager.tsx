"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Braces, ChevronDown, Copy, ExternalLink, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { deleteCustomValueAction, getCustomValueAction } from "@/app/actions/crm-custom-values";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { CustomValueDialog } from "@/components/crm/custom-values/value-dialog";
import type { CustomValueUsage, CustomValueView } from "@/server/crm/custom-values";
import type { CrmScope } from "@/server/crm/page";

const GENERAL = "General";

export interface CustomValuesManagerProps {
  scope: CrmScope;
  values: CustomValueView[];
  limit: number;
  /** The workspace's default country calling code, so a local phone number is checked the way the server will store it. */
  defaultCallingCode: string | null;
}

/**
 * CRM Settings → Configuration Values. Lists the workspace's values by group with search, highlights required values that are still empty
 * (messages that use them are held), shows which templates use each one, and lets owners and managers add, edit and delete them.
 */
export function CustomValuesManager({ scope, values, limit, defaultCallingCode }: CustomValuesManagerProps) {
  const [q, setQ] = React.useState("");
  const [editing, setEditing] = React.useState<CustomValueView | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<CustomValueView | null>(null);
  const canManage = !!scope.can["fields.manage"] && !scope.readOnly;
  const missing = values.filter((v) => v.missingRequired);
  const term = q.trim().toLowerCase();
  const shown = term
    ? values.filter((v) => [v.label, v.key, v.token, v.value, v.group ?? "", v.typeLabel].some((s) => s.toLowerCase().includes(term)))
    : values;
  const groups = groupValues(shown);
  const groupNames = [...new Set(values.map((v) => v.group).filter((g): g is string => Boolean(g)))].sort((a, b) => a.localeCompare(b));
  const atLimit = values.length >= limit;

  return (
    <div>
      <PageTitle
        title="Configuration Values"
        description={
          <>
            Details your business states once and uses in many messages, such as a booking link, your address or a promo code. Templates insert them as{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">{"{{custom_values.key}}"}</code>; change a value here and every message sent afterwards uses the new one.
          </>
        }
        actions={canManage ? (
          <Button onClick={() => setEditing("new")} disabled={atLimit} title={atLimit ? `A workspace can have up to ${limit} values.` : undefined}>
            <Plus className="size-4" aria-hidden />New value
          </Button>
        ) : undefined}
      />

      {!canManage && (
        <div className="mb-4">
          <ReadOnlyNotice>{scope.readOnly ? "This support session is read-only." : "You can see these values. Owners and managers change them."}</ReadOnlyNotice>
        </div>
      )}

      {missing.length > 0 && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">
              {missing.length === 1 ? "1 required value is empty." : `${missing.length} required values are empty.`} Messages that use {missing.length === 1 ? "it" : "them"} are held, not sent, until {missing.length === 1 ? "it is" : "they are"} filled in.
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {missing.map((v) => (
                <li key={v.id}>
                  {canManage ? (
                    <button type="button" onClick={() => setEditing(v)} className="inline-flex min-h-9 items-center rounded-lg bg-surface/70 px-2.5 text-[13px] font-medium text-ink underline-offset-2 hover:underline sm:min-h-7">
                      Fill in {v.label}
                    </button>
                  ) : (
                    <a href={`#cv-${v.key}`} className="inline-flex min-h-9 items-center rounded-lg bg-surface/70 px-2.5 text-[13px] font-medium text-ink sm:min-h-7">{v.label}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!values.length ? (
        <Card>
          <EmptyState
            icon={<Braces className="size-5" />}
            title="No configuration values yet"
            description="Add the details your messages repeat, like your booking link or office address. Then insert them into any template from the token list, and update them here in one place."
            action={canManage ? <Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />Add a value</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input type="search" aria-label="Search configuration values" placeholder="Search names, keys and values" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <p className="text-[13px] text-muted" aria-live="polite">
              {term ? `${shown.length} of ${values.length} shown` : `${values.length} of ${limit} values`}
            </p>
          </div>
          {!shown.length ? (
            <Card className="px-4 py-8 text-center text-[14px] text-muted">No values match “{q.trim()}”.</Card>
          ) : (
            <div className="space-y-4">
              {groups.map(([name, items]) => (
                <section key={name} aria-labelledby={`cvg-${slug(name)}`}>
                  <h3 id={`cvg-${slug(name)}`} className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                    {name} <span className="font-normal normal-case tracking-normal">· {items.length}</span>
                  </h3>
                  <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                    {items.map((v) => (
                      <ValueRow key={v.id} scope={scope} value={v} canManage={canManage} onEdit={() => setEditing(v)} onDelete={() => setDeleting(v)} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {editing && (
        <CustomValueDialog
          scope={scope}
          value={editing === "new" ? null : editing}
          groups={groupNames}
          defaultCallingCode={defaultCallingCode}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteValueDialog scope={scope} value={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function groupValues(values: CustomValueView[]): Array<[string, CustomValueView[]]> {
  const map = new Map<string, CustomValueView[]>();
  for (const v of values) {
    const g = v.group ?? GENERAL;
    map.set(g, [...(map.get(g) ?? []), v]);
  }
  // Values without a group first, then groups alphabetically; values by name inside each.
  return [...map.entries()]
    .sort(([a], [b]) => (a === GENERAL ? -1 : b === GENERAL ? 1 : a.localeCompare(b)))
    .map(([g, items]) => [g, [...items].sort((x, y) => x.label.localeCompare(y.label))]);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";

function copy(text: string, what: string) {
  if (!navigator.clipboard) {
    toast.error("Copying isn't available here. Select the text and copy it instead.");
    return;
  }
  navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied.`), () => toast.error("Copy failed. Select the text and copy it instead."));
}

function ValueRow({ scope, value: v, canManage, onEdit, onDelete }: { scope: CrmScope; value: CustomValueView; canManage: boolean; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = React.useState(false);
  const usageId = `cv-usage-${v.id}`;
  return (
    <li id={`cv-${v.key}`} className={cn("scroll-mt-24 px-4 py-3", v.missingRequired && "bg-warning-soft/40")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
            <span className="break-words">{v.label}</span>
            <Badge tone="neutral">{v.typeLabel}</Badge>
            {v.missingRequired ? <Badge tone="danger"><AlertTriangle className="size-3" aria-hidden />Required, empty</Badge> : v.required ? <Badge tone="warning">Required</Badge> : null}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink-2">{v.token}</code>
            <Button variant="ghost" size="icon-sm" aria-label={`Copy the token for ${v.label}`} onClick={() => copy(v.token, "Token")}><Copy className="size-3.5" /></Button>
          </div>
          <div className="mt-1.5 text-[14px]"><ValuePreview value={v} /></div>
        </div>
        <div className="flex items-center gap-1">
          {v.usage.length ? (
            <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={usageId} onClick={() => setOpen((o) => !o)}>
              Used in {v.usage.length}
              <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
            </Button>
          ) : (
            <span className="px-2 text-[13px] text-muted">Not used yet</span>
          )}
          {canManage && (
            <Menu>
              <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${v.label}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={onEdit}><Pencil className="size-4" />Edit</MenuItem>
                <MenuItem onSelect={() => copy(v.token, "Token")}><Copy className="size-4" />Copy token</MenuItem>
                <MenuSeparator />
                <MenuItem destructive onSelect={onDelete}><Trash2 className="size-4" />Delete</MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>
      {open && v.usage.length > 0 && (
        <div id={usageId} className="mt-2.5 rounded-xl border border-line bg-surface-2/60 px-3 py-2">
          <UsageList scope={scope} usage={v.usage} />
        </div>
      )}
    </li>
  );
}

function ValuePreview({ value: v }: { value: CustomValueView }) {
  if (!v.value) {
    return v.required
      ? <span className="text-danger-ink">Not filled in yet. Messages that use it are held until it is.</span>
      : <span className="italic text-muted">Empty. Messages show nothing in its place.</span>;
  }
  if (v.type === "color") {
    return (
      <span className="inline-flex items-center gap-2 text-ink-2">
        <span className="size-4 rounded border border-line" style={{ background: v.value }} aria-hidden />
        <span className="font-mono text-[13px]">{v.value}</span>
      </span>
    );
  }
  if (v.type === "url" && /^https?:\/\//i.test(v.value)) {
    return (
      <a href={v.value} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 break-all text-primary hover:underline">
        {v.value}
        <ExternalLink className="size-3 shrink-0" aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    );
  }
  return <span className="line-clamp-3 whitespace-pre-wrap break-words text-ink-2">{v.value}</span>;
}

const KIND_LABEL: Record<CustomValueUsage["kind"], string> = { template: "Template", canned_reply: "Canned reply", campaign: "Campaign" };

function usageStatus(u: CustomValueUsage): { label: string; tone: "success" | "warning" | "neutral" } {
  if (u.kind === "campaign") return { label: u.status.replace(/_/g, " "), tone: u.blocking ? "warning" : "neutral" };
  if (u.kind === "canned_reply") return { label: `v${u.version ?? 1}`, tone: "neutral" };
  return u.status === "approved" ? { label: `Approved v${u.version ?? 1}`, tone: "success" } : { label: "Draft", tone: "warning" };
}

export function UsageList({ scope, usage }: { scope: CrmScope; usage: CustomValueUsage[] }) {
  return (
    <ul className="space-y-1.5 text-[13px]">
      {usage.map((u) => {
        const status = usageStatus(u);
        const href = !u.name
          ? null
          : u.kind === "template"
            ? `${scope.base}/templates?template=${u.id}`
            : u.kind === "canned_reply"
              ? `${scope.base}/templates?tab=canned`
              : `${scope.base}/campaigns`;
        return (
          <li key={`${u.kind}-${u.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted">{KIND_LABEL[u.kind]}</span>
            {href ? <Link href={href} className="font-medium text-ink hover:text-primary hover:underline">{u.name}</Link> : <span className="text-muted">one you can&apos;t open</span>}
            <Badge tone={status.tone} className="capitalize">{status.label}</Badge>
            {u.blocking && <span className="text-muted">· sends automatically, so this value can&apos;t be deleted while it&apos;s used</span>}
          </li>
        );
      })}
    </ul>
  );
}

function DeleteValueDialog({ scope, value: listed, onClose }: { scope: CrmScope; value: CustomValueView; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [confirmed, setConfirmed] = React.useState(false);
  // Where it is used may have changed since the list loaded (a template approved meanwhile): the dialog checks again when it opens. The
  // server checks once more when deleting.
  const [fresh, setFresh] = React.useState<CustomValueView | null>(null);
  React.useEffect(() => {
    let live = true;
    getCustomValueAction(scope.orgId, listed.id)
      .then((res) => {
        if (live && res.ok) setFresh(res.data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [scope.orgId, listed.id]);
  const value = fresh ?? listed;
  const blocking = value.usage.filter((u) => u.blocking);
  const others = value.usage.filter((u) => !u.blocking);
  const needsConfirm = others.length > 0;
  const blocked = blocking.length > 0;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={blocked ? `“${value.label}” is in use` : `Delete “${value.label}”?`}
      confirmLabel="Delete value"
      danger
      loading={busy("delete")}
      confirmDisabled={blocked || (needsConfirm && !confirmed)}
      description={
        blocked
          ? `It can't be deleted while ${blocking.length === 1 ? "something that sends automatically uses" : `${blocking.length} things that send automatically use`} ${value.token}. Remove the token from ${blocking.length === 1 ? "it" : "them"} first: editing an approved template sends it back to draft for approval.`
          : value.usage.length
            ? `${value.token} is used in ${value.usage.length === 1 ? "the place" : `the ${value.usage.length} places`} below. After deleting, ${value.usage.length === 1 ? "it" : "they"} can't be saved, approved or sent until the token is removed.`
            : `Templates can no longer use ${value.token}. This can't be undone.`
      }
      onConfirm={async () => {
        if (await run("delete", () => deleteCustomValueAction(scope.orgId, value.id, needsConfirm && confirmed), "Value deleted.")) onClose();
      }}
    >
      {value.usage.length > 0 && (
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-surface-2/60 px-3 py-2">
            <UsageList scope={scope} usage={blocked ? blocking : others} />
          </div>
          {!blocked && needsConfirm && (
            <label className="flex items-start gap-2.5 text-[14px] text-ink-2">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I understand {others.length === 1 ? "this one" : `these ${others.length}`} will need {value.token} removed before {others.length === 1 ? "it" : "they"} can be used again.
            </label>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
