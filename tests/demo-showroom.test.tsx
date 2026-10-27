import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WhyPage from "@/app/demo/why/page";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import { DEMO_INDUSTRIES } from "@/lib/demo/industries";
import { CORE_INCLUDES, DIY_ROWS, IMPLEMENTATION_SETS, JOURNEY, NEXT_STEPS, PIPELINE_STAGES, PLAN_NOT_INCLUDED, STAGE_STORY, STUDIO_INCLUDES, VIEWS, VIEW_IDS, WHY_BLOCKS, faqs, isViewId, sampleDeals } from "@/lib/demo/showroom/content";
import { OVERSIGHT_FOOTER, SCOPE_NOTE, profiles, scenarioOf } from "@/lib/demo/showroom/employees";
import { scenarioFor } from "@/lib/demo/showroom/industry";
import { BUY_CONFIRM, CONSULT_CONFIRM, isConfirmKind } from "@/lib/demo/showroom/confirm-copy";

// What the prospect showroom may say, and the lines it must never cross. The showroom is a sales page that talks about a visitor's own business, so the tests here are about honesty:
// no invented result, price or percentage; every simulation labelled; the optional plan never presented as the price of the core system; and nothing in the showroom's code that could
// carry a visitor's details anywhere the demo's own endpoints do not.

const INDUSTRIES = [null, ...DEMO_INDUSTRIES.map((i) => i.value)];
/** Money, percentages, multipliers and guarantees: nothing the showroom writes about the AI Employees' work may contain them. */
const CLAIM = /[$€£]\s?\d|\d+(\.\d+)?\s?%|\b\d+\s?x\b|\bguarantee|\bROI\b|\bsaves? (you )?\d|\d+ hours? (a|per|saved)/i;

const flat = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(flat) : v && typeof v === "object" ? Object.values(v).flatMap(flat) : []);

