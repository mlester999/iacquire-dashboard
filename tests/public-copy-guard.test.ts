// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AuthShowcase } from "@/components/auth/showcase";
import { SETUP_FEE_USD, MAINTENANCE_MONTHLY_USD } from "@/lib/billing";
import { HELP_ARTICLES } from "@/server/help/articles";
import { renderEmail } from "@/server/email-render";
import { listPublicServices } from "@/server/catalog/service";
import { withSystem } from "@/server/db";
import { currentSetupCopy, type SetupCopyView } from "@/lib/setup-copy";
import {
  allowlistDrift,
  FORBIDDEN_COPY_PATTERNS,
  forbiddenValueMatches,
  PUBLIC_COPY_ALLOWLIST,
  sourceTextValues,
  typescriptFiles,
} from "./support/vocabulary-allowlist";

vi.mock("motion/react", async () => {
  const React = await import("react");
  const StaticDiv = ({ initial: _initial, animate: _animate, transition: _transition, ...props }: React.HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown }) => React.createElement("div", props);
  return { motion: { div: StaticDiv }, useReducedMotion: () => true };
});
vi.mock("next/image", () => ({ default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement("img", props) }));
afterEach(cleanup);

const PUBLIC_SOURCE_ROOTS = [
  "src/app/(auth)",
  "src/app/demo",
  "src/app/product",
  "src/app/purchase",
  "src/app/widget",
  "src/components/auth",
  "src/components/demo",
  "src/components/help",
  "src/lib/demo/showroom/content.ts",
  "src/server/demo/public.ts",
  "src/server/email-render.ts",
];
const PUBLIC_SOURCE_FILES = typescriptFiles(PUBLIC_SOURCE_ROOTS);
const ALL_TERMS = FORBIDDEN_COPY_PATTERNS.map(({ term }) => term);

function dynamicValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(dynamicValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(dynamicValues);
  return [];
}

interface PublicSeedCopy {
  catalog: Awaited<ReturnType<typeof listPublicServices>>;
  aqi: Array<{ title?: string; category?: string; body?: string; question?: string; route_prefix?: string; roles?: string[]; role?: string; slug?: string }>;
  setup: SetupCopyView[];
}

async function currentPublicSeedCopy(): Promise<PublicSeedCopy> {
  const [catalog, seeded] = await Promise.all([
    listPublicServices(),
    withSystem(async (db) => {
      const [entries, questions, tips, setup] = await Promise.all([
        db.query<PublicSeedCopy["aqi"][number]>("select title, category, body, route_prefix, roles from aqi_knowledge_entries where status = 'published' order by title"),
        db.query<PublicSeedCopy["aqi"][number]>("select question, route_prefix, role from aqi_suggested_questions where enabled order by sort_order, question"),
        db.query<PublicSeedCopy["aqi"][number]>("select title, body, route_prefix, roles, slug from aqi_contextual_tips where enabled order by priority, slug"),
        db.query<SetupCopyView>(`select task.key, task.title, task.client_title as "clientTitle", task.description, task.completion_notice as "completionNotice", task.client_action as "clientAction"
          from client_setup_template_tasks task join client_setup_templates template on template.id = task.template_id
          where template.is_default order by task.sort_order`),
      ]);
      return { aqi: [...entries.rows, ...questions.rows, ...tips.rows], setup: setup.rows.map((row) => currentSetupCopy(row)) };
    }),
  ]);
  return { catalog, ...seeded };
}

describe("public-copy guard", () => {
  it("ratchets public route source, current seeded copy, email and public help with exact reviewed counts", async () => {
    const matches = PUBLIC_SOURCE_FILES.flatMap((file) => forbiddenValueMatches(file, sourceTextValues(file), ALL_TERMS));
    const seeded = await currentPublicSeedCopy();
    for (const service of seeded.catalog) {
      matches.push(...forbiddenValueMatches(`db:public-service:${service.slug}`, dynamicValues(service).map((value) => ({ value, line: 1 }))));
    }
    for (const entry of seeded.aqi) {
      const key = entry.slug ?? entry.title ?? entry.question ?? "untitled";
      matches.push(...forbiddenValueMatches(`db:active-aqi:${key}`, dynamicValues(entry).map((value) => ({ value, line: 1 }))));
    }
    for (const task of seeded.setup) {
      matches.push(...forbiddenValueMatches(`db:default-setup:${task.key}`, dynamicValues(task).map((value) => ({ value, line: 1 }))));
    }
    for (const article of HELP_ARTICLES) {
      const visible = [article.title, article.body, ...article.links.map(({ label }) => label)];
      matches.push(...forbiddenValueMatches(`help:${article.id}`, visible.map((value) => ({ value, line: 1 }))));
    }

    const drift = allowlistDrift(matches, PUBLIC_COPY_ALLOWLIST);
    expect(
      { unexpected: drift.unexpected, stale: drift.stale, changed: drift.changed },
      JSON.stringify({ sourceFiles: PUBLIC_SOURCE_FILES.length, seededCatalog: seeded.catalog.length, activeAqi: seeded.aqi.length, defaultSetupTasks: seeded.setup.length, unexpected: drift.unexpected, stale: drift.stale, changed: drift.changed }, null, 2),
    ).toEqual({ unexpected: [], stale: [], changed: [] });
  });

  it("renders one AI Growth Partner in the public Auth showcase and demo-link email", () => {
    const { container } = render(React.createElement(AuthShowcase));
    const showcase = container.textContent ?? "";
    expect(showcase).toContain("AI Growth Partner");
    expect(showcase).not.toMatch(/\bHermes\b|\bZeng\b|\bAI employees?\b|\bAI team\b/i);

    const email = renderEmail({
      to: "prospect@example.test",
      template: "demo_link",
      subject: "Your private iAcquire preview",
      text: "Open your private demo preview from the secure link we sent.",
    }, { baseUrl: "https://app.example.test" });
    expect(email.html).toContain("See the AI Growth Partner in action");
    expect(email.html).toContain("Explore how the AI Growth Partner works in a private, sample-data preview.");
    expect(email.html).not.toMatch(/\bAI employees?\b|\bAI team\b/i);
  });

  it("ties any public dollar amounts to the approved setup or monthly constants", async () => {
    const seeded = await currentPublicSeedCopy();
    const values = [
      ...PUBLIC_SOURCE_FILES.flatMap((file) => sourceTextValues(file).map(({ value }) => value)),
      ...seeded.catalog.flatMap(dynamicValues),
      ...seeded.aqi.flatMap(dynamicValues),
      ...seeded.setup.flatMap(dynamicValues),
      ...HELP_ARTICLES.flatMap((article) => [article.title, article.body, ...article.links.map(({ label }) => label)]),
    ];
    const amounts = values.flatMap((value) => [...value.matchAll(/\$\s?((?:\d{1,3}(?:,\d{3})+|\d{3,})(?:\.\d{2})?|\d{1,2}\.\d{2})/g)].map((match) => Number(match[1].replaceAll(",", ""))));
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.every((amount) => amount === SETUP_FEE_USD || amount === MAINTENANCE_MONTHLY_USD)).toBe(true);
  });
});
