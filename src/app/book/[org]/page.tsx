import { notFound } from "next/navigation";

/** A business has no page listing its calendars; only a calendar's own link opens a booking page. */
export default function BusinessIndex() {
  notFound();
}
