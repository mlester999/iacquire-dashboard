"use client";

import * as React from "react";
import { Archive, ArchiveRestore, LogOut, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/overlays";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { AvatarTile } from "@/components/ui/status";
import { ConfirmDialog } from "@/components/crm/ui";
import { formatDateTime, pluralize } from "@/lib/utils";
import { archiveConversationAction, leaveConversationAction, preferencesAction, removeMemberAction, updateConversationAction } from "@/app/actions/staff-messages";
import type { ConversationView } from "@/server/staff-messages/conversations";
import { eventText, headerSubtitle } from "@/lib/staff-messages/view";
import { MAX_NAME_CHARS, MAX_TOPIC_CHARS } from "@/lib/staff-messages/limits";
import { FORMER_NAME_TEXT, KIND_LABEL, NOTIFY_LABEL } from "@/components/staff-messages/text";
import { useAction } from "@/components/staff-messages/use-action";

// Everything about the open conversation that is not its messages: what it is, who is in it, how this person is told about it, what changed lately, and the ways out. Each
// control is offered only when the rules allow it (the `can` flags the server computed for this person); the server decides again on every request.

export interface DetailsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ConversationView;
  selfId: string;
  timeZone: string;
  /** Asks the page for fresh data after something changed. */
  onChanged: () => void;
  /** The person left the conversation: go back to the list. */
  onLeft: () => void;
  onAddPeople: () => void;
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="space-y-3 border-b border-line px-5 py-5 last:border-b-0">
      <h3 id={id} className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function RenameForm({ view, onChanged }: { view: ConversationView; onChanged: () => void }) {
  const { run, busy } = useAction();
  const c = view.conversation;
  const [name, setName] = React.useState(c.name);
  const [topic, setTopic] = React.useState(c.topic ?? "");
  const [problem, setProblem] = React.useState<{ text: string; conflict: boolean } | null>(null);
  const isChannel = c.kind === "channel";
  const changed = name !== c.name || topic !== (c.topic ?? "");
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const res = await run("rename", () => updateConversationAction({ conversationId: c.id, name, topic: isChannel ? topic : undefined, expectedName: c.name, expectedTopic: isChannel ? (c.topic ?? null) : undefined }), { quiet: true, success: "Saved." });
    if (!res.ok) {
      setProblem({ text: res.error, conflict: res.code === "conflict" });
      if (res.code === "conflict") onChanged();
    } else onChanged();
  };
  return (
    <form onSubmit={save} className="space-y-3" aria-label="Name and topic">
      <Field label={c.kind === "channel" ? "Channel name" : "Group name"} htmlFor="details-name">
        <Input id="details-name" value={name} maxLength={MAX_NAME_CHARS} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      {isChannel && (
        <Field label="Topic" htmlFor="details-topic" optional>
          <Input id="details-topic" value={topic} maxLength={MAX_TOPIC_CHARS} onChange={(e) => setTopic(e.target.value)} autoComplete="off" />
        </Field>
      )}
      {problem && (
        <p role="alert" className="text-[12.5px] text-danger-ink">
          {problem.text}
          {problem.conflict && <> The latest values are shown now; make your change again if it is still needed.</>}
        </p>
      )}
      <Button type="submit" size="sm" loading={busy("rename")} disabled={!changed || !name.trim()}>Save</Button>
    </form>
  );
}

