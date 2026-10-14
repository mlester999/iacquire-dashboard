import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import type { PortfolioStatus, PriceType, ServiceAvailability, ServiceKind, ServicePrice, ServiceView } from "@/lib/projects";

interface ServiceRow {
  id: string;
  slug: string;
  kind: ServiceKind;
  category_id: string;
  category_code: string;
  category_name: string;
  name: string;
  tagline: string;
  description: string;
  problem_solved: string;
  accomplishes: string[];
  deliverables: string[];
  exclusions: string[];
  optional_upgrades: string[];
  platforms: string[];
  use_cases: string[];
  tags: string[];
  keywords: string[];
  delivery_min_days: number | null;
  delivery_max_days: number | null;
  availability: ServiceAvailability;
  featured: boolean;
  requires_quote: boolean;
  visible: boolean;
  core_overlap_note: string | null;
  source_note: string | null;
  plan_config: Record<string, unknown>;
  sort_order: number;
  price_type: PriceType | null;
  min_cents: number | null;
  max_cents: number | null;
  currency: string | null;
  price_note: string | null;
}

const SELECT = `
  select s.id, s.slug, s.kind, s.category_id, c.code as category_code, c.name as category_name, s.name, s.tagline, s.description,
         s.problem_solved, s.accomplishes, s.deliverables, s.exclusions, s.optional_upgrades, s.platforms, s.use_cases, s.tags,
         s.keywords, s.delivery_min_days, s.delivery_max_days, s.availability, s.featured, s.requires_quote, s.visible,
         s.core_overlap_note, s.source_note, s.plan_config, s.sort_order,
         v.price_type, v.min_cents, v.max_cents, v.currency, v.note as price_note
  from service_catalog s
  join service_categories c on c.id = s.category_id
  left join service_price_versions v on v.id = s.current_price_version_id`;

function toView(r: ServiceRow, portfolio: ServiceView["portfolio"] = []): ServiceView {
  const price: ServicePrice | null = r.price_type
    ? { type: r.price_type, minCents: r.min_cents, maxCents: r.max_cents, currency: r.currency ?? "USD", note: r.price_note }
    : null;
  return {
    id: r.id,
    slug: r.slug,
    kind: r.kind,
    categoryId: r.category_id,
    categoryCode: r.category_code,
    categoryName: r.category_name,
    name: r.name,
    tagline: r.tagline,
    description: r.description,
    problemSolved: r.problem_solved,
    accomplishes: r.accomplishes,
    deliverables: r.deliverables,
    exclusions: r.exclusions,
    optionalUpgrades: r.optional_upgrades,
    platforms: r.platforms,
    useCases: r.use_cases,
    tags: r.tags,
    keywords: r.keywords,
    deliveryMinDays: r.delivery_min_days,
    deliveryMaxDays: r.delivery_max_days,
    availability: r.availability,
    featured: r.featured,
    requiresQuote: r.requires_quote,
    visible: r.visible,
    sortOrder: r.sort_order,
    monthlyRequestAllowance: Number.isFinite(Number((r.plan_config as { monthlyRequestAllowance?: unknown }).monthlyRequestAllowance)) ? Number((r.plan_config as { monthlyRequestAllowance?: unknown }).monthlyRequestAllowance) : null,
    coreOverlapNote: r.core_overlap_note,
    sourceNote: r.source_note,
    price,
    portfolio,
  };
}

async function portfolioLinks(db: Queryable): Promise<Map<string, ServiceView["portfolio"]>> {
  // Row-level security already limits portfolio rows to approved, visible projects for clients.
  const { rows } = await db.query<{ service_id: string; slug: string; title: string; anonymized_title: string | null; client_name_public: boolean; project_status: PortfolioStatus }>(
    `select l.service_id, p.slug, p.title, p.anonymized_title, p.client_name_public, p.project_status
     from service_portfolio_links l join portfolio_projects p on p.id = l.project_id where p.visible order by l.sort_order, p.sort_order`,
  );
  const map = new Map<string, ServiceView["portfolio"]>();
  for (const r of rows) {
    const list = map.get(r.service_id) ?? [];
    list.push({ slug: r.slug, title: r.client_name_public ? r.title : (r.anonymized_title ?? "Client project"), status: r.project_status });
    map.set(r.service_id, list);
  }
  return map;
}

