import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

// The guard in tests/support/no-network.ts (a vitest setup file) refuses every connection to another machine, so a provider test that forgets to replace the HTTP
// layer cannot send a real request. These tests provoke it on purpose and then clear the record it keeps, because the same guard would otherwise fail them.

const blocked = () => (globalThis as { __noNetworkBlocked?: string[] }).__noNetworkBlocked!;

describe("tests cannot reach the network", () => {
  it("refuses fetch to a real host and says which one", async () => {
    await expect(fetch("https://api.paymongo.com/v1/checkout_sessions", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(blocked().some((w) => w.startsWith("api.paymongo.com:"))).toBe(true);
    blocked().length = 0;
  });

  it("refuses https.request, whatever the path that reaches the socket", async () => {
    const failed = await new Promise<boolean>((resolve) => {
      try {
        const req = https.request({ host: "example.com", port: 443, path: "/", method: "GET" }, () => resolve(false));
        req.on("error", () => resolve(true));
        req.end();
      } catch {
        resolve(true);
      }
    });
    expect(failed).toBe(true);
    expect(blocked().some((w) => w.startsWith("example.com:"))).toBe(true);
    blocked().length = 0;
  });

  it("refuses an address that is not loopback, even as a bare IP", async () => {
    await expect(fetch("http://203.0.113.7:80/")).rejects.toThrow();
    expect(blocked()).toContain("203.0.113.7:80");
    blocked().length = 0;
  });

  // The pinned transport connects to a name through a lookup of its own, so what the lookup answers is where the socket goes.
  const lookupAnswering = (address: string) => (_host: string, options: { all?: boolean }, cb: (...r: unknown[]) => void) =>
    options?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4);

  it("allows a name whose own lookup answers with an address on this machine", async () => {
    const server = http.createServer((_req, res) => res.end("pinned"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: "pinned.test.example", port, path: "/", lookup: lookupAnswering("127.0.0.1") as never }, (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve(text));
        });
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("pinned");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(blocked()).toEqual([]);
  });

  it("refuses a name whose own lookup answers with another machine, and records where it would have gone", async () => {
    const failed = await new Promise<boolean>((resolve) => {
      const req = http.request({ host: "pinned.test.example", port: 80, path: "/", lookup: lookupAnswering("203.0.113.9") as never }, () => resolve(false));
      req.on("error", () => resolve(true));
      req.end();
    });
    expect(failed).toBe(true);
    expect(blocked().some((w) => w.startsWith("pinned.test.example:80 -> 203.0.113.9"))).toBe(true);
    blocked().length = 0;
  });

  it("still allows a server on this machine", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("ok");
      const viaName = await fetch(`http://localhost:${port}/`).then((r) => r.text()).catch(() => "ipv6-only");
      expect(["ok", "ipv6-only"]).toContain(viaName);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(blocked()).toEqual([]);
  });
});
