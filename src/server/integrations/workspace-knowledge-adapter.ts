import "server-only";
import { z } from "zod";
import type {
  AirtableKnowledgeTable, NotionKnowledgeChoice, WorkspaceKnowledgeChoice, WorkspaceKnowledgeSelection,
} from "@/lib/integrations/workspace-knowledge";
import { AppError } from "@/server/errors";
import { sanitizeClientText } from "@/server/workforce/compiler";
import {
  AIRTABLE_API, NOTION_API, NOTION_VERSION, WorkspaceOAuthError, workspaceProviderRequest, type OAuthConfig,
} from "./workspace-oauth-adapter";

const MAX_ROWS = 100;
const MAX_PAGES = 4;
const MAX_CONTENT = 12_000;
const OBJECT = z.record(z.string(), z.unknown());
const NOTION_ID = z.string().uuid();
const BASE_ID = z.string().regex(/^app[A-Za-z0-9]{14}$/);
const TABLE_ID = z.string().regex(/^tbl[A-Za-z0-9]{14}$/);
const FIELD_ID = z.string().regex(/^fld[A-Za-z0-9]{14}$/);
const RECORD_ID = z.string().regex(/^rec[A-Za-z0-9]{14}$/);
const CURSOR = z.string().min(1).max(2048);
const readTime = z.iso.datetime({ offset: true });

const notionSelection = z.object({ kind: z.enum(["page", "data_source"]), id: NOTION_ID }).strict();
const airtableSelection = z.object({
  kind: z.literal("table"), baseId: BASE_ID, tableId: TABLE_ID,
  fieldIds: z.array(FIELD_ID).min(1).max(8).transform((ids) => [...new Set(ids)].sort()),
}).strict();
const notionItem = z.object({
  object: z.enum(["page", "data_source"]), id: NOTION_ID,
  title: z.unknown().optional(), properties: OBJECT.optional(), in_trash: z.boolean().optional(), is_archived: z.boolean().optional(),
  last_edited_time: readTime.optional(),
});
const notionList = z.object({
  results: z.array(notionItem).max(100),
  has_more: z.boolean(), next_cursor: CURSOR.nullable(),
  request_status: z.object({ type: z.string() }).optional(),
});
const notionMarkdown = z.object({
  object: z.literal("page_markdown"), id: NOTION_ID, markdown: z.string(), truncated: z.boolean(), unknown_block_ids: z.array(NOTION_ID),
});
const airtableBase = z.object({ id: BASE_ID, name: z.string(), permissionLevel: z.string() });
const airtableBaseList = z.object({ bases: z.array(airtableBase).max(1000), offset: CURSOR.optional() });
const airtableTable = z.object({
  id: TABLE_ID, name: z.string(),
  fields: z.array(z.object({ id: FIELD_ID, name: z.string(), type: z.string() })).max(1000),
});
const airtableSchema = z.object({ tables: z.array(airtableTable).max(1000) });
const airtableRecords = z.object({ records: z.array(z.object({ id: RECORD_ID, fields: OBJECT })).max(100), offset: CURSOR.optional() });

type NotionItem = z.infer<typeof notionItem>;
type AirtableTable = z.infer<typeof airtableTable>;
type KnowledgeProvenance = {
  kind: WorkspaceKnowledgeSelection["kind"];
  records: string[];
  providerRevision?: string;
};
export type WorkspaceKnowledgeSnapshot = { title: string; content: string; provenance: KnowledgeProvenance };

const AIRTABLE_TEXT_FIELDS = new Set([
  "singleLineText", "multilineText", "richText", "number", "percent", "currency", "checkbox",
  "singleSelect", "multipleSelects", "date", "dateTime", "duration", "rating", "autoNumber",
]);
const AIRTABLE_BASE_READ = new Set(["read", "comment", "edit", "create"]);

export function parseWorkspaceSelection(provider: OAuthConfig["provider"], input: unknown): WorkspaceKnowledgeSelection {
  return provider === "notion" ? notionSelection.parse(input) : airtableSelection.parse(input);
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkspaceOAuthError("invalid_response");
  return result.data;
}

function asObject(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function notionText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => {
    const text = asObject(item)?.plain_text;
    return typeof text === "string" ? text : "";
  }).join("") : "";
}

function safeTitle(value: string, fallback: string, length = 160) {
  return sanitizeClientText(value, length).replace(/\s+/g, " ") || fallback;
}

function notionTitle(item: NotionItem) {
  const title = notionText(item.title) || Object.values(item.properties ?? {}).map(asObject)
    .filter((value) => value?.type === "title").map((value) => notionText(value?.title)).join(" ");
  return safeTitle(title, item.object === "page" ? "Untitled page" : "Untitled data source");
}

