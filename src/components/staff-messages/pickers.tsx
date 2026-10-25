"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Hash, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { AvatarTile } from "@/components/ui/status";
import { cn, pluralize } from "@/lib/utils";
import { addMembersAction, channelDirectoryAction, joinChannelAction, staffDirectoryAction, startChannelAction, startDirectAction, startGroupAction } from "@/app/actions/staff-messages";
import type { DirectoryChannel } from "@/server/staff-messages/conversations";
import type { DirectoryPerson } from "@/server/staff-messages/directory";
import { conversationHref, filterPeople, ROLE_LABEL } from "@/lib/staff-messages/view";
import { MAX_NAME_CHARS, MAX_TOPIC_CHARS } from "@/lib/staff-messages/limits";
import { useAction } from "@/components/staff-messages/use-action";

// The pickers: choosing people for a direct message, a group, a channel or an existing conversation, and browsing the channels open to the team. The lists come from the
// server on demand (names and roles only, never addresses); who may actually be added is decided again by the server.

function useDirectory(open: boolean) {
  const [people, setPeople] = React.useState<DirectoryPerson[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    staffDirectoryAction()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setPeople(res.data);
          setError(null);
        } else setError(res.error);
      })
      .catch(() => {
        if (!cancelled) setError("We couldn't load the team. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return { people, error };
}

export interface PeoplePickerProps {
  people: DirectoryPerson[] | null;
  error: string | null;
  exclude?: ReadonlySet<string>;
  /** One person chosen by tapping them, or several by ticking. */
  mode: "single" | "multi";
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  label: string;
}

export function PeoplePicker({ people, error, exclude, mode, selected, onSelect, label }: PeoplePickerProps) {
  const [query, setQuery] = React.useState("");
  const shown = people ? filterPeople(people, query, { exclude }) : [];
  if (error) return <p role="alert" className="text-[14px] text-danger-ink">{error}</p>;
  if (!people) {
    return (
      <p role="status" className="flex items-center gap-2 py-6 text-[14px] text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the team…
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <Input aria-label={`Search ${label}`} placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label={label}>
        {shown.map((person) => {
          const on = selected.includes(person.id);
          const content = (
            <>
              <AvatarTile name={person.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">{person.name}</span>
                <span className="block text-[12px] text-muted">{ROLE_LABEL[person.role]}</span>
              </span>
            </>
          );
          return (
            <li key={person.id}>
              {mode === "single" ? (
                <button type="button" onClick={() => onSelect([person.id])} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
                  {content}
                </button>
              ) : (
                <label className={cn("flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 hover:bg-surface-2", on && "bg-primary-soft")}>
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[var(--color-primary,#305ecb)]"
                    checked={on}
                    onChange={() => onSelect(on ? selected.filter((id) => id !== person.id) : [...selected, person.id])}
                  />
                  {content}
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="py-4 text-center text-[14px] text-muted" role="status">{people.length === 0 ? "There is no one else on the team who can use Messages yet." : "No one matches that."}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting a conversation
// ---------------------------------------------------------------------------

export type NewKind = "direct" | "group" | "channel";

export function NewConversationDialog({ kind, open, onOpenChange }: { kind: NewKind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { run, busy } = useAction();
  const { people, error } = useDirectory(open);
  const [name, setName] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [visibility, setVisibility] = React.useState<"staff" | "private">("staff");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);

  const go = (id: string) => {
    onOpenChange(false);
    router.push(conversationHref(id));
  };
  const title = kind === "direct" ? "New direct message" : kind === "group" ? "New group" : "New channel";

  const startDirect = async (ids: string[]) => {
    const res = await run("direct", () => startDirectAction(ids[0]), { quiet: true });
    if (res.ok) go(res.data.id);
    else setProblem(res.error);
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const res =
      kind === "group"
        ? await run("create", () => startGroupAction({ name, memberIds: picked }), { quiet: true })
        : await run("create", () => startChannelAction({ name, topic: topic || null, visibility, memberIds: picked }), { quiet: true });
    if (res.ok) go(res.data.id);
    else setProblem(res.error);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="md"
      description={kind === "direct" ? "Choose a colleague. If you already have a conversation with them, it opens." : kind === "group" ? "A private group is visible only to the people in it." : "Channels are for a topic or a team. Anyone who may use Messages can join an open channel."}
    >
      {kind === "direct" ? (
        <div className="space-y-3">
          <PeoplePicker people={people} error={error} mode="single" selected={[]} onSelect={startDirect} label="Team members" />
          {busy("direct") && <p role="status" className="text-[14px] text-muted">Opening…</p>}
          {problem && <p role="alert" className="text-[14px] text-danger-ink">{problem}</p>}
        </div>
      ) : (
        <form onSubmit={create} className="space-y-4">
          <Field label={kind === "group" ? "Group name" : "Channel name"} htmlFor="new-conversation-name" hint={kind === "channel" ? "Lower case, with hyphens. For example: client-onboarding." : undefined}>
            <Input id="new-conversation-name" value={name} maxLength={MAX_NAME_CHARS} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
          </Field>
          {kind === "channel" && (
            <>
              <Field label="Topic" htmlFor="new-conversation-topic" optional>
                <Input id="new-conversation-topic" value={topic} maxLength={MAX_TOPIC_CHARS} onChange={(e) => setTopic(e.target.value)} autoComplete="off" />
              </Field>
              <fieldset className="space-y-1">
                <legend className="text-[14px] font-medium text-ink-2">Who can join</legend>
                {([["staff", "Open to the team", "Anyone who may use Messages can find it and join."], ["private", "Private", "Only the people you add can see it."]] as const).map(([value, label, hint]) => (
                  <label key={value} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                    <input type="radio" name="channel-visibility" className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary,#305ecb)]" checked={visibility === value} onChange={() => setVisibility(value)} />
                    <span>
                      <span className="block text-[14px] font-medium text-ink">{label}</span>
                      <span className="block text-[13px] text-muted">{hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <div>
            <p className="mb-2 text-[14px] font-medium text-ink-2">{kind === "group" ? "People" : "Add people (optional)"}</p>
            <PeoplePicker people={people} error={error} mode="multi" selected={picked} onSelect={setPicked} label="Team members" />
            <p className="mt-2 text-[13px] text-muted" role="status">{pluralize(picked.length, "person", "people")} chosen, plus you.</p>
          </div>
          {problem && <p role="alert" className="text-[14px] text-danger-ink">{problem}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy("create")} disabled={!name.trim() || (kind === "group" && picked.length === 0)}>{kind === "group" ? "Create group" : "Create channel"}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Adding people to a conversation
// ---------------------------------------------------------------------------

export function AddPeopleDialog({ conversationId, memberIds, open, onOpenChange, onAdded }: { conversationId: string; memberIds: ReadonlySet<string>; open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const { run, busy } = useAction();
  const { people, error } = useDirectory(open);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const res = await run("add", () => addMembersAction({ conversationId, memberIds: picked }), { quiet: true });
    if (!res.ok) return setProblem(res.error);
    setPicked([]);
    onOpenChange(false);
    onAdded();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add people" size="md" description="They can read the earlier messages in this conversation. They start with nothing unread.">
      <form onSubmit={add} className="space-y-4">
        <PeoplePicker people={people} error={error} exclude={memberIds} mode="multi" selected={picked} onSelect={setPicked} label="Team members to add" />
        {problem && <p role="alert" className="text-[14px] text-danger-ink">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={busy("add")} disabled={picked.length === 0}>Add {picked.length > 0 ? picked.length : ""}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Channels open to the team
// ---------------------------------------------------------------------------

export function ChannelDirectoryDialog({ open, onOpenChange, canCreate, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; canCreate: boolean; onCreate: () => void }) {
  const router = useRouter();
  const { run, busy } = useAction();
  const [channels, setChannels] = React.useState<DirectoryChannel[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    channelDirectoryAction()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setChannels(res.data);
          setError(null);
        } else setError(res.error);
      })
      .catch(() => {
        if (!cancelled) setError("We couldn't load the channels. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const join = async (channel: DirectoryChannel) => {
    const res = await run(`join:${channel.id}`, () => joinChannelAction(channel.id), { quiet: true });
    if (!res.ok) return setError(res.error);
    onOpenChange(false);
    router.push(conversationHref(channel.id));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Channels" size="md" description="Channels open to the whole team. Private channels are not listed.">
      {error && <p role="alert" className="mb-3 text-[14px] text-danger-ink">{error}</p>}
      {!channels && !error && (
        <p role="status" className="flex items-center gap-2 py-6 text-[14px] text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading channels…
        </p>
      )}
      {channels && channels.length === 0 && (
        <div className="space-y-3 py-4 text-center">
          <p className="text-[14px] text-muted" role="status">No channel is open to the team yet.</p>
          {canCreate && <Button variant="soft" onClick={() => { onOpenChange(false); onCreate(); }}>Create a channel</Button>}
        </div>
      )}
      {channels && channels.length > 0 && (
        <ul className="space-y-1" aria-label="Open channels">
          {channels.map((channel) => (
            <li key={channel.id} className="flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
              <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-3 text-ink-2"><Hash className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">#{channel.name}</span>
                <span className="block truncate text-[12px] text-muted">{pluralize(channel.memberCount, "person", "people")}{channel.topic ? ` · ${channel.topic}` : ""}</span>
              </span>
              {channel.joined ? (
                <>
                  <Badge tone="success">Joined</Badge>
                  <Link href={conversationHref(channel.id)} prefetch={false} onClick={() => onOpenChange(false)} className="inline-flex h-11 items-center rounded-xl px-3 text-[14px] font-medium text-primary-ink hover:bg-primary-soft sm:h-8">Open</Link>
                </>
              ) : (
                <Button size="sm" variant="soft" loading={busy(`join:${channel.id}`)} onClick={() => join(channel)} aria-label={`Join #${channel.name}`}>Join</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted"><Lock className="size-3" aria-hidden /> Joining shows you the channel&apos;s earlier messages.</p>
    </Dialog>
  );
}
