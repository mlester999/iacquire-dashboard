
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProductPage, { metadata } from "@/app/product/page";
import { proxy } from "@/proxy";

describe("public iAcquireOS landing", () => {
  it("shows the single Partner, labelled sample workflow, approved pricing and functional next steps", () => {
    const markup = renderToStaticMarkup(<ProductPage />);

    expect(markup.replace(/<[^>]+>/g, "")).toContain("One AI Growth Partner for your entire acquisition operation.");
    expect(markup).toContain("Sample workspace");
    expect(markup).toContain("Awaiting your review");
    expect(markup).toContain("$1,499");
    expect(markup).toContain("$299");
    expect(markup).toContain("per month · optional");
    expect(markup).toContain("Frequently asked questions");
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('href="/demo"');
    expect(markup).not.toMatch(/six (?:AI )?(?:employees|agents|assistants)/i);
    expect(metadata.openGraph?.description).toContain("One AI Growth Partner");
  });

  it("keeps the public exception scoped to the product page", async () => {
    const product = await proxy(new NextRequest("http://localhost/product"));
    expect(product.status).toBe(200);
    expect(product.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    for (const path of ["/", "/productivity", "/product/private", "/overview"]) {
      const guarded = await proxy(new NextRequest("http://localhost" + path));
      expect(guarded.status, path).toBe(307);
      expect(guarded.headers.get("location"), path).toContain("/login");
    }
  });
});
