"use client";

import * as React from "react";
import { CornerDownRight, Download, Ellipsis, FileText, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { AvatarTile } from "@/components/ui/status";
import { cn, formatDateTime, formatTime, pluralize } from "@/lib/utils";
import type { MessageView } from "@/server/staff-messages/messages";
import { splitMentions } from "@/lib/staff-messages/mentions";
import { REACTIONS, reactionLabel, type Reaction } from "@/lib/staff-messages/reactions";
import { attachmentLabel, downloadHref } from "@/lib/staff-messages/view";
import { compileMentions, displayFromBody, budget, composeProblem, type ChosenMention } from "@/lib/staff-messages/composer";
import { FORMER_NAME_TEXT } from "@/components/staff-messages/text";
import { ReactionIcon } from "@/components/staff-messages/reaction-icons";

// One message: who wrote it and when, its text (always drawn as text, never as markup), its files, its reactions and the thread under it. The buttons offered are the ones the
// rules in src/lib/staff-messages/conversations.ts allow right now; the server decides every one of them again.

export interface RowActions {
  canReact: boolean;
  canReply: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface MessageRowProps {
  message: MessageView;
  /** The author's name and the time are written above the text (the first of a run). */
  header: boolean;
  /** Names for the people a message can mention, by id. */
  names: ReadonlyMap<string, string>;
  selfId: string;
  timeZone: string;
  allow: RowActions;
  highlighted?: boolean;
  /** Inside the thread panel: no reply count (it is the thread), a tighter layout. */
  inThread?: boolean;
  editing: boolean;
  onOpenThread?: (message: MessageView) => void;
  onStartEdit: (message: MessageView) => void;
  onCancelEdit: () => void;
  onSaveEdit: (message: MessageView, body: string) => Promise<{ ok: true } | { ok: false; error: string; code: string }>;
  onDelete: (message: MessageView) => void;
  onReact: (message: MessageView, reaction: Reaction, on: boolean) => void;
}

function Body({ message, names, selfId }: { message: MessageView; names: ReadonlyMap<string, string>; selfId: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink [overflow-wrap:anywhere]">
      {splitMentions(message.body).map((segment, i) =>
        segment.type === "text" ? (
          <React.Fragment key={i}>{segment.text}</React.Fragment>
        ) : (
          <span key={i} className={cn("rounded px-1 font-medium", segment.id === selfId ? "bg-warning-soft text-warning-ink" : "bg-primary-soft text-primary-ink")}>
            @{names.get(segment.id) ?? "someone"}
          </span>
        ),
      )}
    </p>
  );
}

/** The editor that replaces a message's text while it is being changed. Saving sends the stamp the editor opened with, so an edit made elsewhere is refused, not overwritten. */
function Editor({ message, names, onCancel, onSave }: { message: MessageView; names: ReadonlyMap<string, string>; onCancel: () => void; onSave: MessageRowProps["onSaveEdit"] }) {
  const start = React.useMemo(() => displayFromBody(message.body, (id) => names.get(id) ?? null), [message.body, names]);
  const [text, setText] = React.useState(start.text);
  const [chosen] = React.useState<ChosenMention[]>(start.chosen);
  const [saving, setSaving] = React.useState(false);
  const [problem, setProblem] = React.useState<{ text: string; conflict: boolean } | null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  const b = budget(text);
  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const invalid = composeProblem(text, chosen);
    if (invalid) {
      setProblem({ text: invalid, conflict: false });
      return;
    }
    setSaving(true);
    const result = await onSave(message, compileMentions(text, chosen));
    setSaving(false);
    if (!result.ok) setProblem({ text: result.error, conflict: result.code === "conflict" });
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label="Edit message">
      <label htmlFor={`edit-${message.id}`} className="sr-only">Edit your message</label>
      <textarea
        id={`edit-${message.id}`}
        ref={ref}
        value={text}
        rows={3}
        onChange={(e) => {
          setText(e.target.value);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
        }}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `edit-problem-${message.id}` : undefined}
        className="min-h-[88px] w-full resize-y rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[16px] leading-relaxed text-ink shadow-soft outline-none focus:border-primary focus:ring-4 focus:ring-primary/12 sm:text-sm"
      />
      {problem && (
        <p id={`edit-problem-${message.id}`} role="alert" className="text-[12.5px] text-danger-ink">
          {problem.text}
        </p>
      )}
      {b.near && <p className={cn("text-[12px]", b.over ? "text-danger-ink" : "text-muted")}>{b.over ? `${-b.remaining} characters too many` : `${b.remaining} characters left`}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={b.over}>Save</Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function MessageRow(props: MessageRowProps) {
  const { message, header, names, selfId, timeZone, allow, highlighted, inThread, editing, onOpenThread, onStartEdit, onCancelEdit, onSaveEdit, onDelete, onReact } = props;
  const authorName = message.authorId === selfId ? "You" : message.author.name;
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const hasMenu = !message.deleted && (allow.canReply || allow.canEdit || allow.canDelete) && !editing;
  const time = (
    <time dateTime={message.createdAt} title={formatDateTime(message.createdAt, timeZone)} className="text-[12px] text-muted">
      {formatTime(message.createdAt, timeZone)}
    </time>
  );
  return (
    <li
      id={`m-${message.id}`}
      data-message-id={message.id}
      data-seq={message.seq}
      className={cn("group relative flex gap-3 rounded-xl px-3 py-1 hover:bg-surface-2/60 focus-within:bg-surface-2/60", header && "mt-2", highlighted && "bg-warning-soft/60 ring-2 ring-warning/40")}
    >
      <div className="w-9 shrink-0 pt-0.5" aria-hidden={header ? undefined : true}>
        {header ? <AvatarTile name={message.author.name} /> : <span className="hidden pt-1 text-[11px] text-faint group-hover:block">{formatTime(message.createdAt, timeZone)}</span>}
      </div>
      <div className="min-w-0 flex-1">
        {header && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px] font-semibold text-ink">{authorName}</span>
            {message.author.former && <span className="text-[12px] text-muted">({FORMER_NAME_TEXT})</span>}
            {time}
            {message.editedAt && !message.deleted && <span title={`Edited ${formatDateTime(message.editedAt, timeZone)}`} className="text-[12px] text-muted">(edited)</span>}
          </div>
        )}
        {!header && !message.deleted && message.editedAt && <span className="sr-only">Edited</span>}
        {message.deleted ? (
          <p className="text-[14px] italic text-muted">This message was deleted.</p>
        ) : editing ? (
          <Editor message={message} names={names} onCancel={onCancelEdit} onSave={onSaveEdit} />
        ) : (
          <>
            <Body message={message} names={names} selfId={selfId} />
            {message.attachments.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="Files">
                {message.attachments.map((file) => (
                  <li key={file.id}>
                    <a
                      href={downloadHref(file.id)}
                      download
                      className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      <FileText className="size-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 truncate">{attachmentLabel(file)}</span>
                      <Download className="size-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="sr-only">Download</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {!message.deleted && !editing && (message.reactions.length > 0 || allow.canReact || (!inThread && message.replyCount > 0)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {message.reactions.map((r) => (
              <button
                key={r.reaction}
                type="button"
                aria-pressed={r.mine}
                aria-label={`${reactionLabel(r.reaction)}, ${pluralize(r.count, "person", "people")}${r.mine ? ", including you" : ""}`}
                disabled={!allow.canReact}
                onClick={() => onReact(message, r.reaction, !r.mine)}
                className={cn(
                  "inline-flex h-11 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium tabular-nums sm:h-8",
                  r.mine ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
                )}
              >
                <ReactionIcon reaction={r.reaction} className="size-3.5" />
                {r.count}
              </button>
            ))}
            {allow.canReact && (
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button type="button" aria-label="Add a reaction" className="inline-flex size-11 items-center justify-center rounded-full border border-line bg-surface text-muted hover:bg-surface-2 hover:text-ink sm:size-8">
                    <SmilePlus className="size-4" aria-hidden />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-2">
                  <ul className="grid grid-cols-4 gap-1" aria-label="Reactions">
                    {REACTIONS.map((r) => {
                      const mine = message.reactions.find((x) => x.reaction === r.key)?.mine === true;
                      return (
                        <li key={r.key}>
                          <button
                            type="button"
                            aria-label={r.label}
                            aria-pressed={mine}
                            onClick={() => {
                              setPickerOpen(false);
                              onReact(message, r.key, !mine);
                            }}
                            className={cn("flex size-11 items-center justify-center rounded-lg hover:bg-surface-2", mine && "bg-primary-soft text-primary-ink")}
                          >
                            <ReactionIcon reaction={r.key} className="size-5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </PopoverContent>
              </Popover>
            )}
            {!inThread && message.replyCount > 0 && onOpenThread && (
              <button
                type="button"
                onClick={() => onOpenThread(message)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-primary-ink hover:bg-primary-soft sm:min-h-8"
              >
                <CornerDownRight className="size-3.5" aria-hidden />
                {pluralize(message.replyCount, "reply", "replies")}
              </button>
            )}
          </div>
        )}
      </div>
      {hasMenu && (
        <div className="shrink-0">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for the message from ${authorName === "You" ? "you" : authorName}`}>
                <Ellipsis className="size-4" aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent>
              {allow.canReply && onOpenThread && !inThread && (
                <MenuItem onSelect={() => onOpenThread(message)}>
                  <Reply className="size-4" aria-hidden /> Reply in thread
                </MenuItem>
              )}
              {allow.canEdit && (
                <MenuItem onSelect={() => onStartEdit(message)}>
                  <Pencil className="size-4" aria-hidden /> Edit message
                </MenuItem>
              )}
              {allow.canDelete && (
                <MenuItem destructive onSelect={() => onDelete(message)}>
                  <Trash2 className="size-4" aria-hidden /> Delete message
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      )}
    </li>
  );
}
