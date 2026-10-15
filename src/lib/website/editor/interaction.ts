import { deviceWidth, type Device } from "./state";

/** The canvas has a real document width; zoom only changes its presentation. */
export function canvasGeometry(device: Device, available: number, zoom: "fit" | number) {
  const availableWidth = Math.max(1, Number.isFinite(available) ? available : 1);
  const width = device === "desktop" ? Math.max(1100, Math.min(1440, availableWidth - 48)) : deviceWidth(device);
  const fit = Math.max(0.05, Math.min(1, (availableWidth - 40) / width));
  const scale = zoom === "fit" ? fit : Math.max(0.05, Math.min(2, Number.isFinite(zoom) ? zoom : fit));
  return { width, scale };
}

export type LayerCommand = "previous" | "next" | "expand" | "collapse" | "select" | "move-up" | "move-down" | "remove" | "first" | "last" | null;

/** Modified arrows must be resolved before tree navigation arrows. */
export function layerCommand(key: string, altKey: boolean): LayerCommand {
  if (altKey && key === "ArrowUp") return "move-up";
  if (altKey && key === "ArrowDown") return "move-down";
  if (key === "ArrowUp") return "previous";
  if (key === "ArrowDown") return "next";
  if (key === "ArrowRight") return "expand";
  if (key === "ArrowLeft") return "collapse";
  if (key === "Enter" || key === " ") return "select";
  if (key === "Delete") return "remove";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return null;
}
