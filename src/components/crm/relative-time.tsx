import { formatDateTime, relativeTime } from "@/lib/utils";

/**
 * "3 minutes ago" for a moment in time, with the exact time (in the workspace's zone) as its tooltip. The words depend on the clock, so the
 * server's HTML and the browser's first render can differ across a minute boundary. That difference is expected: the text sits directly in
 * this element, which suppresses the hydration warning (React's suppressHydrationWarning reaches only an element's own text and attributes,
 * not its children's).
 */
export function RelativeTime({ iso, timezone, className }: { iso: string; timezone?: string; className?: string }) {
  return (
    <time dateTime={iso} title={timezone ? formatDateTime(iso, timezone) : undefined} className={className} suppressHydrationWarning>
      {relativeTime(iso)}
    </time>
  );
}
