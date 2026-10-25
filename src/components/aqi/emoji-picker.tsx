"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

const GROUPS: Array<{ label: string; emojis: string[] }> = [
  { label: "Smileys", emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "😋", "😛", "😜", "🤪", "😝", "🤗", "🤔", "🤭", "🤫", "🤥", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "😮‍💨", "🤐", "😴", "😪"] },
  { label: "Gestures", emojis: ["👍", "👎", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👋", "🤚", "🖐️", "✋", "🖖", "🫱", "🫲", "🙏", "💪", "👏", "🙌", "👐", "🤲", "🤝"] },
  { label: "Hearts", emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟"] },
  { label: "Work", emojis: ["✅", "☑️", "✔️", "❌", "⚠️", "🚀", "💡", "📌", "📎", "📝", "📄", "📊", "📈", "📉", "🗂️", "📁", "🔒", "🔑", "🛠️", "⚙️", "🧭", "🎯", "🏆", "⏰", "📅", "💬", "📣", "🔔", "🔍", "🧠"] },
  { label: "Nature", emojis: ["🌱", "🌿", "🍀", "🌵", "🌴", "🌳", "🌲", "🌸", "🌼", "🌻", "🌞", "🌙", "⭐", "✨", "⚡", "🔥", "🌈", "☁️", "🌊", "❄️"] },
  { label: "Food", emojis: ["☕", "🍵", "🥤", "🍕", "🍔", "🍟", "🥗", "🍎", "🍊", "🍋", "🍓", "🍇", "🍩", "🍪", "🎂", "🍫"] },
];

const KEYWORDS: Record<string, string[]> = {
  smile: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂", "😊", "😇"],
  happy: ["😀", "😃", "😄", "😁", "😊", "🥰", "😍"],
  sad: ["😔", "😟", "😢", "😭", "😞", "😣"],
  check: ["✅", "☑️", "✔️"],
  yes: ["✅", "👍", "☑️"],
  no: ["❌", "👎"],
  thumb: ["👍", "👎"],
  heart: ["❤️", "🧡", "💛", "💚", "💙", "💜", "💖"],
  work: ["💼", "📊", "📈", "📝", "📌", "✅", "🚀"],
  party: ["🎉", "🎊", "🥳"],
  fire: ["🔥"],
  rocket: ["🚀"],
  warning: ["⚠️"],
  lock: ["🔒", "🔑"],
  coffee: ["☕"],
  idea: ["💡"],
};
const RECENT_KEY = "iacquire-aqi-emoji-recent";

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const [group, setGroup] = React.useState(GROUPS[0].label);
  const [recent, setRecent] = React.useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]; } catch { return []; }
  });
  const root = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    input.current?.focus();
  }, []);

  React.useEffect(() => {
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const all = GROUPS.flatMap((g) => g.emojis);
  const q = query.trim().toLowerCase();
  const keywordHits = Object.entries(KEYWORDS).filter(([word]) => word.includes(q)).flatMap(([, emojis]) => emojis);
  const visible = q
    ? [...new Set([...GROUPS.filter((g) => g.label.toLowerCase().includes(q)).flatMap((g) => g.emojis), ...keywordHits, ...all.filter((emoji) => emoji.includes(q))])].slice(0, 80)
    : GROUPS.find((g) => g.label === group)?.emojis ?? [];

  function choose(emoji: string) {
    const next = [emoji, ...recent.filter((item) => item !== emoji)].slice(0, 16);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
    onPick(emoji);
  }

  return (
    <div ref={root} role="dialog" aria-label="Choose an emoji" className="absolute bottom-full left-0 z-30 mb-2 w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-line bg-surface shadow-float">
      <div className="flex items-center gap-2 border-b border-line p-2.5">
        <Search className="size-3.5 text-muted" />
        <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search emoji" aria-label="Search emoji" className="h-8 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
        <button type="button" onClick={onClose} aria-label="Close emoji picker" className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface-2"><X className="size-3.5" /></button>
      </div>
      {!query && (
        <div className="relative flex gap-1 overflow-x-auto border-b border-line px-2 py-1.5" role="tablist" aria-label="Emoji categories">
          {GROUPS.map((item) => <button key={item.label} type="button" role="tab" aria-selected={group === item.label} onClick={() => setGroup(item.label)} className={`shrink-0 rounded-lg px-2 py-1 text-[10.5px] font-medium ${group === item.label ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2"}`}>{item.label}</button>)}
        </div>
      )}
      <div className="max-h-52 overflow-y-auto p-2">
        {!query && recent.length > 0 && <><p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Recent</p><div className="mb-2 flex flex-wrap">{recent.map((emoji) => <EmojiButton key={`recent-${emoji}`} emoji={emoji} onPick={choose} />)}</div></>}
        <div className="flex flex-wrap">{visible.map((emoji) => <EmojiButton key={emoji} emoji={emoji} onPick={choose} />)}</div>
        {!visible.length && <p className="p-4 text-center text-[12px] text-muted">No matching emoji.</p>}
      </div>
    </div>
  );
}

function EmojiButton({ emoji, onPick }: { emoji: string; onPick: (emoji: string) => void }) {
  return <button type="button" aria-label={`Insert ${emoji}`} onClick={() => onPick(emoji)} className="grid size-9 place-items-center rounded-lg text-[20px] leading-none transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">{emoji}</button>;
}
