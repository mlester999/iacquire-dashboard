"use client";

import * as React from "react";

export interface FeedbackMessage {
  id: string;
  feedbackRating: number | null;
  feedbackComment: string | null;
}

export interface FeedbackValue {
  rating: 1 | -1 | null;
  comment: string | null;
}

export interface FeedbackStatus {
  pending: boolean;
  error: boolean;
}

interface FeedbackWrite {
  confirmed: FeedbackValue;
  desired: FeedbackValue;
  revision: number;
  running: boolean;
  failed: FeedbackValue | null;
}

/** Keep writes alive when the panel closes, and serialize them per message so the latest vote wins. */
export function useMessageFeedback(onChange: (id: string, value: FeedbackValue) => void) {
  const writes = React.useRef(new Map<string, FeedbackWrite>());
  const [statuses, setStatuses] = React.useState<Record<string, FeedbackStatus>>({});

  async function flush(id: string, write: FeedbackWrite) {
    write.running = true;
    while (true) {
      const value = write.desired;
      const revision = write.revision;
      try {
        const response = await fetch("/api/aqi/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: id, rating: value.rating ?? 0, comment: value.comment ?? undefined }),
        });
        if (!response.ok) throw new Error("Feedback could not be saved.");
        write.confirmed = value;
      } catch {
        // A newer choice is already visible. Try that next instead of rolling it back.
        if (revision !== write.revision) continue;
        write.failed = value;
        onChange(id, write.confirmed);
        setStatuses((current) => ({ ...current, [id]: { pending: false, error: true } }));
        break;
      }
      if (revision !== write.revision) continue;
      setStatuses((current) => ({ ...current, [id]: { pending: false, error: false } }));
      break;
    }
    write.running = false;
  }

  function change(message: FeedbackMessage, rating: FeedbackValue["rating"], comment: string | null = null) {
    const value = { rating, comment: rating === null ? null : comment?.trim().slice(0, 1000) || null };
    let write = writes.current.get(message.id);
    const initial: FeedbackValue = {
      rating: message.feedbackRating === 1 || message.feedbackRating === -1 ? message.feedbackRating : null,
      comment: message.feedbackComment,
    };
    if (!write) {
      write = { confirmed: initial, desired: initial, revision: 0, running: false, failed: null };
      writes.current.set(message.id, write);
    } else if (!write.running && !write.failed) {
      // A reloaded conversation may contain feedback updated in another tab.
      write.confirmed = initial;
      write.desired = initial;
    }
    if (write.desired.rating === value.rating && write.desired.comment === value.comment && !write.failed) return;
    write.desired = value;
    write.revision += 1;
    write.failed = null;
    onChange(message.id, value);
    setStatuses((current) => ({ ...current, [message.id]: { pending: true, error: false } }));
    if (!write.running) void flush(message.id, write);
  }

  function retry(message: FeedbackMessage) {
    const failed = writes.current.get(message.id)?.failed;
    if (failed) change(message, failed.rating, failed.comment);
  }

  return { statuses, change, retry };
}
