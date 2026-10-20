import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chatNavTargets, specialistCaption } from "@/lib/chat-navigation";
import { AGENT_STATUS_LABEL, type AgentStatus } from "@/lib/agents";
import { calendarDaysAgo, compactRelativeTime, conversationGroup, fullTimestamp, groupConversations } from "@/lib/conversation-time";

describe("chat navigation targets", () => {
  it("sends a client workspace to the product dashboard and the AI Workforce directory", () => {
    const t = chatNavTargets("client", "lead-hunter");
    expect(t).toMatchObject({ home: "/overview", workforce: "/workforce", profile: "/workforce/lead-hunter", manage: "/workforce/lead-hunter?tab=configure", chat: "/chat/lead-hunter" });
  });

  it("sends the agency workspace to the agency dashboard and the agency workforce area", () => {
    const t = chatNavTargets("agency", "operations-manager");
    expect(t.home).toBe("/admin");
    expect(t.workforce).toBe("/admin/workforce");
    // The employee screens are shared: a Super Admin manages an internal employee through the same routes.
    expect(t.profile).toBe("/workforce/operations-manager");
    expect(t.manage).toBe("/workforce/operations-manager?tab=configure");
  });

  it("keeps management and chat as different routes for the same employee", () => {
    const t = chatNavTargets("client", "crm-manager");
    expect(t.chat).not.toBe(t.profile);
    expect(t.chat.startsWith("/chat/")).toBe(true);
    expect(t.profile.startsWith("/workforce/")).toBe(true);
  });

  it("describes every connection state honestly and never calls a blocked employee online", () => {
    const statuses = Object.keys(AGENT_STATUS_LABEL) as AgentStatus[];
    for (const status of statuses) expect(specialistCaption(status).length).toBeGreaterThan(0);
    expect(specialistCaption("online")).toBe("Online");
    for (const status of ["setup_required", "provisioning", "offline", "error", "disabled"] as const) {
      expect(specialistCaption(status)).not.toMatch(/online/i);
    }
  });
});

describe("conversation history dates", () => {
  // 2026-10-20 12:00 in Manila (UTC+8) is 04:00 UTC.
  const now = new Date("2026-10-20T04:00:00.000Z");

  it("groups by the workspace's calendar day, not the server's", () => {
    // 2026-10-19T17:00Z is 01:00 on Oct 20 in Manila (today) but Oct 19 in UTC (yesterday).
    expect(conversationGroup("2026-10-19T17:00:00.000Z", now, "Asia/Manila")).toBe("Today");
    expect(conversationGroup("2026-10-19T17:00:00.000Z", now, "UTC")).toBe("Yesterday");
  });

  it("buckets older conversations", () => {
    const zone = "Asia/Manila";
    expect(conversationGroup("2026-10-19T04:00:00.000Z", now, zone)).toBe("Yesterday");
    expect(conversationGroup("2026-10-14T04:00:00.000Z", now, zone)).toBe("Previous 7 days");
    expect(conversationGroup("2026-10-01T04:00:00.000Z", now, zone)).toBe("Previous 30 days");
    expect(conversationGroup("2026-08-01T04:00:00.000Z", now, zone)).toBe("Older");
  });

  it("treats a future timestamp (clock skew) as today and an unreadable one as older", () => {
    expect(calendarDaysAgo("2026-10-21T04:00:00.000Z", now, "UTC")).toBe(0);
    expect(conversationGroup("not-a-date", now, "UTC")).toBe("Older");
  });

  it("falls back to UTC for an unknown time zone instead of throwing", () => {
    expect(() => conversationGroup("2026-10-20T01:00:00.000Z", now, "Not/AZone")).not.toThrow();
    expect(fullTimestamp("2026-10-20T01:00:00.000Z", "Not/AZone")).toMatch(/2026/);
  });

  it("returns groups in display order and keeps the incoming order inside a group", () => {
    const items = [
      { id: "a", lastMessageAt: "2026-10-20T03:00:00.000Z" },
      { id: "b", lastMessageAt: "2026-08-01T00:00:00.000Z" },
      { id: "c", lastMessageAt: "2026-10-20T01:00:00.000Z" },
      { id: "d", lastMessageAt: "2026-10-19T04:00:00.000Z" },
    ];
    const grouped = groupConversations(items, now, "Asia/Manila");
    expect(grouped.map(([label]) => label)).toEqual(["Today", "Yesterday", "Older"]);
    expect(grouped[0][1].map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("formats compact relative times", () => {
    const t = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(compactRelativeTime(t(10_000), now)).toBe("now");
    expect(compactRelativeTime(t(5 * 60_000), now)).toBe("5m");
    expect(compactRelativeTime(t(3 * 3_600_000), now)).toBe("3h");
    expect(compactRelativeTime(t(2 * 86_400_000), now)).toBe("2d");
    expect(compactRelativeTime(t(15 * 86_400_000), now)).toBe("2w");
    expect(compactRelativeTime(t(60 * 86_400_000), now, "UTC")).toBe("Aug 21");
    expect(compactRelativeTime("2025-03-02T10:00:00.000Z", now, "UTC")).toBe("Mar 2, 2025");
    expect(compactRelativeTime(new Date(now.getTime() + 60_000).toISOString(), now)).toBe("now");
    expect(compactRelativeTime("garbage", now)).toBe("now");
  });
});

// ---- brand contrast ----------------------------------------------------------------------------------------------
// The sidebars are navy in both themes. These checks read the real tokens from globals.css, so a future edit that
// darkens a wordmark colour (or lightens the navy) fails here instead of in a screenshot review.
const css = fs.readFileSync(path.resolve(import.meta.dirname, "../src/app/globals.css"), "utf8");

function hex(value: string): [number, number, number] {
  const h = value.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance([r, g, b]: [number, number, number]) {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function token(name: string) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
  if (!match) throw new Error(`--${name} is not a hex token in globals.css`);
  return match[1];
}

describe("sidebar brand and text contrast (WCAG)", () => {
  const bg = token("nav-bg");
  const glow = token("nav-glow");

  it("keeps every navigation foreground at AAA contrast on the navy and AA on its glow", () => {
    for (const name of ["nav-ink", "nav-ink-2", "nav-muted", "nav-accent"]) {
      const colour = token(name);
      expect(ratio(colour, bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(7);
      expect(ratio(colour, glow), `${name} on ${glow}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps white text on the primary action fill readable", () => {
    expect(ratio("#ffffff", token("nav-action"))).toBeGreaterThanOrEqual(4.5);
  });

  it("uses fixed, light wordmark colours on dark chrome that clear AAA on the navy and AA on the glow", () => {
    const block = css.match(/\.workspace-nav \.logo-accent\s*\{([^}]*)\}/)?.[1] ?? "";
    const stops = [...block.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of stops) {
      expect(ratio(stop, bg), `wordmark stop ${stop}`).toBeGreaterThanOrEqual(7);
      expect(ratio(stop, glow), `wordmark stop ${stop} on glow`).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toMatch(/\.workspace-nav \.logo-word\s*\{\s*color:\s*#fff/);
  });

  it("does not paper over the logo colour at call sites any more", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx|ts)$/.test(entry.name) && /\[&_span\]:!text-white|\[&_a_span\]:text-white/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.resolve(import.meta.dirname, "../src"));
    expect(offenders).toEqual([]);
  });
});
