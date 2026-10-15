"use client";

import * as React from "react";
import { PreviewShell } from "@/components/website/frame/preview-shell";

/** A read-only draft at the actual selected viewport. */
export function SitePreviewOverlay({ title, src, onClose, actions, note = "Draft preview" }: { title: string; src: string; onClose: () => void; actions?: React.ReactNode; note?: string }) {
  return <PreviewShell title={title} subtitle={note} src={src} onClose={onClose} actions={actions} />;
}