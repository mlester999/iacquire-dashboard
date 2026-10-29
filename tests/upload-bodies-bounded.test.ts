import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A `Content-Length` header is a claim, not a limit: a request that uses chunked transfer, or that lies, is read into memory in full by `req.formData()` / `req.text()`
// before any size check runs. For a route with no session in front of it that is an anonymous way to make the process hold an arbitrary body; for a signed-in route it is
// still a way to exhaust the server. Every route that accepts a FILE or a free-text body therefore reads it through src/server/security/bounded-body.ts, which
// abandons the stream at the ceiling. This test walks the route tree the way the platform sees it, so a new upload route cannot quietly be added without the reader.
//
// JSON endpoints that authenticate first and parse a small typed body with `req.json()` are listed in KNOWN_JSON_PARSES below rather than converted: the record is honest
// about them, and it fails if one is added or removed, so the set cannot grow without this line being reconsidered.

const ROOT = path.resolve(import.meta.dirname, "..");
const API = path.join(ROOT, "src", "app", "api");
const BOUNDED = /readBounded(?:FormData|Text|Bytes|Json)\(/;
const FILE_OR_TEXT_PARSE = /(?:req|request)\.(?:formData|text|arrayBuffer)\(\)/;
const JSON_PARSE = /(?:req|request)\.json\(\)/;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (/^route\.(?:ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/");
const files = routeFiles(API);
const text = (file: string) => readFileSync(file, "utf8");

const fileReaders = files.filter((file) => FILE_OR_TEXT_PARSE.test(text(file)) || BOUNDED.test(text(file)));
const jsonReaders = files.filter((file) => JSON_PARSE.test(text(file))).map(relative).sort();

/** JSON bodies that are parsed after authentication. Kept as a list so a new one is a visible decision, not a silent default. */
const KNOWN_JSON_PARSES = [
  "src/app/api/admin/integrations/route.ts",
  "src/app/api/aqi/chat/route.ts",
  "src/app/api/aqi/conversations/[id]/route.ts",
  "src/app/api/aqi/conversations/route.ts",
  "src/app/api/aqi/feedback/route.ts",
  "src/app/api/aqi/guidance/route.ts",
  "src/app/api/aqi/onboarding/route.ts",
  "src/app/api/aqi/ops/actions/[id]/route.ts",
  "src/app/api/aqi/ops/briefings/route.ts",
  "src/app/api/aqi/ops/conversations/[id]/route.ts",
  "src/app/api/aqi/ops/refresh/route.ts",
  "src/app/api/aqi/ops/scope/route.ts",
  "src/app/api/aqi/support/draft/route.ts",
  "src/app/api/aqi/support/route.ts",
  "src/app/api/aqi/tips/route.ts",
  "src/app/api/aqi/tutorials/[slug]/route.ts",
  "src/app/api/aqi/tutorials/route.ts",
  "src/app/api/automation-studio/[id]/chat/route.ts",
  "src/app/api/chat/send/route.ts",
  "src/app/api/help/route.ts",
  "src/app/api/inbox/conversations/[id]/assist/route.ts",
  "src/app/api/work/jobs/[id]/route.ts",
  "src/app/api/workforce/preview/route.ts",
];

describe("every API route reads a file or free-text body with a ceiling", () => {
  it("has routes to check, including the upload routes the rule exists for", () => {
    expect(fileReaders.length).toBeGreaterThanOrEqual(10);
    const names = fileReaders.map(relative);
    for (const expected of [
      "src/app/api/assets/upload/route.ts",
      "src/app/api/social/media/route.ts",
      "src/app/api/aqi/attachments/route.ts",
      "src/app/api/knowledge/upload/route.ts",
      "src/app/api/support/uploads/route.ts",
      "src/app/api/onboarding/suggest/route.ts",
    ]) expect(names, expected).toContain(expected);
  });

  it("uses the bounded reader, never a raw multipart or text parse", () => {
    expect(fileReaders.filter((file) => !BOUNDED.test(text(file))).map(relative)).toEqual([]);
  });

  it("settles who is asking before it touches an upload body", () => {
    // The workspace of an asset upload comes from the form, so this is the one place where authentication could otherwise be made to follow the body.
    const upload = text(path.join(API, "assets", "upload", "route.ts"));
    const auth = upload.indexOf("requireUserOrThrow()");
    const parse = upload.indexOf("readBoundedFormData(");
    expect(auth).toBeGreaterThan(0);
    expect(parse).toBeGreaterThan(0);
    expect(auth).toBeLessThan(parse);
  });

  it("keeps the list of authenticated JSON bodies from growing unnoticed", () => {
    expect(jsonReaders).toEqual(KNOWN_JSON_PARSES);
  });

  it("keeps the restricted inference routes on the bounded reader, with no raw JSON parse", () => {
    // They take a role name and an id: a ceiling of a kilobyte, enforced while the body arrives.
    for (const name of ["canary", "chat"]) {
      const route = text(path.join(API, "internal", "hermes-inference", name, "route.ts"));
      expect(route, name).toMatch(/readBoundedJson\(req, MAX_BODY_BYTES\)/);
      expect(route, name).not.toMatch(JSON_PARSE);
    }
    expect(jsonReaders.filter((file) => file.includes("hermes-inference"))).toEqual([]);
  });

  it("would catch the mistake it exists for", () => {
    expect(FILE_OR_TEXT_PARSE.test("const form = await req.formData();")).toBe(true);
    expect(FILE_OR_TEXT_PARSE.test("const raw = await request.text();")).toBe(true);
    expect(BOUNDED.test("const form = await readBoundedFormData(req, 1024);")).toBe(true);
    expect(BOUNDED.test("const form = await req.formData();")).toBe(false);
  });
});
