"use client";

import * as React from "react";
import { FileText, Loader2, Paperclip, SendHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { discardAttachmentAction } from "@/app/actions/staff-messages";
import { normaliseBody } from "@/lib/staff-messages/body";
import { activeMention, applyMention, budget, compileMentions, enterSends, filterMembers, newClientId, type ChosenMention, type PendingMessage } from "@/lib/staff-messages/composer";
import { ATTACHMENT_ACCEPT, ATTACHMENT_TYPE_SUMMARY, attachmentProblem } from "@/lib/staff-messages/attachments";
import { MAX_ATTACHMENTS } from "@/lib/staff-messages/limits";
import { UPLOAD_URL } from "@/lib/staff-messages/live";
import { attachmentLabel } from "@/lib/staff-messages/view";
import { NETWORK_FAILURE } from "@/components/staff-messages/use-action";

// The message box. Text is plain; a name chosen after an @ becomes a mention. Files are saved the moment they are chosen (so a message can be sent without waiting) and belong
// to the person alone until the message that carries them is sent; a file taken back is removed. Enter sends with a mouse and keyboard, and starts a new line on a touch
// screen, where the Send button is the way to send. The field's text is 16 px on phones so the page does not jump when it is focused.

type Staged = PendingMessage["attachments"][number];

export interface ComposerProps {
  conversationId: string;
  threadRootId: string | null;
  /** The accessible name of the box, such as "Message #general". */
  label: string;
  placeholder: string;
  /** People who can be mentioned (the conversation's current members). */
  members: ReadonlyArray<ChosenMention>;
  selfId: string;
  /** Why nothing can be written here, or null. */
  blocked: string | null;
  onSend: (message: PendingMessage) => void;
  autoFocus?: boolean;
}

export function Composer({ conversationId, threadRootId, label, placeholder, members, selfId, blocked, onSend, autoFocus }: ComposerProps) {
  const [text, setText] = React.useState("");
  const [chosen, setChosen] = React.useState<ChosenMention[]>([]);
  const [caret, setCaret] = React.useState(0);
  const [staged, setStaged] = React.useState<Staged[]>([]);
  const [uploading, setUploading] = React.useState(0);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [pick, setPick] = React.useState(0);
  const [mentionDismissed, setMentionDismissed] = React.useState(false);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const id = React.useId();

  const active = mentionDismissed ? null : activeMention(text, caret);
  const options = active ? filterMembers(members, active.query, selfId) : [];
  const listOpen = options.length > 0;
  const b = budget(text);

  // The box grows with its text up to a limit, then scrolls.
  React.useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  React.useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  const choose = (member: ChosenMention) => {
    if (!active) return;
    const out = applyMention(text, active.start, caret, member);
    setText(out.text);
    setChosen((list) => (list.some((c) => c.id === member.id) ? list : [...list, member]));
    setCaret(out.caret);
    setPick(0);
    window.setTimeout(() => {
      area.current?.focus();
      area.current?.setSelectionRange(out.caret, out.caret);
    }, 0);
  };

  const upload = async (files: File[]) => {
    setProblem(null);
    const room = MAX_ATTACHMENTS - staged.length - uploading;
    if (files.length > room) setProblem(`You can attach up to ${MAX_ATTACHMENTS} files to a message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const refused = attachmentProblem({ name: file.name, size: file.size });
      if (refused) {
        setProblem(`${file.name}: ${refused}`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.set("conversationId", conversationId);
        form.set("file", file);
        const res = await fetch(UPLOAD_URL, { method: "POST", body: form, headers: { Accept: "application/json" } });
        const body = (await res.json().catch(() => null)) as (Staged & { error?: string }) | null;
        if (!res.ok || !body || !("id" in body)) setProblem(`${file.name}: ${body?.error ?? NETWORK_FAILURE}`);
        else setStaged((list) => [...list, { id: body.id, filename: body.filename, mimeType: body.mimeType, sizeBytes: body.sizeBytes }]);
      } catch {
        setProblem(`${file.name}: ${NETWORK_FAILURE}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const takeBack = (file: Staged) => {
    setStaged((list) => list.filter((f) => f.id !== file.id));
    // Best effort: a file that cannot be removed now is removed by the daily clean-up.
    void discardAttachmentAction(file.id).catch(() => undefined);
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (blocked || uploading > 0) return;
    // What is sent is what the server would store: tidied, with each chosen name as the id it stands for.
    const body = normaliseBody(compileMentions(text, chosen));
    if (!body.ok) {
      setProblem(staged.length > 0 && !text.trim() ? "Write a few words to send with your files." : body.message);
      return;
    }
    const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    onSend({
      clientId: newClientId(randomBytes),
      conversationId,
      body: body.body,
      threadRootId,
      attachments: staged,
      status: "sending",
      error: null,
      errorCode: null,
      createdAt: new Date().toISOString(),
    });
    setText("");
    setChosen([]);
    setStaged([]);
    setProblem(null);
    setCaret(0);
  };

  const finePointer = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(pointer: fine)").matches : true);

  if (blocked) {
    return (
      <p className="border-t border-line bg-surface-2 px-4 py-3 text-[14px] text-muted" role="status">
        {blocked}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="relative border-t border-line bg-surface p-3">
      {staged.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files to send">
          {staged.map((file) => (
            <li key={file.id} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-line bg-surface-2 pl-3 text-[14px] text-ink-2">
              <FileText className="size-4 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 truncate">{attachmentLabel(file)}</span>
              <button type="button" onClick={() => takeBack(file)} aria-label={`Remove ${file.filename}`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-3 hover:text-ink">
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploading > 0 && (
        <p className="mb-2 flex items-center gap-2 text-[13px] text-muted" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving {uploading === 1 ? "a file" : `${uploading} files`}…
        </p>
      )}
      {listOpen && (
        <ul id={`${id}-mentions`} role="listbox" aria-label="People you can mention" className="absolute inset-x-3 bottom-full z-10 mb-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-float">
          {options.map((member, i) => (
            // Pressing an option must not take the focus out of the text box, or the caret (and the @ being completed) would be lost.
            <li
              key={member.id}
              role="option"
              id={`${id}-mention-${i}`}
              aria-selected={i === pick}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(member)}
              className={cn("flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-left text-[14px] text-ink", i === pick ? "bg-primary-soft" : "hover:bg-surface-2")}
            >
              {member.name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={ATTACHMENT_ACCEPT}
          aria-label="Choose files to attach"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void upload(files);
          }}
        />
        <Button type="button" variant="ghost" size="icon" aria-label="Attach a file" title={`Attach a file (${ATTACHMENT_TYPE_SUMMARY})`} onClick={() => fileInput.current?.click()} disabled={staged.length + uploading >= MAX_ATTACHMENTS}>
          <Paperclip className="size-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-text`} className="sr-only">{label}</label>
          <textarea
            id={`${id}-text`}
            ref={area}
            value={text}
            rows={1}
            placeholder={placeholder}
            aria-controls={listOpen ? `${id}-mentions` : undefined}
            aria-activedescendant={listOpen ? `${id}-mention-${pick}` : undefined}
            aria-autocomplete="list"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setMentionDismissed(false);
              setPick(0);
              setProblem(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (listOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPick((p) => (e.key === "ArrowDown" ? (p + 1) % options.length : (p - 1 + options.length) % options.length));
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  choose(options[Math.min(pick, options.length - 1)]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionDismissed(true);
                  return;
                }
              }
              if (enterSends({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, finePointer())) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-[200px] min-h-11 w-full resize-none rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[16px] leading-relaxed text-ink shadow-soft outline-none placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12 sm:text-sm"
          />
        </div>
        <Button type="submit" size="icon" variant="primary" aria-label="Send message" disabled={uploading > 0 || b.over}>
          <SendHorizontal className="size-4" aria-hidden />
        </Button>
      </div>
      <div className="mt-1.5 flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {problem ? (
          <p id={`${id}-problem`} role="alert" className="text-[13px] text-danger-ink">
            {problem}
          </p>
        ) : (
          <span />
        )}
        {b.near && <span className={cn("text-[12px] tabular-nums", b.over ? "text-danger-ink" : "text-muted")}>{b.over ? `${-b.remaining} characters too many` : `${b.remaining} characters left`}</span>}
      </div>
    </form>
  );
}
