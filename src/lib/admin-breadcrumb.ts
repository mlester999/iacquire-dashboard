/** Route-aware labels; nested studio routes are not client-detail pages. */
export function adminDetailLabel(pathname: string): string | null {
  const suffix = pathname.replace(/^\/admin\/website-studio\/?/, "").split("/");
  if (pathname.startsWith("/admin/website-studio/")) {
    const [area, id, action] = suffix;
    if (area === "templates") return id ? "Template Designer" : "Template Library";
    if (area === "websites") return id ? (action === "edit" ? "Website Editor" : "Client Website") : "Client Websites";
    return ({ reviews: "Reviews & Publishing", domains: "Domains & Hosting", media: "Media Library", "shared-sections": "Shared Sections" } as Record<string, string>)[area] ?? null;
  }
  const [, section, id] = pathname.split("/").filter(Boolean).length > 2 ? pathname.split("/").filter(Boolean) : [];
  if (!id) return null;
  if (section === "support") return "Ticket";
  if (section === "projects") return "Project";
  return "Client detail";
}
