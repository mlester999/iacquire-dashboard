// The name the top bar shows for the page the person is on. A plain file (no "use client"), so a test can read it without a browser and a server file could too.
// First match wins, so a more specific route goes above the general one it lives under.

export const FALLBACK_TITLE = "iAcquire";

export const TITLES: Array<[RegExp, string]> = [
  [/^\/overview/, "Overview"],
  [/^\/setup/, "Setup"],
  [/^\/employees\/[^/]+\/configure/, "Configure employee"],
  [/^\/employees/, "AI Employees"],
  [/^\/leads/, "Leads"],
  [/^\/appointments/, "Appointments"],
  [/^\/sales/, "Sales Pipeline"],
  [/^\/proposals/, "Proposals"],
  [/^\/invoices/, "Invoices"],
  [/^\/retention/, "Customer Retention"],
  [/^\/analytics/, "Analytics"],
  [/^\/approvals/, "Approval Center"],
  [/^\/knowledge/, "Knowledge Center"],
  [/^\/activity/, "Activity"],
  [/^\/notifications/, "Notifications"],
  [/^\/support/, "Support"],
  [/^\/crm\/contacts/, "Contacts"],
  [/^\/crm\/companies/, "Companies"],
  [/^\/crm\/smart-lists/, "Smart Lists"],
  [/^\/crm\/tags/, "Tags & Segments"],
  [/^\/crm\/fields/, "Custom Fields"],
  [/^\/crm\/pipelines/, "Pipelines"],
  [/^\/crm\/opportunities/, "Opportunities"],
  [/^\/crm\/tasks/, "Tasks"],
  [/^\/crm\/settings/, "CRM Settings"],
  [/^\/crm\/reviews/, "Reviews"],
  [/^\/crm/, "CRM"],
  [/^\/inbox/, "Inbox"],
  [/^\/settings/, "Settings"],
  [/^\/add-ons/, "Custom Projects & Add-ons"],
  [/^\/projects/, "My Projects"],
  [/^\/our-work/, "Selected Work"],
  [/^\/maintenance/, "Maintenance"],
  [/^\/automation-studio/, "Automation Studio"],
  [/^\/website/, "Website"],
  [/^\/social/, "Social Media"],
  [/^\/work/, "AI Work Board"],
];

export function titleFor(pathname: string): string {
  return TITLES.find(([re]) => re.test(pathname))?.[1] ?? FALLBACK_TITLE;
}
