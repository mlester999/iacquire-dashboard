"use client";

import * as React from "react";
import { Archive, ArchiveRestore, Copy, MessageSquareQuote, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  archiveCannedReplyAction, createCannedReplyAction, duplicateCannedReplyAction, restoreCannedReplyAction, updateCannedReplyAction,
} from "@/app/actions/crm-templates";
import { cn, relativeTime } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { TEMPLATE_LIMITS, tokenText, validateTemplate, type AnyTokenKey, type TemplateIssue } from "@/lib/messaging/tokens";
import { useCustomValueTokens } from "@/components/crm/custom-values/token-catalog";
import type { CrmScope } from "@/server/crm/page";
import type { TemplateView } from "@/server/crm/message-templates";
import { applySuggestion, ChannelLabel, CHANNEL_ORDER, insertAtCaret, TokenHighlight, TokenPicker, ValidationList } from "@/components/crm/templates/parts";
import { PreviewPanel } from "@/components/crm/templates/preview";
import type { FolderOption } from "@/components/crm/templates/types";

/**
 * Canned replies: saved answers a person inserts into the inbox composer, fills in, edits and sends themselves. They are never sent
 * automatically, so they need no approval; tokens are filled from the conversation's contact when inserted.
 */
export function CannedReplies({ scope, replies, folders, canManage, q, showArchived }: { scope: CrmScope; replies: TemplateView[]; folders: FolderOption[]; canManage: boolean; q: string; showArchived: boolean }) {
  const { run, busy } = useCrmAction();
  const [editing, setEditing] = React.useState<TemplateView | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<TemplateView | null>(null);
  const term = q.trim().toLowerCase();
  const shown = replies.filter((r) => (showArchived ? true : r.status !== "archived") && (!term || `${r.name} ${r.body} ${r.folderName ?? ""}`.toLowerCase().includes(term)));
  const groups = new Map<string, TemplateView[]>();
  for (const r of shown) {
    const k = r.folderName ?? "";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">Saved answers for the inbox. Insert one while replying, adjust it, then send it yourself. Tokens such as {tokenText("contact.first_name")} are filled from the conversation&apos;s contact.</p>
        {canManage && <Button onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />New canned reply</Button>}
      </div>
      {!shown.length ? (
        <Card>
          <EmptyState
            icon={<MessageSquareQuote className="size-5" />}
            title={replies.length ? "Nothing matches" : "No canned replies yet"}
            description={replies.length ? "Try a different search, or show archived replies." : "Save the answers your team gives most often: opening hours, directions, pricing questions. They appear in the inbox composer."}
            action={canManage && !replies.length ? <Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />Create one</Button> : undefined}
          />
        </Card>
      ) : (
        ordered.map(([folder, items]) => (
          <section key={folder || "none"} aria-label={folder || "No folder"}>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">{folder || "No folder"} <span className="font-normal">· {items.length}</span></h3>
            <Card className="divide-y divide-line overflow-hidden p-0">
              {items.map((r) => (
                <div key={r.id} className={cn("flex items-start gap-3 px-4 py-3", r.status === "archived" && "opacity-70")}>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(r)}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium text-ink">{r.name}</span>
                      <ChannelLabel channel={r.channel} />
                      {r.status === "archived" && <Badge>Archived</Badge>}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[12.5px] leading-relaxed text-muted"><TokenHighlight text={r.body} /></span>
                    <span className="mt-1 block text-[11.5px] text-faint" suppressHydrationWarning>v{r.currentVersion} · updated {relativeTime(r.updatedAt)}</span>
                  </button>
                  {canManage && (
                    <Menu>
                      <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => setEditing(r)}><Pencil className="size-4" aria-hidden />Edit</MenuItem>
                        <MenuItem onSelect={() => void run("dup", () => duplicateCannedReplyAction(scope.orgId, r.id), "Copy created.")}><Copy className="size-4" aria-hidden />Duplicate</MenuItem>
                        <MenuSeparator />
                        {r.status === "archived" ? (
                          <MenuItem onSelect={() => void run("restore", () => restoreCannedReplyAction(scope.orgId, r.id), "Restored.")}><ArchiveRestore className="size-4" aria-hidden />Restore</MenuItem>
                        ) : (
                          <MenuItem destructive onSelect={() => setArchiving(r)}><Archive className="size-4" aria-hidden />Archive</MenuItem>
                        )}
                      </MenuContent>
                    </Menu>
                  )}
                </div>
              ))}
            </Card>
          </section>
        ))
      )}
      {editing && <CannedReplyDialog scope={scope} reply={editing === "new" ? null : editing} folders={folders} canManage={canManage} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive "${archiving?.name ?? ""}"?`}
        description="It no longer appears in the inbox composer. You can restore it later."
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={async () => {
          if (archiving && (await run("archive", () => archiveCannedReplyAction(scope.orgId, archiving.id), "Archived."))) setArchiving(null);
        }}
      />
    </div>
  );
}

function CannedReplyDialog({ scope, reply, folders, canManage, onClose }: { scope: CrmScope; reply: TemplateView | null; folders: FolderOption[]; canManage: boolean; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const editable = canManage && reply?.status !== "archived";
  const [name, setName] = React.useState(reply?.name ?? "");
  const [channel, setChannel] = React.useState<Channel | "">(reply?.channel ?? "");
  const [folderId, setFolderId] = React.useState(reply?.folderId ?? "");
  const [body, setBody] = React.useState(reply?.body ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const customValues = useCustomValueTokens();
  const check = React.useMemo(() => validateTemplate(body, null, channel || null, { kind: "canned_reply", customValues }), [body, channel, customValues]);
  const fix = (i: TemplateIssue) => setBody((b) => applySuggestion(b, i));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={reply ? (editable ? "Edit canned reply" : reply.name) : "New canned reply"}
      description={reply ? `Version ${reply.currentVersion}. Saving changed wording records a new version.` : "Write it once; your team inserts it from the inbox."}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{editable ? "Cancel" : "Close"}</Button>
          {editable && (
            <Button loading={busy("save")} onClick={async () => {
              setError(null);
              if (!name.trim()) return setError("Name the reply.");
              if (!check.ok) return setError(check.errors[0].message);
              const input = { name: name.trim(), channel: channel || null, folderId: folderId || null, body };
              const ok = reply
                ? await run("save", () => updateCannedReplyAction(scope.orgId, reply.id, { ...input, expectedVersion: reply.currentVersion }), "Saved.")
                : await run("save", () => createCannedReplyAction(scope.orgId, input), "Canned reply created.");
              if (ok) onClose();
            }}>Save</Button>
          )}
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <Field label="Name" htmlFor="cr-name"><Input id="cr-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!editable} autoFocus={!reply} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Use on" htmlFor="cr-channel">
              <Select id="cr-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")} disabled={!editable}>
                <option value="">Every channel</option>
                {CHANNEL_ORDER.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]} only</option>)}
              </Select>
            </Field>
            <Field label="Folder" htmlFor="cr-folder" optional>
              <Select id="cr-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)} disabled={!editable}>
                <option value="">No folder</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="cr-body" className="text-[13px] font-medium text-ink-2">Reply</label>
              <TokenPicker disabled={!editable} onPick={(k: AnyTokenKey) => insertAtCaret(bodyRef.current, body, tokenText(k), setBody)} />
            </div>
            <Textarea id="cr-body" ref={bodyRef} rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={TEMPLATE_LIMITS.body} disabled={!editable} aria-describedby="cr-checks" />
          </div>
          <div id="cr-checks" className="rounded-2xl border border-line p-3.5"><ValidationList check={check} onFix={editable ? fix : undefined} /></div>
          {error && <p role="alert" className="text-[12.5px] text-danger-ink">{error}</p>}
        </div>
        <PreviewPanel scope={scope} channel={channel || null} subject={null} body={body} idPrefix="cr" />
      </div>
    </Dialog>
  );
}
