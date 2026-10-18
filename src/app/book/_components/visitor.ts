import "server-only";
import { headers } from "next/headers";

/** The visitor's address as the trusted reverse proxy reports it (first X-Forwarded-For entry), for rate limiting only. */
export async function visitorIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/**
 * The server's clock for this request, passed to the time picker so it counts today from the same instant on the server and in the
 * browser's first render (the device's clock can disagree, and a page rendered just before midnight would otherwise mismatch).
 */
export function requestTime(): number {
  return Date.now();
}