async function load(db: Queryable, where: string, params: unknown[]): Promise<ServiceView[]> {
  const { rows } = await db.query<ServiceRow>(`${SELECT} ${where} order by c.sort_order, s.sort_order, s.name`, params);
  const links = await portfolioLinks(db);
  return rows.map((r) => toView(r, links.get(r.id)));
}

/** What the marketplace shows: published (visible) services only, enforced by row-level security. */
export async function listMarketplaceServices(userId: string): Promise<ServiceView[]> {
  return withUser(userId, (db) => load(db, "where s.kind <> 'maintenance_plan' and s.visible and c.visible", []));
}

export async function getMarketplaceService(userId: string, slug: string): Promise<ServiceView | null> {
  const all = await withUser(userId, (db) => load(db, "where s.slug = $1 and s.visible and c.visible", [slug]));
  return all[0] ?? null;
}

/** The managed-maintenance plan definition and its current published price. */
export async function getMaintenancePlan(userId: string): Promise<(ServiceView & { monthlyRequestAllowance: number }) | null> {
  const { rows } = await withUser(userId, (db) => db.query<ServiceRow>(`${SELECT} where s.kind = 'maintenance_plan' and s.visible limit 1`));
  const r = rows[0];
  if (!r) return null;
  const allowance = Number((r.plan_config as { monthlyRequestAllowance?: unknown }).monthlyRequestAllowance);
  return { ...toView(r), monthlyRequestAllowance: Number.isFinite(allowance) && allowance >= 0 ? allowance : 4 };
}

// ---------------------------------------------------------------------------
// Agency catalog management
// ---------------------------------------------------------------------------

export interface AdminCategory {
  id: string;
  code: string;
  name: string;
  description: string;
  tier: string;
  sortOrder: number;
  visible: boolean;
}

function assertCatalogAdmin(user: SessionUser) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only agency super admins can change the service catalog and its prices.");
}

export async function listCatalogForAdmin(user: SessionUser): Promise<{ services: ServiceView[]; categories: AdminCategory[]; portfolio: Array<{ slug: string; title: string }> }> {
  assertCatalogAdmin(user);
  return withSystem(async (db) => {
    const services = await load(db, "", []);
    const categories = (await db.query<AdminCategory>('select id, code, name, description, tier, sort_order as "sortOrder", visible from service_categories order by sort_order')).rows;
    const portfolio = (await db.query<{ slug: string; title: string }>("select slug, title from portfolio_projects order by sort_order, title")).rows;
    // Admin sees every portfolio link, including links to projects not yet published.
    const links = await db.query<{ service_id: string; slug: string; title: string; project_status: PortfolioStatus }>(
      "select l.service_id, p.slug, p.title, p.project_status from service_portfolio_links l join portfolio_projects p on p.id = l.project_id order by l.sort_order",
    );
    for (const s of services) s.portfolio = links.rows.filter((l) => l.service_id === s.id).map((l) => ({ slug: l.slug, title: l.title, status: l.project_status }));
    return { services, categories, portfolio };
  });
}

