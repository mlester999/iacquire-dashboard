// @vitest-environment jsdom
import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NotificationCenter } from "@/components/notifications/notification-center";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions/shell", () => ({ fetchNotificationsAction: vi.fn(), markNotificationsReadAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bell = (unread: number) =>
  render(<NotificationCenter initialUnread={unread} initialNow={Date.now()} timeZone="UTC" viewAllHref="/notifications" />);

describe("notification bell badge: label in name", () => {
  it("the accessible name contains the number the badge shows", () => {
    for (const [unread, shown] of [[1, "1"], [3, "3"], [9, "9"], [10, "9+"], [250, "9+"]] as const) {
      cleanup();
      bell(unread);
      const button = screen.getByRole("button", { name: new RegExp(`^Notifications, ${shown.replace("+", "\\+")} unread$`) });
      const badge = button.querySelector("span");
      expect(badge?.textContent, `${unread} unread`).toBe(shown);
      // WCAG 2.5.3: the visible text is part of the name.
      expect(button.getAttribute("aria-label")).toContain(badge?.textContent ?? "never");
    }
  });

  it("has a plain name and no badge when everything is read", () => {
    bell(0);
    const button = screen.getByRole("button", { name: "Notifications" });
    expect(button.querySelector("span")).toBeNull();
  });
});

describe("notification bell badge: colour contrast", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const light = css.slice(css.indexOf(":root {"), css.indexOf('[data-theme="dark"] {'));
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  const token = (block: string, name: string) => {
    const hit = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (!hit) throw new Error(`token --${name} not found`);
    return hit[1];
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("meets 4.5:1 for the 10px badge text in both themes, with the classes the component uses", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/notifications/notification-center.tsx"), "utf8");
    const badge = /className="(absolute right-1\.5 top-1\.5[^"]+)"/.exec(source)?.[1] ?? "";
    // Light theme: the badge uses --danger-ink with white text; dark theme: --danger with --danger-on text.
    expect(badge).toContain("bg-danger-ink");
    expect(badge).toContain("text-white");
    expect(badge).toContain("dark:bg-danger");
    expect(badge).toContain("dark:text-danger-on");
    expect(contrast("#ffffff", token(light, "danger-ink"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, "danger-on"), token(dark, "danger"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the entrance animation does not fade the text, so contrast cannot dip while it plays", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/notifications/notification-center.tsx"), "utf8");
    const badgeBlock = source.slice(source.indexOf("<motion.span"), source.indexOf("</motion.span>"));
    expect(badgeBlock).not.toMatch(/opacity/);
  });
});
