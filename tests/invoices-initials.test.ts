// The letters in the small tile that stands for a business on its customer pages (the invoice, the proposal, the review request, the booking page). They come from the words
// of the name that start with a letter or a digit: a tag such as "(QA)" or a symbol such as "&" is not a word to take a letter from.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { businessInitials } from "@/lib/business-initials";
import { Monogram as FormMonogram } from "@/app/f/_components/shell";
import { Monogram as BookingMonogram } from "@/app/book/_components/shell";

describe("the letters on a business's tile", () => {
  it.each([
    ["Harbor Home Services (QA)", "HS"],
    ["(QA) Harbor", "HA"],
    ["A & B Plumbing", "AP"],
    ["9 to 5 Co", "9C"],
    ["Ñandú Café", "ÑC"],
    ["Harbor Home Services", "HS"],
    ["Harbor-Home Services", "HS"],
    ["O'Brien & Sons", "OS"],
    ["  harbor   home  ", "HH"],
    ["Café Noir", "CN"],
    ["🌴 Palm Co", "PC"],
    ["#1 Plumbing", "PL"],
  ])("takes %j to %j", (name, initials) => {
    expect(businessInitials(name)).toBe(initials);
  });

  it("falls back to the first two letters when the name has one word to take a letter from, or none", () => {
    expect(businessInitials("Acme")).toBe("AC");
    expect(businessInitials("Zoë")).toBe("ZO");
    expect(businessInitials("O'Brien")).toBe("OB");
    expect(businessInitials("A")).toBe("A");
    expect(businessInitials("(QA)")).toBe("QA");
    expect(businessInitials("[9]")).toBe("9");
  });

  it("never shows a bracket, a symbol or nothing at all", () => {
    for (const name of ["", "   ", "&&&", "(  )", "---", "()", null, undefined]) expect(businessInitials(name), String(name)).toBe("?");
    for (const name of ["Harbor Home Services (QA)", "(QA) Harbor", "A & B Plumbing", "9 to 5 Co", "Ñandú Café", "Acme", "(QA)"]) expect(businessInitials(name), name).toMatch(/^[\p{L}\p{N}]{1,2}$/u);
  });

  it("is the same tile on the hosted form page as on the booking, invoice and proposal pages", () => {
    for (const name of ["Harbor Home Services (QA)", "(QA) Harbor", "A & B Plumbing", "Acme"]) {
      const form = renderToStaticMarkup(React.createElement(FormMonogram, { name, color: null }));
      expect(form, name).toBe(renderToStaticMarkup(React.createElement(BookingMonogram, { name, color: null })));
      expect(form, name).toContain(`>${businessInitials(name)}</span>`);
    }
  });
});