function buildWorkspaceSnapshot(title: string, content: string, provenance: KnowledgeProvenance): WorkspaceKnowledgeSnapshot {
  const cleaned = sanitizeClientText(content, MAX_CONTENT + 1);
  if (cleaned.length > MAX_CONTENT) throw new AppError("usage_limit", "Choose a smaller source or fewer fields. Each import can contain up to 12,000 characters.");
  return { title, content: cleaned, provenance };
}

function requestNotion(cfg: OAuthConfig, token: string, path: string, body?: Record<string, unknown>) {
  return workspaceProviderRequest(cfg, NOTION_API, path, {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: "Bearer " + token, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    maxBytes: 768_000,
  });
}
function requestAirtable(cfg: OAuthConfig, token: string, path: string, query?: URLSearchParams) {
  return workspaceProviderRequest(cfg, AIRTABLE_API, path + (query ? "?" + query.toString() : ""), {
    headers: { Authorization: "Bearer " + token }, maxBytes: 768_000,
  });
}

export async function discoverNotionKnowledge(cfg: OAuthConfig, token: string, query: string, cursor?: string) {
  const page = parsed(notionList, await requestNotion(cfg, token, "/v1/search", {
    page_size: 25, ...(query ? { query } : {}), ...(cursor ? { start_cursor: cursor } : {}),
  }));
  if (page.has_more && !page.next_cursor) throw new WorkspaceOAuthError("invalid_response");
  const choices: NotionKnowledgeChoice[] = page.results.filter((item) => !item.in_trash && !item.is_archived)
    .map((item) => ({ id: item.id, title: notionTitle(item), kind: item.object }));
  return { choices, cursor: page.has_more ? page.next_cursor : null };
}

export async function discoverAirtableBases(cfg: OAuthConfig, token: string, cursor?: string) {
  const page = parsed(airtableBaseList, await requestAirtable(cfg, token, "/v0/meta/bases", cursor ? new URLSearchParams({ offset: cursor }) : undefined));
  const choices: WorkspaceKnowledgeChoice[] = page.bases.filter((base) => AIRTABLE_BASE_READ.has(base.permissionLevel))
    .map((base) => ({ id: base.id, title: safeTitle(base.name, "Untitled base") }));
  return { choices, cursor: page.offset ?? null };
}

async function readAirtableTables(cfg: OAuthConfig, token: string, baseId: string) {
  return parsed(airtableSchema, await requestAirtable(cfg, token, "/v0/meta/bases/" + BASE_ID.parse(baseId) + "/tables")).tables;
}

export async function discoverAirtableTables(cfg: OAuthConfig, token: string, baseId: string): Promise<AirtableKnowledgeTable[]> {
  return (await readAirtableTables(cfg, token, baseId)).map((table) => ({
    id: table.id, title: safeTitle(table.name, "Untitled table"),
    fields: table.fields.filter((field) => AIRTABLE_TEXT_FIELDS.has(field.type))
      .map((field) => ({ id: field.id, title: safeTitle(field.name, field.id) })),
  }));
}

async function readNotionPage(cfg: OAuthConfig, token: string, id: string) {
  const item = parsed(notionItem, await requestNotion(cfg, token, "/v1/pages/" + id));
  if (item.id !== id || item.object !== "page") throw new WorkspaceOAuthError("invalid_response");
  if (item.in_trash || item.is_archived) throw new WorkspaceOAuthError("missing");
  const title = notionTitle(item);
  const markdown = parsed(notionMarkdown, await requestNotion(cfg, token, "/v1/pages/" + id + "/markdown?markdown_version=v2"));
  if (markdown.id !== id) throw new WorkspaceOAuthError("invalid_response");
  if (markdown.truncated || markdown.unknown_block_ids.length) {
    throw new AppError("usage_limit", "Notion did not share the entire page. Choose a smaller page or check access to its content.");
  }
  // Preserve selected page text without following embedded or linked resources.
  const text = markdown.markdown
    .replace(/<unknown[^>]*\/>/gi, "")
    .replace(/<image\b[\s\S]*?<\/image>|<file\b[\s\S]*?<\/file>|<video\b[\s\S]*?<\/video>|<audio\b[\s\S]*?<\/audio>/gi, "")
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, "$1");
  return buildWorkspaceSnapshot(title, text, {
    kind: "page", records: [id], ...(item.last_edited_time ? { providerRevision: item.last_edited_time } : {}),
  });
}

