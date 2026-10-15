import type { ElementNode, Section, SiteContent } from "../doc";
import { templateStarter } from "./starter-content-catalog";

/**
 * Complete the authored demonstration copy on the canonical document, before it is rendered.
 * This is a build-time step for new built-in samples only: saved customer sites and custom
 * template snapshots are never passed through it, and non-sample documents are a strict no-op.
 * Layouts, node IDs, image references, responsive settings, and the source document are preserved.
 */
export function applyTemplateStarterContent(content: SiteContent, key: string): SiteContent {
  const identity = templateStarter(key);
  if (!content.isSample || !identity || content.origin.key !== key) return content;
  const doc = structuredClone(content);
  const brand = identity.sample.businessName;
  const h = identity.headings;
  const sectionTitles: Record<string, string> = {
    Hero: identity.sample.tagline!, Introduction: h[0], About: h[1], Services: h[2],
    FAQ: h[3], Gallery: h[4], Contact: h[5], "Call to action": h[6], Process: h[7],
    Logos: `${brand}: illustrative capabilities`, Numbers: `${brand}: a concept outline`,
  };
  const pageTitles: Record<string, string> = {
    about: `Meet ${brand}`, services: `Working with ${brand}`, faq: `Questions for ${brand}`,
    gallery: `${brand}: the studies`, contact: `Talk with ${brand}`,
  };
  const seen = new Set<string>();

  function sectionCopy(section: Section, pageSlug?: string) {
    if (seen.has(section.id)) return;
    seen.add(section.id);
    const role = section.name;
    let headingDone = false;
    let ledeDone = false;
    let captionIndex = 0;
    let conceptIndex = 0;
    let badgeIndex = 0;
    const caption = () => {
      const index = captionIndex++;
      const text = identity!.captions[index % identity!.captions.length];
      return index < identity!.captions.length ? text : `${text} · Detail ${index + 1}`;
    };
    const walk = (node: ElementNode) => {
      const props = node.props;
      if (node.type === "heading" && !headingDone) {
        const title = role === "Page title" ? pageTitles[pageSlug ?? ""] : sectionTitles[role];
        if (title) props.text = title;
        headingDone = true;
      }
      if (node.type === "text") {
        const textRole = props.role;
        if (role === "Footer") {
          if (textRole === "small") props.text = identity!.footer;
          if (textRole === "body") props.text = identity!.sample.tagline;
        } else if (textRole === "eyebrow") {
          props.text = role === "Page title" || role === "Hero" ? brand : `${brand} · ${role.toLowerCase()}`;
        } else if (role === "Logos" && textRole === "small") {
          props.text = `${brand} · Illustrative capabilities`;
        } else if (textRole === "lede" && !ledeDone) {
          if (role === "About") props.text = identity!.sample.aboutText;
          else if (role === "FAQ") props.text = `${brand}: useful details before the first conversation.`;
          else if (role === "Contact") props.text = `Tell ${brand} what you have in mind and the best way to reach you.`;
          else if (role === "Page title") props.text = pageSlug === "about" ? identity!.sample.tagline : identity!.description;
          else props.text = identity!.sample.description;
          ledeDone = true;
        } else if (role === "About" && textRole === "body") props.text = identity!.sample.aboutText;
        else if (role === "Introduction" && textRole === "body") props.text = identity!.sample.description;
        else if (role === "Hero" && textRole === "small" && key.startsWith("tech.")) props.text = "Illustrative workspace";
      }
      if (node.type === "button") {
        const link = props.link as { label: string; href: string };
        if (link.href.startsWith("tel:")) link.label = `Call ${brand}`;
        else if (link.href === "/contact") link.label = identity!.primaryLabel;
        else if (link.href === "/services") link.label = identity!.secondaryLabel;
        else if (link.href === "/gallery") link.label = `View ${brand} studies`;
      }
      if (node.type === "nav" && props.showCta) {
        const cta = props.cta as { label: string; href: string };
        cta.label = identity!.primaryLabel;
      }
      if (node.type === "form") {
        props.submitLabel = identity!.primaryLabel;
        props.helper = `Fictional demonstration for ${brand}. Do not send sensitive information.`;
      }
      if (node.type === "badge" && role === "Hero") props.text = badgeIndex++ === 0 ? `${brand} · Concept` : key.startsWith("tech.") ? "Workflow outline" : `${brand} studio`;
      if (node.type === "image") {
        props.alt = caption();
        if (props.caption) props.caption = props.alt;
      }
      if (node.type === "gallery" || node.type === "collage") {
        const items = props.items as Array<Record<string, unknown>>;
        for (const item of items) {
          item.alt = caption();
          if (node.type === "gallery") item.caption = item.alt;
        }
      }
      // The technology heroes used to show invented customer/performance figures. A numbered
      // concept outline keeps the same designed component without pretending to be product data.
      if (node.type === "stats") {
        const items = props.items as Array<Record<string, unknown>>;
        for (const item of items) {
          const service = identity!.sample.services[conceptIndex % identity!.sample.services.length];
          item.value = String(++conceptIndex).padStart(2, "0");
          item.prefix = ""; item.suffix = ""; item.label = service.title;
        }
        props.countUp = false;
      }
      if (node.type === "logos") {
        props.items = identity!.sample.services.map((service) => ({ name: service.title, image: null }));
      }
      if (role === "Hero" && node.type === "list" && key.startsWith("tech.")) {
        props.items = identity!.sample.services.map((service) => `${service.title} · Illustrative workflow`);
      }
      if (role === "Hero" && node.type === "marquee" && key.startsWith("tech.")) {
        props.items = identity!.sample.services.map((service) => service.title);
      }
      for (const child of node.children ?? []) walk(child);
    };
    for (const column of section.columns) for (const node of column.elements) walk(node);
  }

  if (doc.header) sectionCopy(doc.header);
  if (doc.footer) sectionCopy(doc.footer);
  for (const section of Object.values(doc.globals)) sectionCopy(section);
  for (const page of doc.pages) for (const item of page.items) if (item.type === "section") sectionCopy(item, page.slug);
  return doc;
}
