import "server-only";
import http from "node:http";
import https from "node:https";
import { env } from "@/server/env";
import { safeLookup } from "@/server/onboarding/website";

// A real check that a publication is being served: request the site the way a visitor would and look for the
// publication's own marker. "Live" is never claimed without it.

export interface ProbeResult {
  state: "healthy" | "unhealthy" | "unchecked";
  detail: string;
}
export type ProbeFetcher = (target: { host: string; origin: string }) => Promise<{ status: number; body: string }>;

const defaultFetcher: ProbeFetcher = ({ host, origin }) =>
  new Promise((resolve, reject) => {
    const url = new URL("/", origin);
    const lib = url.protocol === "https:" ? https : http;
    // A customer controls where their domain points, so when we probe it over the public internet we refuse private addresses.
    // An operator-configured origin (SITES_PROBE_ORIGIN) is trusted and may be internal.
    const lookup = env().SITES_PROBE_ORIGIN ? undefined : (safeLookup as never);
    const req = lib.request(url, { method: "GET", headers: { Host: host, "User-Agent": "iAcquire-health-probe/1.0", Accept: "text/html" }, timeout: 8000, servername: host, lookup }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 1_500_000) req.destroy();
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

export function probeOrigin(host: string): string | null {
  const e = env();
  if (e.SITES_PROBE_ORIGIN) return e.SITES_PROBE_ORIGIN;
  // Without a configured origin, only probe where public DNS can be expected to point at the runtime.
  return e.NODE_ENV === "production" ? `https://${host}` : null;
}

export async function probeSite(host: string, publicationId: string, fetcher: ProbeFetcher = defaultFetcher): Promise<ProbeResult> {
  const origin = probeOrigin(host);
  if (!origin) return { state: "unchecked", detail: "A live check needs the website runtime to be reachable. It will be checked once the runtime is deployed." };
  try {
    const res = await fetcher({ host, origin });
    if (res.status !== 200) return { state: "unhealthy", detail: `The site answered with HTTP ${res.status}.` };
    if (!res.body.includes(`data-site-publication="${publicationId}"`)) return { state: "unhealthy", detail: "The site is responding, but not with this publication yet." };
    return { state: "healthy", detail: "Served and verified." };
  } catch {
    return { state: "unhealthy", detail: "The site could not be reached." };
  }
}
