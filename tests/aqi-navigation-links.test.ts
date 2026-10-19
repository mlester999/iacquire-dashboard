import { describe, expect, it } from "vitest";
import { normalizeAqiNavigation, trimIncompleteLink, type AqiNavRoute } from "@/lib/aqi/navigation-links";

const OWNER: AqiNavRoute[] = [
  { path: "/overview", label: "Overview" },
  { path: "/workforce", label: "AI Workforce" },
  { path: "/knowledge", label: "Knowledge Center" },
  { path: "/settings", label: "Settings" },
  { path: "/settings/integrations", label: "Integrations" },
  { path: "/settings/team", label: "Team" },
  { path: "/support", label: "Support" },
];
const MEMBER: AqiNavRoute[] = OWNER.filter((route) => !["/settings/team", "/settings/integrations"].includes(route.path));
const AGENCY_AND_WORKSPACE: AqiNavRoute[] = [...OWNER, { path: "/admin", label: "Admin overview" }, { path: "/admin/integrations", label: "Integrations" }];

const run = (content: string, routes = OWNER, extra: Partial<Parameters<typeof normalizeAqiNavigation>[1]> = {}) =>
  normalizeAqiNavigation(content, { routes, ...extra });

describe("AQi navigation normalizer", () => {
  it("A: a bare known page name becomes a verified link only when authorized", () => {
    expect(run("Open [Team] to invite people.")).toBe("Open [Team](/settings/team) to invite people.");
    expect(run("Open [Team] to invite people.", MEMBER)).toBe("Open Team to invite people.");
  });

  it("A: legitimate bracketed text is preserved", () => {
    const text = "Press [Save] then [bracket] and [1]. - [ ] task [x]";
    expect(run(text)).toBe(text);
  });

  it("B: prose destinations map to the real route and never become raw syntax", () => {
    expect(run("Connect services in [Integrations](Settings → Integrations).")).toBe("Connect services in [Integrations](/settings/integrations).");
    expect(run("Connect services in [Integrations](Settings → Integrations).", MEMBER)).toBe("Connect services in Integrations.");
    expect(run("See [Integrations](Settings -> Integrations) now")).toBe("See [Integrations](/settings/integrations) now");
  });

  it("C: a label-as-destination reference is linked only when authorized", () => {
    expect(run("Employees live in [AI Workforce](AI Workforce).")).toBe("Employees live in [AI Workforce](/workforce).");
    expect(run("Employees live in [AI Workforce](AI Workforce).", [])).toBe("Employees live in AI Workforce.");
  });

  it("D: a real internal path is linked only for an authorized route", () => {
    expect(run("[Integrations](/settings/integrations)")).toBe("[Integrations](/settings/integrations)");
    expect(run("[Integrations](/settings/integrations)", MEMBER)).toBe("Integrations");
    expect(run("[Admin](/admin/aqi)")).toBe("Admin");
    expect(run("[x](/settings/integrations/some/deep/path?x=1#y)")).toBe("[x](/settings/integrations)");
  });

  it("E: unsafe or foreign destinations never become links", () => {
    expect(run("[x](javascript:alert(1))")).toBe("x");
    expect(run("[x](JaVaScRiPt:alert(1))")).toBe("x");
    expect(run("[x](data:text/html;base64,AAAA)")).toBe("x");
    expect(run("[x](vbscript:msgbox(1))")).toBe("x");
    expect(run("[x](//evil.example/steal)")).toBe("x");
    expect(run("[Help](https://evil.example)")).toBe("Help");
    expect(run("[Help](https://example.com/doc)", OWNER, { externalLinks: "keep" })).toBe("[Help](https://example.com/doc)");
  });

  it("H: brackets inside code are untouched", () => {
    expect(run("Use `[Team]` and `[Integrations](Settings → Integrations)` literally.")).toBe("Use `[Team]` and `[Integrations](Settings → Integrations)` literally.");
    const fenced = "Example:\n```\nconst a = [Team];\n[x](javascript:alert(1))\n```\nThen open [Team].";
    expect(run(fenced)).toBe("Example:\n```\nconst a = [Team];\n[x](javascript:alert(1))\n```\nThen open [Team](/settings/team).");
    expect(run("Open:\n```\n[Team] still open")).toBe("Open:\n```\n[Team] still open");
  });

  it("removes the redundant breadcrumb that follows a recognised page name", () => {
    expect(run("under [Team] (Settings → Team), and more")).toBe("under [Team](/settings/team), and more");
    expect(run("under [Team](/settings/team) (Settings → Team), and more")).toBe("under [Team](/settings/team), and more");
    // An aside that adds information stays.
    expect(run("under [Team] (owners only), and more")).toBe("under [Team](/settings/team) (owners only), and more");
  });

  it("resolves a page that exists in both the workspace and agency areas only when it is unambiguous", () => {
    expect(run("Open [Integrations].", AGENCY_AND_WORKSPACE)).toBe("Open Integrations.");
    expect(run("Open [Integrations](Settings → Integrations).", AGENCY_AND_WORKSPACE)).toBe("Open [Integrations](/settings/integrations).");
    expect(run("Open [Integrations](Admin → Integrations).", AGENCY_AND_WORKSPACE)).toBe("Open [Integrations](/admin/integrations).");
    expect(run("Open [Integrations].", AGENCY_AND_WORKSPACE, { currentPath: "/admin/clients" })).toBe("Open [Integrations](/admin/integrations).");
  });

  it("never touches images and keeps real link text", () => {
    expect(run("![Team](https://example.com/a.png)")).toBe("![Team](https://example.com/a.png)");
    expect(run("[manage your people here](/settings/team)")).toBe("[manage your people here](/settings/team)");
  });

  it("is idempotent", () => {
    const sample = "Open [Team] (Settings → Team) or [Integrations](Settings → Integrations); see [AI Workforce](AI Workforce). `[Team]`";
    const once = run(sample);
    expect(run(once)).toBe(once);
  });

  it("F: streamed prefixes never expose raw bracket syntax and the final text matches the full result", () => {
    const answer = "Add people under [Team] (Settings → Team), then connect tools in [Integrations](Settings → Integrations) or see [AI Workforce](AI Workforce).";
    const final = run(answer);
    for (let end = 1; end <= answer.length; end += 1) {
      const partial = run(answer.slice(0, end), OWNER, { streaming: true });
      expect(partial).not.toMatch(/\]\((?!\/)/);
      expect(partial).not.toMatch(/\[(?:Team|Integrations|AI Workforce)\](?!\()/);
      expect(partial).not.toMatch(/\[[^\]]*$/);
    }
    expect(run(answer, OWNER, { streaming: true })).toBe(final);
  });

  it("streaming does not hide an unfinished bracket inside an open code fence", () => {
    const partial = "```\nconst a = [Te";
    expect(trimIncompleteLink(partial)).toBe(partial);
    expect(run(partial, OWNER, { streaming: true })).toBe(partial);
  });

  it("streaming keeps ordinary text that merely contains a closed bracket", () => {
    expect(trimIncompleteLink("Press [Save] and continue")).toBe("Press [Save] and continue");
    expect(trimIncompleteLink("Press [Save]")).toBe("Press");
    expect(trimIncompleteLink("Text [label](/settings/te")).toBe("Text");
  });

  it("links a bare authorized path and hides one the person cannot open", () => {
    expect(run("Open /settings/team now", OWNER, { rawPaths: true })).toBe("Open [Team](/settings/team) now");
    expect(run("Open /settings/team now", MEMBER, { rawPaths: true })).toBe("Open the relevant page now");
    expect(run("See [Team](/settings/team) and /support", OWNER, { rawPaths: true })).toBe("See [Team](/settings/team) and [Support](/support)");
    expect(run("`/settings/team` stays literal", OWNER, { rawPaths: true })).toBe("`/settings/team` stays literal");
    expect(run("Docs live at https://example.com/settings/team", OWNER, { rawPaths: true })).toBe("Docs live at https://example.com/settings/team");
  });

  it("handles long, empty and pathological input without hanging", () => {
    expect(run("")).toBe("");
    const long = `${"[".repeat(5000)}${"x".repeat(5000)}`;
    const start = Date.now();
    run(long);
    run(long, OWNER, { streaming: true });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
