"use client";

import * as React from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Raw HTML in model output is never rendered (react-markdown escapes it by default).
export function safeHref(href?: string) {
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//") && !/[\\\s]/.test(href)) return href;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export const Markdown = React.memo(function Markdown({
  children,
  className,
  onNavigate,
}: {
  children: string;
  className?: string;
  /** Called after an in-app link is followed, for example to close a panel that covers the page. */
  onNavigate?: () => void;
}) {
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => {
            const safe = safeHref(href);
            if (!safe) return <span>{c}</span>;
            if (safe.startsWith("/")) {
              return (
                <Link href={safe} onClick={onNavigate}>
                  {c}
                </Link>
              );
            }
            return (
              <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
                {c}
              </a>
            );
          },
          img: () => null,
          // A scrolling code block must be reachable by keyboard.
          pre: ({ children: c }) => <pre tabIndex={0}>{c}</pre>,
          // Keep real table semantics; the wrapper does the scrolling.
          table: ({ children: c }) => (
            <div className="md-scroll" role="region" aria-label="Table" tabIndex={0}>
              <table>{c}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