const list = (max: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(max).default([]);
const FILTER_TAGS = ["ai-automation", "ai-agents", "crm-integrations", "websites-funnels", "custom-development", "shopify"] as const;

export const priceInputSchema = z
  .object({
    type: z.enum(["range", "starting_at", "monthly", "custom_quote"]),
    minCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
    maxCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
    note: z.string().trim().max(300).nullable().default(null),
  })
  .superRefine((p, ctx) => {
    if (p.type === "custom_quote" && (p.minCents !== null || p.maxCents !== null)) ctx.addIssue({ code: "custom", message: "A custom quote has no published price." });
    if (p.type !== "custom_quote" && p.minCents === null) ctx.addIssue({ code: "custom", message: "Enter the price." });
    if (p.type === "range" && (p.maxCents === null || p.maxCents < (p.minCents ?? 0))) ctx.addIssue({ code: "custom", message: "The top of the range must be at least the bottom." });
    if (p.type !== "range" && p.maxCents !== null) ctx.addIssue({ code: "custom", message: "Only a range has an upper price." });
  });

export const serviceInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    categoryId: z.string().uuid(),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/, "Use lowercase letters, numbers and dashes."),
    kind: z.enum(["ready_system", "custom_build", "maintenance_plan"]),
    name: z.string().trim().min(2).max(120),
    tagline: z.string().trim().max(300).default(""),
    description: z.string().trim().max(2000).default(""),
    problemSolved: z.string().trim().max(600).default(""),
    accomplishes: list(12, 200),
    deliverables: list(20, 300),
    exclusions: list(20, 300),
    optionalUpgrades: list(20, 120),
    platforms: list(30, 60),
    useCases: list(12, 240),
    tags: z.array(z.enum(FILTER_TAGS)).max(6).default([]),
    keywords: list(40, 60),
    deliveryMinDays: z.number().int().min(1).max(365).nullable().default(null),
    deliveryMaxDays: z.number().int().min(1).max(365).nullable().default(null),
    availability: z.enum(["available", "coming_soon", "unavailable"]).default("available"),
    featured: z.boolean().default(false),
    requiresQuote: z.boolean().default(true),
    visible: z.boolean().default(true),
    coreOverlapNote: z.string().trim().max(500).nullable().default(null),
    sortOrder: z.number().int().min(0).max(100000).default(0),
    monthlyRequestAllowance: z.number().int().min(0).max(100).optional(),
    price: priceInputSchema.optional(),
    portfolioSlugs: z.array(z.string().max(120)).max(20).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.deliveryMinDays && s.deliveryMaxDays && s.deliveryMaxDays < s.deliveryMinDays) ctx.addIssue({ code: "custom", path: ["deliveryMaxDays"], message: "Latest delivery must not be earlier than earliest." });
  });
export type ServiceInput = z.input<typeof serviceInputSchema>;

/** Creates or edits a service. A changed price becomes a new immutable price version. */
export async function saveService(user: SessionUser, input: ServiceInput): Promise<{ id: string }> {
  assertCatalogAdmin(user);
  const d = serviceInputSchema.parse(input);
  if (!d.id && !d.price) throw new AppError("invalid_input", "Set a price (or choose custom quote) for a new service.");
  return withSystem(async (db) => {
    const cat = await db.query("select 1 from service_categories where id = $1", [d.categoryId]);
    if (!cat.rows[0]) throw new AppError("invalid_input", "Choose a category.");
    const dup = await db.query("select 1 from service_catalog where slug = $1 and id is distinct from $2::uuid", [d.slug, d.id ?? null]);
    if (dup.rows[0]) throw new AppError("conflict", "Another service already uses that web address name.");
    const planConfig = d.kind === "maintenance_plan" ? JSON.stringify({ monthlyRequestAllowance: d.monthlyRequestAllowance ?? 4 }) : "{}";
    let id = d.id;
    const values = [d.categoryId, d.slug, d.kind, d.name, d.tagline, d.description || d.tagline, d.problemSolved, d.accomplishes, d.deliverables, d.exclusions, d.optionalUpgrades, d.platforms, d.useCases, d.tags, d.keywords, d.deliveryMinDays, d.deliveryMaxDays, d.availability, d.featured, d.requiresQuote, d.visible, d.coreOverlapNote, d.sortOrder, planConfig, user.id];
    if (id) {
      const found = await db.query("select 1 from service_catalog where id = $1", [id]);
      if (!found.rows[0]) throw new AppError("not_found", "Service not found.");
      await db.query(
        `update service_catalog set category_id=$2, slug=$3, kind=$4, name=$5, tagline=$6, description=$7, problem_solved=$8, accomplishes=$9,
           deliverables=$10, exclusions=$11, optional_upgrades=$12, platforms=$13, use_cases=$14, tags=$15, keywords=$16, delivery_min_days=$17,
           delivery_max_days=$18, availability=$19, featured=$20, requires_quote=$21, visible=$22, core_overlap_note=$23, sort_order=$24,
           plan_config=$25::jsonb, updated_by=$26 where id=$1`,
        [id, ...values],
      );
    } else {
      const ins = await db.query<{ id: string }>(
        `insert into service_catalog (category_id, slug, kind, name, tagline, description, problem_solved, accomplishes, deliverables, exclusions,
           optional_upgrades, platforms, use_cases, tags, keywords, delivery_min_days, delivery_max_days, availability, featured, requires_quote,
           visible, core_overlap_note, sort_order, plan_config, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$25) returning id`,
        values,
      );
      id = ins.rows[0].id;
    }
    let priceChanged = false;
    if (d.price) priceChanged = await writePriceVersion(db, id!, d.price, user.id);
    if (d.portfolioSlugs) {
      await db.query("delete from service_portfolio_links where service_id = $1", [id]);
      for (const [i, slug] of d.portfolioSlugs.entries()) {
        await db.query("insert into service_portfolio_links (service_id, project_id, sort_order) select $1, p.id, $3 from portfolio_projects p where p.slug = $2 on conflict do nothing", [id, slug, i]);
      }
    }
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: d.id ? "catalog.service_updated" : "catalog.service_created", targetType: "service", targetId: id!, result: "success", metadata: { slug: d.slug, visible: d.visible, availability: d.availability, priceChanged } }, db);
    return { id: id! };
  });
}

