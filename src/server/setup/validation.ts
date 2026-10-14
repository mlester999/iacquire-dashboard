import "server-only";
import { z } from "zod";

export const setupHttpsUrl = z.string().trim().url().max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && ![...url.searchParams.keys()].some((key) => /^(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|credential)$/i.test(key));
  } catch { return false; }
}, "Use an HTTPS link without credentials or secret query parameters.");

export const setupDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.").refine((value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a real calendar date.");
