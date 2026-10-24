import * as React from "react";
import { CircleCheck, CircleX, Eye, Frown, Heart, HandHeart, Laugh, Meh, PartyPopper, Rocket, ThumbsDown, ThumbsUp, type LucideIcon } from "lucide-react";
import type { Reaction } from "@/lib/staff-messages/reactions";

// The pictures for the twelve reactions. The names and the order are the server's (src/lib/staff-messages/reactions.ts); this only draws them, as icons rather than emoji so
// they look the same on every device and are never mistaken for text.

const ICONS: Record<Reaction, LucideIcon> = {
  thumbs_up: ThumbsUp,
  thumbs_down: ThumbsDown,
  heart: Heart,
  laugh: Laugh,
  surprised: Meh,
  sad: Frown,
  tada: PartyPopper,
  eyes: Eye,
  check: CircleCheck,
  pray: HandHeart,
  rocket: Rocket,
  cross: CircleX,
};

export function ReactionIcon({ reaction, className }: { reaction: Reaction; className?: string }) {
  const Icon = ICONS[reaction];
  return <Icon aria-hidden className={className ?? "size-4"} />;
}
