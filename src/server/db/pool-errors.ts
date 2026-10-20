import "server-only";
import type { EventEmitter } from "node:events";
import { logSafeServerDiagnostic } from "@/server/diagnostics";

type Where = "idle" | "checked_out";

/**
 * Stops a dropped database connection from killing the serverless process.
 *
 * `pg` reports a connection that closes on its own (the pooler recycling it, a network reset, the pooler giving up on a checkout) as
 * an "error" event: on the pool for an idle connection, on the client for one that is checked out. An "error" event nobody listens
 * for is an uncaught exception, so Node ends the process. In production that showed as "Uncaught Exception: Error: Connection
 * terminated unexpectedly" followed by "Node.js process exited with exit status: 129" on every route, taking every in-flight request
 * of that instance down with it and sending the next cold start back to the same overloaded pooler.
 *
 * This only observes the event. A query that was running on a dropped connection still rejects through its own promise (so the
 * caller sees the failure and the transaction rolls back), and the pool discards the broken client. Only fixed error metadata is
 * logged; messages, SQL and connection strings never are.
 */
export function attachPoolErrorHandlers(pool: EventEmitter, report: (where: Where, error: unknown) => void = defaultReport): void {
  pool.on("error", (error: unknown) => report("idle", error));
  pool.on("connect", (client: EventEmitter) => {
    client.on("error", (error: unknown) => report("checked_out", error));
  });
}

function defaultReport(where: Where, error: unknown): void {
  logSafeServerDiagnostic(where === "idle" ? "database idle connection dropped" : "database connection dropped", error, `database.pool_${where}_error`);
}