async function writePriceVersion(db: Queryable, serviceId: string, p: z.output<typeof priceInputSchema>, actorId: string): Promise<boolean> {
  const cur = (await db.query<{ price_type: string; min_cents: number | null; max_cents: number | null; note: string | null; version: number }>(
    `select v.price_type, v.min_cents, v.max_cents, v.note, v.version from service_catalog s join service_price_versions v on v.id = s.current_price_version_id where s.id = $1`,
    [serviceId],
  )).rows[0];
  if (cur && cur.price_type === p.type && cur.min_cents === p.minCents && cur.max_cents === p.maxCents && (cur.note ?? null) === (p.note ?? null)) return false;
  const next = (cur?.version ?? 0) + 1;
  const ins = await db.query<{ id: string }>(
    "insert into service_price_versions (service_id, version, price_type, min_cents, max_cents, note, source, created_by) values ($1,$2,$3,$4,$5,$6,'agency',$7) returning id",
    [serviceId, next, p.type, p.minCents, p.maxCents, p.note, actorId],
  );
  await db.query("update service_catalog set current_price_version_id = $2 where id = $1", [serviceId, ins.rows[0].id]);
  await recordAudit({ actorUserId: actorId, actorKind: "agency", action: "catalog.price_changed", targetType: "service", targetId: serviceId, result: "success", metadata: { version: next, type: p.type, minCents: p.minCents, maxCents: p.maxCents, previousMinCents: cur?.min_cents ?? null, previousMaxCents: cur?.max_cents ?? null } }, db);
  return true;
}

export async function listPriceHistory(user: SessionUser, serviceId: string) {
  assertCatalogAdmin(user);
  const { rows } = await withSystem((db) =>
    db.query<{ version: number; price_type: PriceType; min_cents: number | null; max_cents: number | null; note: string | null; source: string; effective_at: Date; by: string | null }>(
      `select v.version, v.price_type, v.min_cents, v.max_cents, v.note, v.source, v.effective_at, u.full_name as by
       from service_price_versions v left join users u on u.id = v.created_by where v.service_id = $1 order by v.version desc`,
      [serviceId],
    ),
  );
  return rows;
}

/** Quick toggles from the catalog list. Hiding a service removes it from clients immediately. */
export async function setServiceFlags(user: SessionUser, serviceId: string, flags: { visible?: boolean; featured?: boolean; availability?: ServiceAvailability }) {
  assertCatalogAdmin(user);
  if (flags.availability && !["available", "coming_soon", "unavailable"].includes(flags.availability)) throw new AppError("invalid_input", "Unknown availability.");
  await withSystem(async (db) => {
    const r = await db.query(
      `update service_catalog set visible = coalesce($2, visible), featured = coalesce($3, featured), availability = coalesce($4, availability), updated_by = $5 where id = $1 returning id`,
      [serviceId, flags.visible ?? null, flags.featured ?? null, flags.availability ?? null, user.id],
    );
    if (!r.rows[0]) throw new AppError("not_found", "Service not found.");
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "catalog.service_updated", targetType: "service", targetId: serviceId, result: "success", metadata: flags }, db);
  });
}

