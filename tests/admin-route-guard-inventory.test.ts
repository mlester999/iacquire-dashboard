import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const adminPages = "src/app/(admin)/admin";
const adminRoutes = "src/app/api/admin";
const groupRoot = "src/app/(admin)";

function walk(relativeDir: string): string[] {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(relativeDir, entry.name);
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}

function stripComments(source: string): string {
  let out = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (char === "\n") {
        out += char;
        state = "code";
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        i += 1;
        state = "code";
      } else if (char === "\n") out += char;
      continue;
    }
    if (state !== "code") {
      out += char;
      if (char === "\\") {
        if (next !== undefined) out += source[++i];
      } else if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) {
        state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      i += 1;
      state = "line";
    } else if (char === "/" && next === "*") {
      i += 1;
      state = "block";
    } else {
      out += char;
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
    }
  }
  return out;
}

const GUARD_CALL = /\b(?:requireAgency|requireAgencyOrThrow|requireAgencyPermissionOrThrow|requireAgencyOrgPermissionOrThrow|requireAgencyOrgAccessOrThrow|assertProspectsAccess)\s*\(/;
// Every exception names the server-side service or parent boundary that enforces access.
const ALLOWLIST: Record<string, string> = {
  "src/app/(admin)/admin/clients/[id]/crm/[[...path]]/page.tsx": "agencyCrmPageActor checks agency role, assigned-client access and an active support session before rendering CRM data.",
  "src/app/(admin)/admin/provisioning-actions.ts": "Fresh-session checks precede setup job services that recheck agency and organization access; containment and fleet sync require Super Admin in the action and service.",
  "src/app/(admin)/admin/setup-templates/actions.ts": "Fresh-session checks precede updateTemplateTask and reorderTemplateTasks, which re-read the active Super Admin role in the database.",
};

const PERMISSION_GUARDED_PAGES: Record<string, string> = {
  "src/app/(admin)/admin/usage/page.tsx": "usage.view",
  "src/app/(admin)/admin/billing/page.tsx": "billing.agency_view",
  "src/app/(admin)/admin/support/settings/page.tsx": "agency.support.view",
};

const SERVICE_GUARDED_PAGES: Record<string, { serviceFile: string; pageCall: RegExp; serviceChecks: RegExp[]; reason: string }> = {
  "src/app/(admin)/admin/clients/[id]/page.tsx": {
    serviceFile: "src/server/admin/queries.ts",
    pageCall: /getTenantDetail\(user,\s*id\)/,
    serviceChecks: [/export async function getTenantDetail\(user: SessionUser, orgId: string\)/, /user\.platformRole === "none"/, /agencyCanAccessOrg\(user, orgId\)/],
    reason: "getTenantDetail rejects non-agency viewers and verifies live access to the requested organization before returning tenant details.",
  },
  "src/app/(admin)/admin/maintenance/page.tsx": {
    serviceFile: "src/server/maintenance/service.ts",
    pageCall: /listAgencyMaintenance\(user\)/,
    serviceChecks: [/export async function listAgencyMaintenance\(user: SessionUser\)/, /assertManage\(user\)/, /app\.user_can_access_org\(\$1,s\.org_id\)/, /app\.user_can_access_org\(\$1,m\.org_id\)/],
    reason: "listAgencyMaintenance enforces maintenance.manage and scopes subscriptions and requests to organizations the viewer can access.",
  },
};

const PAGE_PERMISSION_CHECKS: Record<string, RegExp> = {
  "src/app/(admin)/admin/health/page.tsx": /requireAgencyPermissionOrThrow\(\s*["']agency\.workforce\.view["']\s*\)/,
};

const FRESH_SUPER_ADMIN_ACTIONS = [
  "resendInvitationAction", "setTenantStatusAction", "setAgentEnabledAction", "connectHermesAction",
  "connectAgencyHermesProfileAction", "testAgencyHermesProfileAction", "getAgencyProfileHistoryAction",
  "reviewAgencyHermesToolsAction", "testAllAgencyProfilesAction", "setGhlMappingAction",
  "updateUsageLimitsAction", "updateBillingAction", "assignStaffAction", "inviteStaffAction",
  "updateAgencyTeamMemberAction", "setAgencyUserPermissionAction", "updateAgencyUserPermissionsAction",
  "copyAgencyUserPermissionsAction", "updateAccessRequestAction", "revokeInvitationAction",
];

function inventory(): string[] {
  const candidates = new Set<string>();
  for (const relative of walk(adminPages)) {
    if (relative.endsWith("/page.tsx") || relative.endsWith("/route.ts")) candidates.add(relative);
  }
  for (const relative of walk(adminRoutes)) if (relative.endsWith("/route.ts")) candidates.add(relative);
  for (const relative of walk(groupRoot)) {
    if (!/\.(?:ts|tsx)$/.test(relative)) continue;
    const source = stripComments(fs.readFileSync(path.join(root, relative), "utf8"));
    if (/["']use server["']\s*;?/.test(source)) candidates.add(relative);
  }
  return [...candidates].sort();
}

describe("admin route and action authorization inventory", () => {
  it("requires a server guard or a documented service-level exception for every admin entry point", () => {
    const files = inventory();
    expect(files.length, "the admin route inventory must not silently become empty").toBeGreaterThan(0);
    const missing: string[] = [];
    for (const relative of files) {
      const source = stripComments(fs.readFileSync(path.join(root, relative), "utf8"));
      if (GUARD_CALL.test(source)) continue;
      if (!ALLOWLIST[relative]?.trim()) missing.push(relative);
    }
    const stale = Object.keys(ALLOWLIST).filter((relative) => {
      if (!files.includes(relative)) return true;
      return GUARD_CALL.test(stripComments(fs.readFileSync(path.join(root, relative), "utf8")));
    });
    expect({ missing, stale }, "each admin page, route and server action needs a guard call or a current reason naming its guarding service").toEqual({ missing: [], stale: [] });
  });

  it("keeps broad agency entry pages behind their specific permission or tenant service guard", () => {
    const missingPermissions: string[] = [];
    const stalePermissions: string[] = [];
    for (const [relative, permission] of Object.entries(PERMISSION_GUARDED_PAGES)) {
      const source = stripComments(fs.readFileSync(path.join(root, relative), "utf8"));
      if (!new RegExp(`requireAgencyPermissionOrThrow\\s*\\(\\s*["']${permission.replaceAll(".", "\\.")}["']\\s*\\)`).test(source)) missingPermissions.push(relative);
    }
    for (const [relative, pattern] of Object.entries(PAGE_PERMISSION_CHECKS)) {
      const source = stripComments(fs.readFileSync(path.join(root, relative), "utf8"));
      if (!pattern.test(source)) missingPermissions.push(relative);
    }
    for (const relative of Object.keys(PERMISSION_GUARDED_PAGES)) {
      if (!inventory().includes(relative)) stalePermissions.push(relative);
    }

    const missingServiceGuards: string[] = [];
    const staleServiceGuards: string[] = [];
    for (const [relative, contract] of Object.entries(SERVICE_GUARDED_PAGES)) {
      if (!inventory().includes(relative)) {
        staleServiceGuards.push(relative);
        continue;
      }
      const pageSource = stripComments(fs.readFileSync(path.join(root, relative), "utf8"));
      const serviceSource = stripComments(fs.readFileSync(path.join(root, contract.serviceFile), "utf8"));
      if (!/\brequireAgency\s*\(\s*\)/.test(pageSource) || !contract.pageCall.test(pageSource) || !contract.serviceChecks.every((check) => check.test(serviceSource))) {
        missingServiceGuards.push(`${relative}: ${contract.reason}`);
      }
    }

    expect({ missingPermissions, stalePermissions, missingServiceGuards, staleServiceGuards }, "broad agency pages must retain their permission gate or verified tenant-scoped service").toEqual({
      missingPermissions: [], stalePermissions: [], missingServiceGuards: [], staleServiceGuards: [],
    });
  });

  it("requires a fresh Super Admin session for admin server actions", () => {
    const relative = "src/app/(admin)/admin/actions.ts";
    const source = stripComments(fs.readFileSync(path.join(root, relative), "utf8"));
    const helper = /async function requireFreshSuperAdmin\(\)\s*\{[^}]*requireFreshUserOrThrow\(\)[^}]*user\.platformRole !== "agency_super_admin"[^}]*\}/s;
    const missingActions = FRESH_SUPER_ADMIN_ACTIONS.filter((name) => {
      const start = source.indexOf(`export async function ${name}(`);
      if (start < 0) return true;
      const next = source.indexOf("\nexport async function ", start + 1);
      const body = source.slice(start, next < 0 ? source.length : next);
      return !/requireFreshSuperAdmin\(\)/.test(body);
    });
    expect({ helper: helper.test(source), missingActions }, "high-impact Super Admin actions must check a fresh authenticated user and the current Super Admin role").toEqual({ helper: true, missingActions: [] });
  });
});
