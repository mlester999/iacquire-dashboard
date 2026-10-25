// The page a sign-in sends someone to is a path on this site or the home page, never another site.
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-next";

const BS = String.fromCharCode(92); // a backslash, built so no tool in between can halve it

describe("safeNextPath", () => {
  it("keeps a path on this site, with its query", () => {
    expect(safeNextPath("/overview")).toBe("/overview");
    expect(safeNextPath("/crm/contacts?tag=vip&page=2")).toBe("/crm/contacts?tag=vip&page=2");
    expect(safeNextPath("/invoices/INV-0010%20a")).toBe("/invoices/INV-0010%20a");
    expect(safeNextPath("/crm/contacts?q=a+b&at=x:y,z#top")).toBe("/crm/contacts?q=a+b&at=x:y,z#top");
  });

  it("falls back to the home page for anything that could leave the site", () => {
    const attacks = [
      "//evil.com", "///evil.com", `/${BS}evil.com`, `/${BS}${BS}evil.com`, `${BS}${BS}evil.com`, `${BS}/evil.com`, `/a/${BS}evil.com`,
      "https://evil.com", "http://evil.com/a", "javascript:alert(1)", "data:text/html,x", "evil.com", "/ /evil.com", "/\t/evil.com", "/\n/evil.com", "/a b",
      "/a\r\nSet-Cookie: x=y", "//​evil.com", "/‮evil.com", "",
    ];
    for (const a of attacks) expect(safeNextPath(a), JSON.stringify(a)).toBe("/");
  });

  it("falls back for values that are not strings or are absurdly long", () => {
    for (const v of [undefined, null, 5, {}, ["/ok"]]) expect(safeNextPath(v)).toBe("/");
    expect(safeNextPath("/" + "a".repeat(700))).toBe("/");
  });

  it("uses the fallback it is given", () => {
    expect(safeNextPath("//evil.com", "/overview")).toBe("/overview");
  });
});
