import { describe, expect, it } from "vitest";
import { formatDemoLocalMoment } from "@/components/demo/local-time";

// The room's "open until" line is rendered in UTC on the server and replaced in the browser after hydration. Chrome refused the old
// combination of dateStyle/timeStyle with timeZoneName, so the whole room fell into the error boundary the first time it hydrated.
describe("a demo moment in the visitor's zone", () => {
  it("formats a real moment instead of throwing on an invalid Intl option combination", () => {
    const text = formatDemoLocalMoment("2026-10-24T12:00:00.000Z");
    expect(text).toContain("2026");
    expect(text.length).toBeGreaterThan(10);
  });
});