export function DetailsPanel({ open, onOpenChange, view, selfId, timeZone, onChanged, onLeft, onAddPeople }: DetailsPanelProps) {
  const { run, busy } = useAction();
  const c = view.conversation;
  const [confirm, setConfirm] = React.useState<null | "leave" | "archive" | "restore" | { remove: string }>(null);
  const names = new Map((view.members ?? []).map((m) => [m.userId, m.name]));
  const nameOf = (id: string | null) => (id ? (id === selfId ? "You" : (names.get(id) ?? FORMER_NAME_TEXT)) : FORMER_NAME_TEXT);
  const kindLabel = KIND_LABEL[c.kind === "channel" ? `channel:${c.visibility}` : c.kind];
  const removing = typeof confirm === "object" && confirm !== null ? confirm.remove : null;

  const setPref = async (patch: { muted?: boolean; notify?: "all" | "mentions" | "none" }) => {
    const res = await run("prefs", () => preferencesAction({ conversationId: c.id, ...patch }));
    if (res.ok) onChanged();
  };
  const doConfirmed = async () => {
    const what = confirm;
    if (!what) return;
    if (what === "leave") {
      const res = await run("leave", () => leaveConversationAction(c.id), { success: "You left the conversation." });
      if (res.ok) {
        setConfirm(null);
        onOpenChange(false);
        onLeft();
      }
    } else if (what === "archive" || what === "restore") {
      const res = await run("archive", () => archiveConversationAction({ conversationId: c.id, archived: what === "archive" }), { success: what === "archive" ? "Archived." : "Brought back." });
      if (res.ok) {
        setConfirm(null);
        onChanged();
      }
    } else {
      const res = await run("remove", () => removeMemberAction({ conversationId: c.id, memberId: what.remove }), { success: "Removed." });
      if (res.ok) {
        setConfirm(null);
        onChanged();
      }
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} side="right" title={c.kind === "direct" ? "Conversation details" : `Details: ${c.kind === "channel" ? "#" : ""}${c.name}`} description={headerSubtitle({ kind: c.kind, topic: c.topic, memberCount: view.memberCount, archived: c.archived })}>
        <Section id="details-about" title="About">
          <p className="text-[14px] text-ink">{kindLabel}</p>
          {c.kind !== "direct" && view.can.rename ? <RenameForm key={`${c.name}|${c.topic ?? ""}`} view={view} onChanged={onChanged} /> : c.topic ? <p className="text-[13.5px] leading-relaxed text-ink-2">{c.topic}</p> : null}
          {c.kind === "direct" && <p className="text-[13px] text-muted">Only the two of you can read this conversation. A direct message can be muted but not left.</p>}
        </Section>

        {c.memberRole && (
          <Section id="details-notify" title="Your notifications">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[14px] text-ink">
              <input type="checkbox" className="size-5 accent-[var(--color-primary,#305ecb)]" checked={c.muted} disabled={busy("prefs")} onChange={(e) => void setPref({ muted: e.target.checked })} />
              Mute this conversation
            </label>
            <Field label="Tell me about" htmlFor="details-notify-select" hint="A mention always reaches you unless you choose Nothing.">
              <Select id="details-notify-select" value={c.notify} disabled={busy("prefs")} onChange={(e) => void setPref({ notify: e.target.value as "all" | "mentions" | "none" })}>
                {(["all", "mentions", "none"] as const).map((v) => (
                  <option key={v} value={v}>{NOTIFY_LABEL[v]}</option>
                ))}
              </Select>
            </Field>
          </Section>
        )}

        <Section id="details-people" title={`People (${view.memberCount})`}>
          {view.members ? (
            <ul className="space-y-1" aria-label="People in this conversation">
              {view.members.map((m) => (
                <li key={m.userId} className="flex min-h-12 items-center gap-3 rounded-xl px-1">
                  <AvatarTile name={m.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                    {m.userId === selfId ? `${m.name} (you)` : m.name}
                    {m.former && <span className="ml-1 text-[12px] text-muted">left the team</span>}
                  </span>
                  {m.role === "owner" && c.kind !== "direct" && <Badge tone="primary">Owner</Badge>}
                  {view.can.manageMembers && m.userId !== selfId && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => setConfirm({ remove: m.userId })}>
                      <UserMinus className="size-4" aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">{pluralize(view.memberCount, "person", "people")}. Join to see who they are.</p>
          )}
          {view.can.manageMembers && (
            <Button variant="soft" size="sm" onClick={onAddPeople}>
              <UserPlus className="size-4" aria-hidden /> Add people
            </Button>
          )}
        </Section>

        {view.events.length > 0 && (
          <Section id="details-activity" title="Recent changes">
            <ol className="space-y-2">
              {[...view.events].reverse().slice(0, 12).map((event, i) => (
                <li key={`${event.at}-${i}`} className="text-[13px] text-ink-2">
                  {eventText(event.kind, nameOf(event.actor), event.subject ? nameOf(event.subject) : null)}
                  <time dateTime={event.at} className="ml-2 text-[12px] text-muted">{formatDateTime(event.at, timeZone)}</time>
                </li>
              ))}
            </ol>
          </Section>
        )}

        {c.memberRole && (view.can.leave || view.can.archive) && (
          <Section id="details-leave" title="Leave or archive">
            <div className="flex flex-wrap gap-2">
              {view.can.leave && (
                <Button variant="secondary" size="sm" onClick={() => setConfirm("leave")}>
                  <LogOut className="size-4" aria-hidden /> Leave
                </Button>
              )}
              {view.can.archive && (
                <Button variant="secondary" size="sm" onClick={() => setConfirm(c.archived ? "restore" : "archive")}>
                  {c.archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
                  {c.archived ? "Bring it back" : "Archive"}
                </Button>
              )}
            </div>
          </Section>
        )}
      </Sheet>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "leave" ? "Leave this conversation?" : confirm === "archive" ? "Archive this conversation?" : confirm === "restore" ? "Bring this conversation back?" : "Remove this person?"}
        description={
          confirm === "leave"
            ? c.visibility === "private" || c.kind === "group"
              ? "You will stop seeing its messages. Someone has to add you again to come back."
              : "You will stop seeing its messages. You can join an open channel again from Browse channels."
            : confirm === "archive"
              ? "Nobody can write in it while it is archived. Its messages stay, and it can be brought back."
              : confirm === "restore"
                ? "People can write in it again."
                : `${names.get(removing ?? "") ?? "They"} will stop seeing this conversation. What they wrote stays for the others.`
        }
        confirmLabel={confirm === "leave" ? "Leave" : confirm === "archive" ? "Archive" : confirm === "restore" ? "Bring it back" : "Remove"}
        danger={confirm === "leave" || removing !== null}
        loading={busy("leave") || busy("archive") || busy("remove")}
        onConfirm={() => void doConfirmed()}
      />
    </>
  );
}
