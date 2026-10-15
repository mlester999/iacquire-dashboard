import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Art } from "@/components/website/render/art";
import { ART_SCENES, ART_TONES } from "@/lib/website/art-keys";

// Built-in artwork is inlined into the page, so each scene's weight is part of every site that uses it. A scene made of hundreds of separate
// elements (windows, mostly) once cost 80 KB; they are now drawn as a few paths. This keeps them that way.
const BUDGET_KB = 30;

describe("built-in artwork", () => {
  it("keeps every scene within its weight budget, in every tone", () => {
    const heavy: string[] = [];
    for (const scene of ART_SCENES) {
      for (const tone of ART_TONES) {
        const html = renderToStaticMarkup(React.createElement(Art, { scene: scene.key, tone, seed: 3, posX: 50, posY: 50, className: "x" }));
        if (html.length > BUDGET_KB * 1024) heavy.push(`${scene.key}/${tone}: ${(html.length / 1024).toFixed(1)} KB`);
      }
    }
    expect(heavy, heavy.join(", ")).toEqual([]);
  });

  it("draws every scene as a labelled SVG that no script or external address can enter", () => {
    for (const scene of ART_SCENES) {
      const html = renderToStaticMarkup(React.createElement(Art, { scene: scene.key, tone: "auto", seed: 1, posX: 50, posY: 50, className: "x" }));
      expect(html, scene.key).toMatch(/^<svg\b/);
      expect(html, scene.key).toMatch(/role="img"/);
      expect(html, scene.key).not.toMatch(/<script|href=|xlink:href|<image\b|<foreignObject/i);
    }
  });

  it("draws the same scene the same way every time, so server and browser agree", () => {
    for (const scene of ART_SCENES) {
      const a = renderToStaticMarkup(React.createElement(Art, { scene: scene.key, tone: "warm", seed: 7, posX: 50, posY: 50, className: "x" }));
      const b = renderToStaticMarkup(React.createElement(Art, { scene: scene.key, tone: "warm", seed: 7, posX: 50, posY: 50, className: "x" }));
      expect(a, scene.key).toBe(b);
    }
  });
});
