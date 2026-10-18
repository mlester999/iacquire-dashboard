import { notFound } from "next/navigation";

/** There is no index of booking pages: each business shares its own link. */
export default function BookIndex() {
  notFound();
}
