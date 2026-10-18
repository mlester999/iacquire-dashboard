// The public website runtime's trust boundary for booking (docs/website-studio.md, "Trust boundary and security"). Everything a customer's
// site does runs as iaq_site_runtime, except booking, whose trusted database access lives in ONE module, src/server/sites/booking-trusted.ts,
// which only accepts a LiveSite that resolveSite returned. These checks fail the build if trusted access spreads anywhere else in the
// runtime, or if the trusted module would take a site object it didn't get from the resolver.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { bookOnSite, siteAppointmentById, siteAppointmentByToken, siteWorkspaceBooking, withSitePublicType } from "@/server/sites/booking-trusted";
import { isVerifiedSite, type LiveSite } from "@/server/sites/runtime";

const ROOTS = ["src/app/site-runtime", "src/server/sites"];
const TRUSTED = "src/server/sites/booking-trusted.ts";
/** Trusted database access: a transaction as the table owner, as a signed-in user, or a CRM write transaction. */
const FORBIDDEN_NAMES = new Set(["withSystem", "withUser", "crmWrite"]);
/**
 * Modules whose exported services open trusted transactions themselves (findByManageToken, bookNativeAppointment, the scheduling and
 * calendar services, the portal's website services). Type-only imports from them are fine.
 */
const FORBIDDEN_MODULES = [/^@\/server\/calendars\//, /^@\/server\/websites\//, /^@\/server\/crm\/actor$/, /^@\/app\/actions\//];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

interface ValueImport {
  module: string;
  /** Imported binding names; "*" for a namespace import or a re-export of everything. */
  names: string[];
}

/** Every value (non type-only) import, re-export, dynamic import() and require() in a file. */
function valueImports(file: string): ValueImport[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ValueImport[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const from = node.moduleSpecifier.text;
      if (!clause) out.push({ module: from, names: [] }); // side-effect import
      else if (!clause.isTypeOnly) {
        const names: string[] = [];
        if (clause.name) names.push("default");
        const b = clause.namedBindings;
        if (b && ts.isNamespaceImport(b)) names.push("*");
        if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
        if (names.length) out.push({ module: from, names });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      const names = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : ["*"];
      if (names.length) out.push({ module: node.moduleSpecifier.text, names });
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (dynamic) out.push({ module: node.arguments[0].text, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

/** Why an import breaks the boundary, or null. */
function violation(i: ValueImport): string | null {
  const bad = i.names.filter((n) => FORBIDDEN_NAMES.has(n));
  if (bad.length) return `imports ${bad.join(", ")} from ${i.module}`;
  if (i.module === "@/server/db" && i.names.some((n) => n !== "withSiteRuntime")) return `imports ${i.names.join(", ")} from @/server/db (only withSiteRuntime is allowed)`;
  if (FORBIDDEN_MODULES.some((re) => re.test(i.module))) return `imports ${i.names.join(", ") || "(side effects)"} from ${i.module}`;
  return null;
}

describe("the website runtime's booking trust boundary", () => {
  const files = ROOTS.flatMap(filesUnder);

  it("finds the runtime's files and the one trusted module", () => {
    expect(files).toContain(TRUSTED);
    expect(files).toContain("src/server/sites/booking.ts");
    expect(files.some((f) => f.startsWith("src/app/site-runtime/") && f.includes("/book/"))).toBe(true);
  });

  it("no file under src/app/site-runtime or src/server/sites except booking-trusted.ts imports trusted database access", () => {
    const problems: string[] = [];
    for (const file of files) {
      if (file === TRUSTED) continue;
      for (const i of valueImports(file)) {
        const why = violation(i);
        if (why) problems.push(`${file} ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the rule really catches a forbidden import (so the check above can't pass vacuously)", () => {
    expect(violation({ module: "@/server/db", names: ["withSystem"] })).toMatch(/withSystem/);
    expect(violation({ module: "@/server/db", names: ["*"] })).toMatch(/only withSiteRuntime/);
    expect(violation({ module: "@/server/crm/actor", names: ["crmWrite"] })).toMatch(/crmWrite/);
    expect(violation({ module: "@/server/calendars/booking", names: ["findByManageToken"] })).toMatch(/calendars\/booking/);
    expect(violation({ module: "@/server/db", names: ["withSiteRuntime"] })).toBeNull();
    const trusted = valueImports(TRUSTED);
    expect(trusted.some((i) => i.module === "@/server/db" && i.names.includes("withSystem"))).toBe(true);
    expect(trusted.some((i) => i.module === "@/server/sites/runtime" && i.names.includes("isVerifiedSite"))).toBe(true);
  });

  it("the trusted module refuses a site that resolveSite didn't return, before touching the database", async () => {
    const forged = {
      websiteId: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", publicationId: "00000000-0000-4000-8000-000000000003",
      templateKey: "corp.summit", content: {}, contentHash: "x", hostKind: "platform", publishedAt: new Date(0).toISOString(), canonicalHost: "forged.example",
    } as unknown as LiveSite;
    expect(isVerifiedSite(forged)).toBe(false);
    expect(isVerifiedSite(Object.freeze({ ...forged }))).toBe(false);
    const refused = /verified host/;
    await expect(siteWorkspaceBooking(forged)).rejects.toThrow(refused);
    await expect(withSitePublicType(forged, "00000000-0000-4000-8000-000000000004", async () => 1)).rejects.toThrow(refused);
    await expect(siteAppointmentByToken(forged, "a".repeat(32))).rejects.toThrow(refused);
    await expect(siteAppointmentById(forged, "00000000-0000-4000-8000-000000000005")).rejects.toThrow(refused);
    await expect(bookOnSite(forged, { typeId: "00000000-0000-4000-8000-000000000004", startAt: new Date(), contact: { firstName: "X", email: "x@example.test" } })).rejects.toThrow(refused);
  });
});