describe("the six AI Employees in the showroom", () => {
  it("presents every role once, with what it needs a person for, and states no price, percentage or result", () => {
    const all = profiles();
    expect(all.map((p) => p.role).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    // A role has no nickname of its own: names belong to the company that chose them (see the naming tests below).
    for (const p of all) expect(Object.keys(p), p.role).not.toContain("alias");
    for (const p of all) {
      expect(p.needsApproval.length, p.role).toBeGreaterThan(0);
      expect(p.worksWith.length, p.role).toBeGreaterThan(0);
      for (const t of flat([p.solves, p.typicalDay, p.capabilities, p.example, p.worksWith, p.needsApproval])) expect(t, `${p.role}: ${t}`).not.toMatch(CLAIM);
    }
    expect(SCOPE_NOTE).toMatch(/implementation agreement/);
    expect(OVERSIGHT_FOOTER).toMatch(/approval/);
  });

  it("gives every role a simulated scenario for every industry, in which the customer-facing step waits for a person and nothing claims a result", () => {
    for (const industry of INDUSTRIES) {
      const sample = scenarioFor(industry);
      for (const role of AGENT_ROLE_KEYS) {
        const s = scenarioOf(role, sample);
        const where = `${industry ?? "generic"} / ${role}`;
        expect(s.steps.length, where).toBeGreaterThanOrEqual(3);
        expect(s.prompt, where).toMatch(/^(Show|See|Watch|How)\b/i);
        for (const t of flat(s)) expect(t, `${where}: ${t}`).not.toMatch(CLAIM);
        // Somewhere in each scenario something is left for a person to decide or review: a role that prepares a customer-facing message never sends it.
        expect(flat(s.steps.map((x) => x.rows)).join(" "), where).toMatch(/approval|decision|review|suggest|confirm/i);
        for (const step of s.steps) {
          // A sentence that says nothing happened ("Nothing is sent without you") is the opposite of a claim.
          const text = `${step.title} ${step.narration}`.replace(/nothing[^.]*\./gi, "");
          expect(text, `${where}: ${step.title}`).not.toMatch(/\b(has been|was|were|is) (sent|booked|emailed|called|charged)\b/i);
        }
      }
    }
  });
});

describe("the sample business", () => {
  it("is invented for every industry, complete, and never a claim about the visitor's real business", () => {
    for (const industry of INDUSTRIES) {
      const s = scenarioFor(industry);
      for (const [k, v] of Object.entries(s)) expect(flat(v).join(" ").trim().length, `${industry}: ${k}`).toBeGreaterThan(0);
      expect(new Set(s.prospects).size, String(industry)).toBe(5);
      expect(s.lead, String(industry)).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
      expect(s.benefit, String(industry)).toMatch(/\b(can|could|may)\b/);
      expect(s.benefit, String(industry)).not.toMatch(CLAIM);
      expect(s.benefit, String(industry)).not.toMatch(/\byour (business|company) (has|is|does)\b/i);
    }
    expect(scenarioFor("no-such-industry")).toEqual(scenarioFor(null));
  });

  it("walks one sample lead through the five stages, each owned by one of the six roles", () => {
    expect(PIPELINE_STAGES).toEqual(["New Lead", "Qualified", "Appointment Scheduled", "Proposal", "Won"]);
    for (const stage of PIPELINE_STAGES) expect(AGENT_ROLE_KEYS as readonly string[], stage).toContain(STAGE_STORY[stage].whoRole);
    const deals = sampleDeals(scenarioFor("real_estate"));
    expect(deals.filter((d) => d.followed)).toHaveLength(1);
    expect(deals.every((d) => (PIPELINE_STAGES as readonly string[]).includes(d.stage))).toBe(true);
  });
});

describe("the plans as the showroom words them", () => {
  it("keeps Automation Studio and managed storage out of the core implementation, and never makes the monthly plan a requirement", () => {
    for (const t of CORE_INCLUDES) expect(t, t).not.toMatch(/automation studio|media storage/i);
    expect(CORE_INCLUDES.join(" ")).toMatch(/no mandatory/i);
    expect(CORE_INCLUDES.join(" ")).toMatch(/n8n|zapier|make/i);
    expect(CORE_INCLUDES.join(" ")).toMatch(/api|webhook/i);
    expect(STUDIO_INCLUDES.join(" ")).toMatch(/automation studio/i);
    expect(PLAN_NOT_INCLUDED.join(" ")).toMatch(/separately|subscriptions|usage/i);
    const [setup, monthly] = [`$${SETUP_FEE_USD.toLocaleString("en-US")}`, `$${MAINTENANCE_MONTHLY_USD}`];
    const answers = faqs(setup, monthly);
    expect(answers.find((f) => /monthly fee/i.test(f.q))?.a).toMatch(/No\./);
    expect(answers.map((f) => f.a).join(" ")).toContain(setup);
    expect(answers.map((f) => f.a).join(" ")).toContain(monthly);
    expect(answers.find((f) => /consultation/i.test(f.q))?.a).toMatch(/does not book anything or charge anything/i);
  });

  it("compares with doing it yourself in words only: no competitor price, hour or percentage anywhere in the sales copy", () => {
    for (const t of flat([DIY_ROWS, WHY_BLOCKS, NEXT_STEPS, IMPLEMENTATION_SETS])) expect(t, t).not.toMatch(CLAIM);
    // The one digit that is not a number is in the name of a tool, n8n.
    for (const t of flat([DIY_ROWS, WHY_BLOCKS])) expect(t.replace(/n8n/gi, "n-eight-n"), t).not.toMatch(/\d/);
  });
});

describe("the views", () => {
  it("are the eight the brief names, in order, with the four guided steps pointing at real views", () => {
    expect(VIEWS.map((v) => v.label)).toEqual(["Overview", "AI Workforce", "CRM & Pipeline", "Inbox & Appointments", "Automation Studio", "Reports & Insights", "Plans & Pricing", "Why iAcquireOS?"]);
    expect(JOURNEY.map((j) => j.step)).toEqual([1, 2, 3, 4]);
    for (const j of JOURNEY) expect(VIEW_IDS, j.title).toContain(j.view);
    expect(JOURNEY.map((j) => j.view)).toEqual(["workforce", "crm", "automation", "summary"]);
    expect(isViewId("workforce")).toBe(true);
    for (const bad of ["", "admin", "../x", "<script>", undefined, null, 3]) expect(isViewId(bad)).toBe(false);
  });
});

describe("/demo/why, the case for iAcquireOS on its own address", () => {
  const markup = renderToStaticMarkup(<WhyPage />);
  const text = markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

  it("needs no demo session, has one heading 1, and states the published prices", () => {
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(text).toContain("Why iAcquireOS?");
    expect(text).toContain(`$${SETUP_FEE_USD.toLocaleString("en-US")}`);
    expect(text).toContain(`$${MAINTENANCE_MONTHLY_USD}`);
    expect(text).toContain("Do I have to pay a monthly fee to use the system?");
    expect(text).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it("records nothing: no form, no button that posts, only links to the request page and the room", () => {
    expect(markup).not.toMatch(/<form\b/);
    const hrefs = [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const h of hrefs) expect(["/demo", "/demo/room", "#demo-main"], h).toContain(h);
  });
});

// ---------------------------------------------------------------------------
// The showroom's own source
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "..");
const DIRS = ["src/components/demo/showroom", "src/lib/demo/showroom"].map((d) => path.join(ROOT, d));
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}
const FILES = DIRS.flatMap((d) => sources(d)).map((f) => ({ file: path.relative(ROOT, f).replaceAll("\\", "/"), text: readFileSync(f, "utf8") }));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the showroom's source", () => {
  it("has no pressure tactics or invented urgency in what it shows", () => {
    for (const { file, text } of FILES) {
      for (const bad of [/limited (time|spots|places)/i, /act now/i, /only \d+ (spots|places|left)/i, /hurry/i, /don'?t miss/i, /last chance/i, /(?<!not )\bguaranteed?\b/i]) expect(code(text), `${file} ${bad}`).not.toMatch(bad);
    }
  });

  it("sends a visitor's details nowhere but the demo's own endpoints, renders no raw markup, and keeps browser storage to the tour's progress", () => {
    for (const { file, text } of FILES) {
      const c = code(text);
      expect(c, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|eval\(|new Function/);
      for (const m of c.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/g)) expect(m[1], file).toMatch(/^\/api\/public\/demo\//);
      for (const m of c.matchAll(/action="([^"]+)"/g)) expect(m[1], file).toMatch(/^\/api\/public\/demo\//);
      if (!file.endsWith("journey.tsx")) expect(c, file).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
      expect(c, file).not.toMatch(/navigator\.sendBeacon|XMLHttpRequest|WebSocket|window\.open/);
      // A link that leaves the site must not hand the visitor's browser context to the other page.
      for (const m of c.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) expect(m[0], file).toMatch(/rel="noopener noreferrer"/);
    }
  });

  it("keeps the visitor's journey in this browser as step numbers only", () => {
    const journey = FILES.find((f) => f.file.endsWith("journey.tsx"))!.text;
    expect(journey).toMatch(/iaq-demo-journey-v1/);
    expect(journey).toMatch(/JSON\.stringify\(\{ visited \}\)/);
  });
});

// ---------------------------------------------------------------------------
// The confirmations and the portal's own theme
// ---------------------------------------------------------------------------

describe("the two confirmations", () => {
  const all = (v: unknown) => flat(v).join(" ");
  it("say what they do, promise no payment, subscription, workspace or booking, and use no number of their own", () => {
    expect(CONSULT_CONFIRM.title).toBe("Let's talk about your business.");
    expect(CONSULT_CONFIRM.free).toMatch(/free/i);
    expect(CONSULT_CONFIRM.next(true).join(" ")).toMatch(/does not itself reserve a meeting/);
    expect(CONSULT_CONFIRM.next(false).join(" ")).toMatch(/no time is offered/);
    expect(CONSULT_CONFIRM.success(true)).toMatch(/not booked until you choose a time/);
    expect(CONSULT_CONFIRM.success(false)).toMatch(/No appointment has been booked/);
    expect(CONSULT_CONFIRM.schedule).toBe("Choose a meeting time");
    expect(BUY_CONFIRM.description).toMatch(/only informs the team/);
    expect(BUY_CONFIRM.oneTimeVsMonthly).toMatch(/one-time/);
    expect(BUY_CONFIRM.usageNote).toMatch(/Separate from both prices/);
    expect(BUY_CONFIRM.confirm).toBe("Confirm my interest");
    expect(all(BUY_CONFIRM.next)).toMatch(/Nothing is charged, no subscription starts and no workspace is created/);
    expect(BUY_CONFIRM.success).toMatch(/Nothing was charged, no subscription started and no workspace was created/);
    // The prices are passed in from the billing configuration, never written into the words.
    for (const t of flat([CONSULT_CONFIRM, BUY_CONFIRM].map((c) => Object.values(c).filter((v) => typeof v !== "function")))) expect(t, t).not.toMatch(/[$€£]\s?\d|\d+\s?%|discount|limited|guarantee/i);
    for (const t of flat([CONSULT_CONFIRM, BUY_CONFIRM].map((c) => Object.values(c).filter((v) => typeof v !== "function")))) expect(t, t).not.toMatch(/order confirmed|payment received|you have purchased|booked for you/i);
  });
  it("accept only the two requests the demo records", () => {
    expect(isConfirmKind("consultation")).toBe(true);
    expect(isConfirmKind("buy")).toBe(true);
    for (const bad of ["", "purchase", "<script>", undefined, null, 1]) expect(isConfirmKind(bad)).toBe(false);
  });
});

describe("the showroom follows the portal's design system", () => {
  const css = FILES.filter((f) => f.file.endsWith(".css"));
  it("defines no colour theme of its own: no forced dark scheme, and no token redefined outside the navigation rail", () => {
    for (const { file, text } of css) {
      expect(code(text), file).not.toMatch(/color-scheme:\s*dark/);
      const outside = code(text).replace(/\.sx-on-nav\s*\{[^}]*\}/, "");
      expect(outside, file).not.toMatch(/--(bg|surface|surface-2|surface-3|ink|ink-2|muted|line|primary|violet)\s*:/);
    }
  });
  it("draws its pages from theme tokens, with a hard-coded colour only on the portal's navy rail and the brand gradient", () => {
    const allowed = ["workspace.tsx", "theme-switch.tsx", "journey.tsx", "overview.tsx"];
    for (const { file, text } of FILES.filter((f) => f.file.endsWith(".tsx"))) {
      if (allowed.some((a) => file.endsWith(a))) continue;
      expect(code(text), file).not.toMatch(/(bg|from|via|to|border)-\[#[0-9a-fA-F]{3,8}\]/);
    }
  });
  it("uses the shared theme control, so the demo and the portal agree on light, dark and system", () => {
    const sw = FILES.find((f) => f.file.endsWith("theme-switch.tsx"))!.text;
    expect(sw).toMatch(/from "@\/components\/providers"/);
    expect(sw).toMatch(/useTheme/);
    expect(sw).toMatch(/"light"[\s\S]*"dark"[\s\S]*"system"/);
    // One theme system: the demo never reads or writes the stored preference itself.
    for (const { file, text } of FILES) if (!file.endsWith("journey.tsx")) expect(code(text), file).not.toMatch(/iaq-theme|data-theme|dataset\.theme/);
    const html = renderToStaticMarkup(<WhyPage />);
    expect(html).toMatch(/aria-label="Colour theme"/);
    expect(html).toMatch(/Light<\/span>/);
    expect(html).toMatch(/Dark<\/span>/);
    expect(html).toMatch(/System<\/span>/);
  });
});

describe("the public entry pages follow the portal's design system too", () => {
  const ENTRY = ["src/components/demo/landing.tsx", "src/components/demo/landing-sections.tsx", "src/components/demo/request-form.tsx", "src/components/demo/shell.tsx", "src/components/demo/verify-panel.tsx"].map((f) => ({
    file: f,
    text: readFileSync(path.join(ROOT, f), "utf8"),
  }));
  it("draw from theme tokens only, with no hard-coded colour and no theme of their own", () => {
    for (const { file, text } of ENTRY) {
      expect(code(text), file).not.toMatch(/(bg|from|via|to|border|text|ring)-\[#[0-9a-fA-F]{3,8}\]/);
      expect(code(text), file).not.toMatch(/iaq-theme|data-theme|dataset\.theme|color-scheme/);
    }
  });
  it("send details only to the demo's own endpoints and show no sample as fact", () => {
    for (const { file, text } of ENTRY) {
      const c = code(text);
      for (const m of c.matchAll(/(?:action|fetch\()\s*=?\s*["']([^"']+)["']/g)) if (m[1].startsWith("/")) expect(m[1], file).toMatch(/^\/api\/public\/demo\//);
    }
    const sections = ENTRY.find((e) => e.file.endsWith("landing-sections.tsx"))!.text;
    expect(sections).toMatch(/Sample preview/);
    expect(sections).toMatch(/An invented example/);
  });
});