function notionRow(item: NotionItem) {
  const parts = Object.entries(item.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, value]) => {
    const prop = asObject(value);
    const type = prop?.type;
    if (type !== "rich_text" && type !== "title") return [];
    const text = notionText(prop?.[type]);
    return text ? [safeTitle(name, type) + ": " + text] : [];
  });
  return parts.join("\n");
}

async function readNotionDataSource(cfg: OAuthConfig, token: string, id: string) {
  const source = parsed(notionItem, await requestNotion(cfg, token, "/v1/data_sources/" + id));
  if (source.id !== id || source.object !== "data_source") throw new WorkspaceOAuthError("invalid_response");
  if (source.in_trash || source.is_archived) throw new WorkspaceOAuthError("missing");
  const rows = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: z.infer<typeof notionList> = parsed(notionList, await requestNotion(cfg, token, "/v1/data_sources/" + id + "/query", {
      result_type: "page", page_size: 25, ...(cursor ? { start_cursor: cursor } : {}),
    }));
    if (data.request_status && data.request_status.type !== "complete") throw new AppError("usage_limit", "Notion could not return a complete set. Choose a smaller data source.");
    for (const item of data.results) {
      if (item.object !== "page") throw new WorkspaceOAuthError("invalid_response");
      if (!item.in_trash && !item.is_archived) rows.set(item.id, notionRow(item));
    }
    if (!data.has_more) return rowsSnapshot(notionTitle(source), "data_source", rows);
    if (!data.next_cursor || data.next_cursor === cursor) throw new WorkspaceOAuthError("invalid_response");
    cursor = data.next_cursor;
  }
  throw tooManyRows();
}

function airtableCell(field: AirtableTable["fields"][number], value: unknown): string {
  if (value === undefined) return field.type === "checkbox" ? "No" : "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean" && field.type === "checkbox") return value ? "Yes" : "No";
  if (field.type === "multipleSelects" && Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(", ");
  throw new AppError("conflict", "A mapped field returned an unsupported value. Check your Airtable field types and select the table again.");
}

function tooManyRows() {
  return new AppError("usage_limit", "Choose a source with up to " + MAX_ROWS + " rows for each import.");
}

function rowsSnapshot(title: string, kind: "data_source" | "table", rows: ReadonlyMap<string, string>) {
  if (rows.size > MAX_ROWS) throw tooManyRows();
  const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b)).filter(([, text]) => text !== "");
  return buildWorkspaceSnapshot(title, sorted.map(([id, text]) => "[" + id + "]\n" + text).join("\n\n"), {
    kind, records: sorted.map(([id]) => id),
  });
}

async function readAirtableKnowledge(cfg: OAuthConfig, token: string, source: z.infer<typeof airtableSelection>) {
  const table = (await readAirtableTables(cfg, token, source.baseId)).find((candidate) => candidate.id === source.tableId);
  if (!table) throw new WorkspaceOAuthError("missing");
  const fields = source.fieldIds.map((id) => table.fields.find((field) => field.id === id && AIRTABLE_TEXT_FIELDS.has(field.type)));
  if (!fields.every((field) => field !== undefined)) {
    throw new AppError("conflict", "A mapped Airtable field was removed or changed to an unsupported type. Select the table and fields again.");
  }
  const rows = new Map<string, string>();
  const params = new URLSearchParams({ pageSize: "40", returnFieldsByFieldId: "true" });
  for (const field of fields) params.append("fields[]", field.id);
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = parsed(airtableRecords, await requestAirtable(cfg, token, "/v0/" + source.baseId + "/" + table.id, params));
    for (const record of result.records) {
      const content = fields.map((field) => {
        const value = airtableCell(field, record.fields[field.id]);
        return value ? safeTitle(field.name, field.id) + ": " + value : "";
      }).filter(Boolean).join("\n");
      rows.set(record.id, content);
    }
    if (rows.size > MAX_ROWS) throw tooManyRows();
    if (!result.offset) return rowsSnapshot(safeTitle(table.name, "Untitled table"), "table", rows);
    if (result.offset === params.get("offset")) throw new WorkspaceOAuthError("invalid_response");
    params.set("offset", result.offset);
  }
  throw tooManyRows();
}

export async function fetchWorkspaceKnowledge(cfg: OAuthConfig, token: string, source: WorkspaceKnowledgeSelection) {
  if (source.kind === "table") return readAirtableKnowledge(cfg, token, source);
  if (source.kind === "page") return readNotionPage(cfg, token, source.id);
  return readNotionDataSource(cfg, token, source.id);
}
