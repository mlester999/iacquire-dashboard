// Small, pure presentation rules for the staff workload screens. The services decide what a person may see; these only choose the words, colours and links for it.

import type { WorkSource } from "@/lib/staff-workload/sources";
import type { WorkloadLabel } from "@/lib/staff-workload/labels";

export type LabelTone = "success" | "primary" | "warning" | "danger" | "neutral";

export const LABEL_TONE: Record<WorkloadLabel, LabelTone> = {
  available: "success",
  balanced: "primary",
  busy: "warning",
  overloaded: "danger",
  critical: "danger",
};

export const SOURCE_SHORT: Record<WorkSource, string> = {
  support: "Support",
  setup_task: "Setup",
  project: "Project",
  maintenance: "Maintenance",
};

/** Where a person can open the module that owns an item (when they may read it). */
export function workloadItemHref(source: WorkSource, itemId: string, orgId: string): string {
  switch (source) {
    case "support":
      return `/admin/support?ticket=${itemId}`;
    case "project":
      return `/admin/projects/${itemId}`;
    case "setup_task":
      return `/admin/clients/${orgId}/setup`;
    case "maintenance":
      return "/admin/maintenance";
  }
}

export const percentText = (value: number | null): string => (value === null ? "—" : `${Math.round(value)}%`);

/** The tone of a capacity bar: fuller than the label's first warning, then danger at Overloaded. */
export function loadTone(percent: number | null): "primary" | "warning" | "danger" {
  if (percent === null) return "primary";
  return percent >= 100 ? "danger" : percent >= 85 ? "warning" : "primary";
}

export const capsText = (label: WorkloadLabel | null): string => (label === null ? "No label yet" : label[0].toUpperCase() + label.slice(1));
