import { describe, expect, it } from "vitest";
import { employeeKnowledgeContext } from "@/server/workforce/knowledge";
import type { QueryResult, Queryable } from "@/server/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ENTRY = "note-1";
const DOCUMENT = "doc-1";

/**
 * The handle passed to employeeKnowledgeContext is always a transaction on one pooled connection.
 * node-postgres queues statements on a single client, so overlapping calls gained no parallelism;
 * they triggered pg's "client.query() when the client is already executing a query" deprecation,
 * which is the warning production logged from this module, and pg 9 removes that queueing.
 */
function recordingDb(rowsFor: (sql: string) => unknown[]) {
  let inFlight = 0;
  let maxInFlight = 0;
  const statements: string[] = [];
  const db: Queryable = {
    async query<T>(sql: string): Promise<QueryResult<T>> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      statements.push(sql);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const rows = rowsFor(sql) as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, statements, peak: () => maxInFlight };
}

describe("employee knowledge context reads one connection at a time", () => {
  it("issues its three reads in order instead of overlapping them on the pooled client", async () => {
    const { db, statements, peak } = recordingDb((sql) => {
      if (sql.includes("from company_knowledge")) return [{ section: "brand", content: "Always answer politely." }];
      if (sql.includes("from employee_knowledge_entries")) return [{ id: ENTRY, title: "Tone", content: "Keep answers short." }];
      return [{ id: DOCUMENT, filename: "brief.pdf", excerpt: "Reference text." }];
    });

    const context = await employeeKnowledgeContext(db, ORG, AGENT);

    expect(peak()).toBe(1);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("company_knowledge");
    expect(statements[1]).toContain("employee_knowledge_entries");
    expect(statements[2]).toContain("knowledge_documents");
    expect(context.entryIds).toEqual([ENTRY]);
    expect(context.documentIds).toEqual([DOCUMENT]);
    expect(context.truncated).toBe(false);
    expect(context.block).toContain("Always answer politely.");
    expect(context.block).toContain("Tone");
    expect(context.block).toContain("brief.pdf");
  });

  it("keeps the tenant scoping of every read exactly as before", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const db: Queryable = {
      async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        seen.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 0 };
      },
    };

    await employeeKnowledgeContext(db, ORG, AGENT);

    expect(seen).toHaveLength(3);
    // Every statement is filtered by the organization, and the employee-scoped ones by the employee.
    for (const { sql, params } of seen) expect([sql, params[0]]).toEqual([expect.stringContaining("org_id = $1"), ORG]);
    expect(seen[1].params[1]).toBe(AGENT);
    expect(seen[2].params[1]).toBe(AGENT);
    // The shared library stays visible to the employee; notes never are.
    expect(seen[2].sql).toContain("agent_instance_id is null or agent_instance_id = $2");
    expect(seen[1].sql).toContain("agent_instance_id = $2");
  });
});
