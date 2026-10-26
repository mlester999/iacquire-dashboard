import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CRM_QA_ENV, SIM_PAYMONGO, assertIsolated } from "../scripts/crm-qa-env.mjs";
import { clearDevRestartNoise, exitCodeFor, isDevRestartInterruption, isLocalUrl, isRedirectTargetCurrent, parseNextRedirectMeta } from "../scripts/crm-browser-qa.mjs";

const roots: string[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-qa-isolation-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CRM browser QA stays isolated", () => {
  it("pins every variable named by the repo env files without reading or printing values", () => {
    expect(() => assertIsolated({ root: process.cwd(), env: CRM_QA_ENV })).not.toThrow();
    const root = tempRoot();
    fs.writeFileSync(path.join(root, ".env"), "UNPINNED_PROVIDER_KEY=do-not-print-this-value\n");
    let message = "";
    try {
      assertIsolated({ root, env: CRM_QA_ENV });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("UNPINNED_PROVIDER_KEY");
    expect(message).not.toContain("do-not-print-this-value");
  });

  it("refuses database or upload paths that escape its ignored data directory", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, ".env"), "");
    for (const key of ["PGLITE_DATA_DIR", "UPLOAD_DIR"] as const) {
      expect(() => assertIsolated({ root, files: [".env"], env: { ...CRM_QA_ENV, [key]: ".data/crm-qa/../../outside" } })).toThrow(key);
    }
  });

  it("refuses a real GoHighLevel host, a non-QA build directory, or enabled sends", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, ".env"), "");
    for (const unsafe of [
      { GHL_API_BASE: "https://services.leadconnectorhq.com" },
      { IAQ_DIST_DIR: ".next" },
      { GHL_WRITES_ENABLED: "true" },
      { RESEND_API_KEY: "not-a-real-key" },
    ]) {
      expect(() => assertIsolated({ root, files: [".env"], env: { ...CRM_QA_ENV, ...unsafe } })).toThrow();
    }
  });

  it("allows PayMongo only as the simulator on this machine, with its made-up keys", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, ".env"), "");
    const sim = { PAYMONGO_API_BASE: SIM_PAYMONGO.base, PAYMONGO_SECRET_KEY: SIM_PAYMONGO.key, PAYMONGO_WEBHOOK_SECRET: SIM_PAYMONGO.webhookSecret };
    expect(() => assertIsolated({ root, files: [".env"], env: { ...CRM_QA_ENV, ...sim } })).not.toThrow();
    // The default run has no PayMongo at all.
    expect(CRM_QA_ENV.PAYMONGO_API_BASE).toBe("");
    expect(CRM_QA_ENV.PAYMONGO_SECRET_KEY).toBe("");
    for (const unsafe of [
      { ...sim, PAYMONGO_SECRET_KEY: "sk_test_a_real_looking_key" },
      { ...sim, PAYMONGO_API_BASE: "https://api.paymongo.com" },
      { ...sim, PAYMONGO_API_BASE: "http://127.0.0.1:3282" },
      { ...sim, PAYMONGO_WEBHOOK_SECRET: "whsec_something_else" },
      { PAYMONGO_SECRET_KEY: SIM_PAYMONGO.key },
      { PAYMONGO_WEBHOOK_SECRET: SIM_PAYMONGO.webhookSecret },
    ]) {
      expect(() => assertIsolated({ root, files: [".env"], env: { ...CRM_QA_ENV, ...unsafe } }), JSON.stringify(Object.keys(unsafe))).toThrow();
    }
  });

  it("allows only the QA port for browser requests and sockets", () => {
    expect(isLocalUrl("http://localhost:3230/crm/contacts")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:3230/api/health")).toBe(true);
    expect(isLocalUrl("ws://[::1]:3230/_next/webpack-hmr")).toBe(true);
    expect(isLocalUrl("http://localhost:3100/crm/contacts")).toBe(false);
    expect(isLocalUrl("https://example.com/api")).toBe(false);
  });

  it("retries a confirmed Next dev-worker chunk interruption without hiding unrelated errors", () => {
    const bucket = {
      pageErrors: ["Loading chunk app/layout failed.", "Unhandled app error"],
      consoleErrors: ["Failed to load resource: net::ERR_CONNECTION_RESET", "Unhandled app warning"],
      failedRequests: [
        { url: "/_next/static/chunks/app/layout.js", error: "net::ERR_CONNECTION_RESET" },
        { url: "/api/crm", error: "net::ERR_CONNECTION_RESET" },
        { url: "/api/crm/real-error", error: "net::ERR_FAILED" },
      ],
      serverErrors: [{ url: "/api/failure", status: 500 }],
      aborted: 2,
    };
    expect(isDevRestartInterruption(bucket)).toBe(true);
    clearDevRestartNoise(bucket);
    expect(bucket.pageErrors).toEqual(["Unhandled app error"]);
    expect(bucket.consoleErrors).toEqual(["Unhandled app warning"]);
    expect(bucket.failedRequests).toEqual([
      { url: "/api/crm", error: "net::ERR_CONNECTION_RESET" },
      { url: "/api/crm/real-error", error: "net::ERR_FAILED" },
    ]);
    expect(bucket.serverErrors).toEqual([{ url: "/api/failure", status: 500 }]);
    expect(bucket.aborted).toBe(0);

    const navigationFailure = { failedRequests: [{ url: "/crm/calendar", error: "net::ERR_CONNECTION_REFUSED" }] };
    expect(isDevRestartInterruption(navigationFailure, "Expected redirect: net::ERR_CONNECTION_REFUSED")).toBe(true);
    clearDevRestartNoise(navigationFailure, { clearConnections: true });
    expect(navigationFailure.failedRequests).toEqual([]);
  });

  it("recognizes same-origin document, API, and asset connection resets even when navigation returned 200", () => {
    for (const url of ["/crm/contacts", "/api/aqi/health", "/_next/static/chunks/app/layout.js"]) {
      expect(isDevRestartInterruption({ failedRequests: [{ url, error: "net::ERR_CONNECTION_REFUSED" }] }), url).toBe(true);
    }
    expect(isDevRestartInterruption({ failedRequests: [{ url: "/api/crm", error: "net::ERR_FAILED" }] })).toBe(false);
  });

  it("parses same-origin streamed redirects emitted by the App Router", () => {
    const target = parseNextRedirectMeta("1;url=/overview?denied=1", "http://127.0.0.1:3230/crm/workflows");
    expect(target?.pathname).toBe("/overview");
    expect(target?.search).toBe("?denied=1");
    expect(parseNextRedirectMeta("not a redirect", "http://127.0.0.1:3230/crm/workflows")).toBeNull();
  });

  it("accepts a streamed redirect destination that the browser already reached", () => {
    const target = new URL("http://127.0.0.1:3230/overview?denied=1");
    expect(isRedirectTargetCurrent("http://127.0.0.1:3230/overview?denied=1", target)).toBe(true);
    expect(isRedirectTargetCurrent("http://127.0.0.1:3230/overview", target)).toBe(false);
    expect(isRedirectTargetCurrent("http://localhost:3230/overview?denied=1", target)).toBe(false);
  });
});

describe("CRM browser QA exit status", () => {
  it("fails for every recorded browser gate, even when no interaction failed", () => {
    const gates = ["httpErrors", "notRendered", "pageErrors", "consoleErrors", "failedRequests", "overflow", "axeViolations", "axeErrors", "screenshotFailures"];
    expect(exitCodeFor({}, null)).toBe(0);
    for (const key of gates) expect(exitCodeFor({ [key]: 1 }, null), key).toBe(4);
  });

  it("prioritizes unsafe requests, interrupted runs, then failed interactions", () => {
    expect(exitCodeFor({ external: 1, serverErrors: 0 }, null)).toBe(1);
    expect(exitCodeFor({}, "interrupted")).toBe(2);
    expect(exitCodeFor({ interactionsFailed: 1 }, null)).toBe(3);
  });
});
