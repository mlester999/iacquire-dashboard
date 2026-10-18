import * as React from "react";
import type { ElementNode } from "@/lib/website/doc";
import { Badge, ButtonEl, Divider, Heading, IconEl, ImageNode, ListEl, Spacer, TextEl } from "./basic";
import { BookingEl } from "./booking";
import { Collage, ContactInfo, Faq, FormEl, Gallery, Logo, Logos, MapEl, Marquee, Nav, Pricing, Services, Social, Stats, Steps, Team, Testimonials, Video } from "./content";
import type { RenderCtx } from "./ctx";
import { rootProps } from "./parts";

const s = (v: unknown) => (typeof v === "string" ? v : "");

function Group({ el, ctx, p, index }: { el: ElementNode; ctx: RenderCtx; p: Record<string, unknown>; index?: number }) {
  const stagger = Boolean(el.anim?.stagger);
  return (
    <div {...rootProps(el, ctx, "iq-group", index)} data-dir={s(p.dir) || "row"} data-wrap={p.wrap === false ? "no" : "yes"} data-justify={s(p.justify) || "start"} data-items={s(p.items) || "center"} style={{ ...((rootProps(el, ctx, "", index).style as object) ?? {}), "--g": `var(--sp-${s(p.gap) || "s"})` } as React.CSSProperties}>
      {(el.children ?? []).map((k, i) => renderElement(k, ctx, stagger ? i : undefined))}
      {ctx.edit && !(el.children?.length) && <div className="iq-empty-slot" data-empty="group">Drop elements here</div>}
    </div>
  );
}

function Card({ el, ctx, p, index }: { el: ElementNode; ctx: RenderCtx; p: Record<string, unknown>; index?: number }) {
  const stagger = Boolean(el.anim?.stagger);
  return (
    <div {...rootProps(el, ctx, "iq-card", index)} data-surface={s(p.surface) || "outlined"} data-hover={s(p.hover) !== "none" ? s(p.hover) : undefined} data-align={s(p.align) || "start"} style={{ ...((rootProps(el, ctx, "", index).style as object) ?? {}), "--pad": `var(--sp-${s(p.pad) || "m"})`, "--cg": `var(--sp-${s(p.gap) || "s"})` } as React.CSSProperties}>
      {(el.children ?? []).map((k, i) => renderElement(k, ctx, stagger ? i : undefined))}
      {ctx.edit && !(el.children?.length) && <div className="iq-empty-slot" data-empty="card">Drop elements here</div>}
    </div>
  );
}

/** Draws one element of any type. This is the single place that maps the document's element types to their markup. */
export function renderElement(el: ElementNode, ctx: RenderCtx, index?: number): React.ReactNode {
  const p = el.props;
  const common = { el, ctx, p, index };
  switch (el.type) {
    case "heading": return <Heading key={el.id} {...common} />;
    case "text": return <TextEl key={el.id} {...common} />;
    case "image": return <ImageNode key={el.id} {...common} />;
    case "button": return <ButtonEl key={el.id} {...common} />;
    case "group": return <Group key={el.id} {...common} />;
    case "card": return <Card key={el.id} {...common} />;
    case "icon": return <IconEl key={el.id} {...common} />;
    case "divider": return <Divider key={el.id} {...common} />;
    case "spacer": return <Spacer key={el.id} {...common} />;
    case "badge": return <Badge key={el.id} {...common} />;
    case "list": return <ListEl key={el.id} {...common} />;
    case "services": return <Services key={el.id} {...common} />;
    case "steps": return <Steps key={el.id} {...common} />;
    case "faq": return <Faq key={el.id} {...common} />;
    case "testimonials": return <Testimonials key={el.id} {...common} />;
    case "stats": return <Stats key={el.id} {...common} />;
    case "logos": return <Logos key={el.id} {...common} />;
    case "team": return <Team key={el.id} {...common} />;
    case "pricing": return <Pricing key={el.id} {...common} />;
    case "gallery": return <Gallery key={el.id} {...common} />;
    case "collage": return <Collage key={el.id} {...common} />;
    case "video": return <Video key={el.id} {...common} />;
    case "contactInfo": return <ContactInfo key={el.id} {...common} />;
    case "social": return <Social key={el.id} {...common} />;
    case "nav": return <Nav key={el.id} {...common} />;
    case "logo": return <Logo key={el.id} {...common} />;
    case "form": return <FormEl key={el.id} {...common} />;
    case "map": return <MapEl key={el.id} {...common} />;
    case "marquee": return <Marquee key={el.id} {...common} />;
    case "booking": return <BookingEl key={el.id} {...common} />;
  }
}
