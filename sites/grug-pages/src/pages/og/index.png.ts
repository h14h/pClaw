import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { renderOgCardPng } from "@lib/og";

export const GET: APIRoute = async ({ site }) => {
  const entries = await getCollection("pages");
  const count = entries.length;
  const pill = count === 0 ? "Research shelf" : count === 1 ? "1 page" : `${count} pages`;
  const png = await renderOgCardPng({
    title: "Grug Pages",
    summary: "Personal research notes, comparisons, guides, and interactive tools.",
    pill,
    tags: ["notes", "comparisons", "guides"],
    host: site?.hostname || "grug.h14h.com",
  });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
