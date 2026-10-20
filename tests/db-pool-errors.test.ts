import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPoolErrorHandlers } from "@/server/db/pool-errors";

afterEach(() => vi.restoreAllMocks());

describe("a dropped database connection is reported, never uncaught", () => {
  it("without a listener, an error event on the pool throws (the production crash)", () => {
    expect(() => new EventEmitter().emit("error", new Error("Connection terminated unexpectedly"))).toThrow(/Connection terminated unexpectedly/);
  });

  it("reports idle and checked-out drops and does not throw", () => {
    const pool = new EventEmitter();
    const seen: Array<[string, string]> = [];
    attachPoolErrorHandlers(pool, (where, error) => seen.push([where, (error as Error).message]));
    expect(() => pool.emit("error", new Error("idle dropped"))).not.toThrow();
    const client = new EventEmitter();
    pool.emit("connect", client);
    expect(() => client.emit("error", new Error("mid-transaction dropped"))).not.toThrow();
    expect(seen).toEqual([["idle", "idle dropped"], ["checked_out", "mid-transaction dropped"]]);
  });

  it("logs only fixed metadata, not the message, SQL or connection string", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new EventEmitter();
    attachPoolErrorHandlers(pool);
    const error = Object.assign(new Error("postgresql://user:secret@host/db select * from users"), { code: "XX000" });
    pool.emit("error", error);
    expect(logged).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(logged.mock.calls[0]);
    expect(text).toContain("XX000");
    expect(text).not.toMatch(/secret|select \*|postgresql:\/\//);
  });

  it("a real pg pool survives a server that drops its connection, and the query rejects instead", async () => {
    // A TCP server that accepts a connection and destroys it before the PostgreSQL handshake completes.
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const { Pool } = await import("pg");
    const pool = new Pool({ host: "127.0.0.1", port, user: "u", database: "d", max: 1, connectionTimeoutMillis: 3000 });
    attachPoolErrorHandlers(pool, () => undefined);
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    await expect(pool.query("select 1")).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    process.off("uncaughtException", uncaught);
    expect(uncaught).not.toHaveBeenCalled();
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