// ---------------------------------------------------------------------------
// Public content (no sign-in): only what the agency has published
// ---------------------------------------------------------------------------

export interface PublicService {
  slug: string;
  name: string;
  tagline: string;
  category: { code: string; name: string };
  kind: ServiceKind;
  tags: string[];
  keywords: string[];
  platforms: string[];
  deliverables: string[];
  optionalUpgrades: string[];
  deliveryMinDays: number | null;
  deliveryMaxDays: number | null;
  availability: ServiceAvailability;
  featured: boolean;
  price: ServicePrice | null;
  relatedWork: Array<{ slug: string; title: string }>;
}

/** Read-only, anonymous-safe view of the catalog for the public iAcquire website. No internal fields. */
export async function listPublicServices(): Promise<PublicService[]> {
  const services = await withSystem((db) => load(db, "where s.visible and c.visible and s.availability <> 'unavailable'", []));
  return services.map((s) => ({
    slug: s.slug,
    name: s.name,
    tagline: s.tagline,
    category: { code: s.categoryCode, name: s.categoryName },
    kind: s.kind,
    tags: s.tags,
    keywords: s.keywords,
    platforms: s.platforms,
    deliverables: s.deliverables,
    optionalUpgrades: s.optionalUpgrades,
    deliveryMinDays: s.deliveryMinDays,
    deliveryMaxDays: s.deliveryMaxDays,
    availability: s.availability,
    featured: s.featured,
    price: s.price ? { ...s.price, note: s.price.note } : null,
    relatedWork: s.portfolio.map((p) => ({ slug: p.slug, title: p.title })),
  }));
}

export async function getPublicMaintenancePlan() {
  const { rows } = await withSystem((db) => db.query<ServiceRow>(`${SELECT} where s.kind = 'maintenance_plan' and s.visible and c.visible limit 1`));
  const r = rows[0];
  if (!r) return null;
  const view = toView(r);
  const allowance = Number((r.plan_config as { monthlyRequestAllowance?: unknown }).monthlyRequestAllowance);
  return {
    name: view.name,
    tagline: view.tagline,
    optional: true as const,
    price: view.price,
    included: view.deliverables,
    notIncluded: view.exclusions,
    monthlyRequestAllowance: Number.isFinite(allowance) ? allowance : null,
    note: "Optional and never required to use your original system. Billing begins only after you accept the plan and your system is activated.",
  };
}

export const categoryInputSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, "Use lowercase letters, numbers and underscores.").optional(),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(600).default(""),
  tier: z.enum(["ready_to_use", "custom", "maintenance"]).default("ready_to_use"),
  sortOrder: z.number().int().min(0).max(100000).default(100),
  visible: z.boolean().default(true),
});

/** Creates or edits a marketplace category. Hiding one hides its services from clients too. */
export async function saveCategory(user: SessionUser, input: z.input<typeof categoryInputSchema>): Promise<{ id: string }> {
  assertCatalogAdmin(user);
  const d = categoryInputSchema.parse(input);
  return withSystem(async (db) => {
    let id = d.id;
    if (id) {
      const r = await db.query("update service_categories set name=$2, description=$3, tier=$4, sort_order=$5, visible=$6 where id=$1 returning id", [id, d.name, d.description, d.tier, d.sortOrder, d.visible]);
      if (!r.rows[0]) throw new AppError("not_found", "Category not found.");
    } else {
      const code = d.code ?? d.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
      if (code.length < 2) throw new AppError("invalid_input", "Give the category a name.");
      if ((await db.query("select 1 from service_categories where code = $1", [code])).rows[0]) throw new AppError("conflict", "A category with that name already exists.");
      id = (await db.query<{ id: string }>("insert into service_categories (code, name, description, tier, sort_order, visible) values ($1,$2,$3,$4,$5,$6) returning id", [code, d.name, d.description, d.tier, d.sortOrder, d.visible])).rows[0].id;
    }
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: d.id ? "catalog.category_updated" : "catalog.category_created", targetType: "service_category", targetId: id!, result: "success", metadata: { name: d.name, visible: d.visible } }, db);
    return { id: id! };
  });
}
