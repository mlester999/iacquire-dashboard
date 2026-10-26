"use client";

import * as React from "react";
import Link from "next/link";
import { BellOff, Hash, Lock, MessageSquarePlus, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { AvatarTile } from "@/components/ui/status";
import { cn, relativeTime } from "@/lib/utils";
import { conversationHref, railSections, railTitle, unreadAria, type RailEntry, type RailFilter } from "@/lib/staff-messages/view";
import { FORMER_NAME_TEXT } from "@/components/staff-messages/text";

// The list of the person's conversations: direct messages, groups, channels and archived ones, with what is unread in each. Every row is a link (the address is the
// conversation), at least 44 px tall. Nothing here reads the database: the page hands it the rail the server built and the live updates replace it.

export interface RailProps {
  entries: readonly RailEntry[];
  activeId: string | null;
  now: number;
  canChannels: boolean;
  onNew: (kind: "direct" | "group" | "channel") => void;
  onBrowse: () => void;
  onSearch: () => void;
}

function Tile({ entry }: { entry: RailEntry }) {
  if (entry.kind === "direct") return <AvatarTile name={entry.name || "?"} />;
  const Icon = entry.kind === "channel" ? (entry.visibility === "private" ? Lock : Hash) : Users;
  return (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-3 text-ink-2">
      <Icon className="size-4" />
    </span>
  );
}

function Row({ entry, active, now }: { entry: RailEntry; active: boolean; now: number }) {
  const when = entry.lastMessageAt ? relativeTime(entry.lastMessageAt, now) : "No messages yet";
  return (
    <li>
      <Link
        href={conversationHref(entry.id)}
        prefetch={false}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
          active && "bg-primary-soft",
        )}
      >
        <Tile entry={entry} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[14px] text-ink", entry.unread > 0 ? "font-semibold" : "font-medium")}>{railTitle(entry)}</span>
          <span className="block truncate text-[12px] text-muted">
            {entry.peer?.former ? `${FORMER_NAME_TEXT} · ` : ""}
            {when}
          </span>
        </span>
        {entry.muted && <BellOff className="size-3.5 shrink-0 text-faint" aria-label="Muted" role="img" />}
        {entry.unread > 0 && (
          <span
            role="img"
            aria-label={unreadAria(entry.unread, entry.muted)}
            className={cn("inline-flex min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 text-[12px] font-semibold tabular-nums", entry.muted ? "bg-surface-3 text-ink-2" : "bg-primary text-primary-on")}
          >
            {entry.unread > 99 ? "99+" : entry.unread}
          </span>
        )}
      </Link>
    </li>
  );
}

export function Rail({ entries, activeId, now, canChannels, onNew, onBrowse, onSearch }: RailProps) {
  const [filter, setFilter] = React.useState<RailFilter>("all");
  const [query, setQuery] = React.useState("");
  const sections = railSections(entries, { filter, query });
  const unreadTotal = entries.reduce((n, e) => n + (e.unread > 0 && !e.muted && !e.archived ? 1 : 0), 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-[16px] font-semibold tracking-tight text-ink">Conversations</h2>
          <Button variant="ghost" size="icon" aria-label="Search messages" onClick={onSearch}>
            <Search className="size-4" aria-hidden />
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="soft" size="icon" aria-label="Start a new conversation">
                <MessageSquarePlus className="size-4" aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => onNew("direct")}>New direct message</MenuItem>
              <MenuItem onSelect={() => onNew("group")}>New group</MenuItem>
              {canChannels && <MenuItem onSelect={() => onNew("channel")}>New channel</MenuItem>}
              <MenuItem onSelect={onBrowse}>Browse channels</MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <Input aria-label="Filter conversations" placeholder="Filter conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div role="group" aria-label="Show" className="flex gap-1.5">
          {(["all", "unread"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "inline-flex h-11 items-center rounded-full border px-4 text-[14px] font-medium sm:h-8",
                filter === f ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
              )}
            >
              {f === "all" ? "All" : `Unread${unreadTotal ? ` (${unreadTotal})` : ""}`}
            </button>
          ))}
        </div>
      </div>
      <nav aria-label="Conversations" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {sections.map((section) => (
          <section key={section.key} aria-labelledby={`rail-${section.key}`}>
            <h3 id={`rail-${section.key}`} className="px-3 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">
              {section.label}
            </h3>
            <ul className="space-y-0.5">
              {section.entries.map((entry) => (
                <Row key={entry.id} entry={entry} active={entry.id === activeId} now={now} />
              ))}
            </ul>
          </section>
        ))}
        {sections.length === 0 && (
          <p className="px-3 py-8 text-center text-[14px] leading-relaxed text-muted" role="status">
            {entries.length === 0
              ? "No conversations yet. Start a direct message, or browse the channels open to the team."
              : filter === "unread" && !query.trim()
                ? "Nothing unread."
                : "No conversation matches that."}
          </p>
        )}
      </nav>
    </div>
  );
}
