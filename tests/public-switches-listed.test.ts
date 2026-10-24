// The emergency stops for the customer-facing pages (website chat, proposals, invoices, reviews) are the same kind of switch, so they are listed the same way: in the schema, in
// both example files (off, with a value the schema accepts) and pinned off in the browser QA environment. A new one that is added in the schema alone fails here.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRM_QA_ENV } from "../scripts/crm-qa-env.mjs";

const text = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const valueOf = (file: string, name: string) => new RegExp(`^${name}=(.*?)\\r?$`, "m").exec(text(file))?.[1];
const SWITCHES = [...text("src/server/env.ts").matchAll(/^\s+([A-Z][A-Z_]*_PUBLIC_DISABLED): bool,/gm)].map((m) => m[1]);

describe("the switches that stop a customer-facing page for every workspace", () => {
  it("are found in the schema (the four pages that have one)", () => {
    expect(SWITCHES).toEqual(expect.arrayContaining(["WEBCHAT_PUBLIC_DISABLED", "PROPOSALS_PUBLIC_DISABLED", "INVOICES_PUBLIC_DISABLED", "REVIEWS_PUBLIC_DISABLED"]));
  });

  it.each([".env.example", ".env.staging.example"])("are all listed in %s, off", (file) => {
    for (const name of SWITCHES) expect(valueOf(file, name), `${file} ${name}`).toBe("false");
  });

  it("are all pinned off in the browser QA environment, so a stray value in the shell cannot change what a run looks at", () => {
    for (const name of SWITCHES) {
      expect((CRM_QA_ENV as Record<string, string>)[name], name).toBe("false");
      expect(({ [name]: "true", ...CRM_QA_ENV } as Record<string, string>)[name], name).toBe("false");
    }
  });
});
