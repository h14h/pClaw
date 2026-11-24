import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { renderOgCardPng } from "@lib/og";
import { formatDate, normalizePageSlug } from "@lib/urls";

export async function getStaticPaths() {
  const entries = await getCollection("pages");
  return entries.map((entry) => ({
    params: { slug: normalizePageSlug(entry.id) },
    props: { entry },
  }));
}

export const GET: APIRoute = async ({ props, site }) => {
  const { entry } = props;
  const png = await renderOgCardPng({
    title: entry.data.title,
    summary: entry.data.summary,
    pill: formatDate(entry.data.updated ?? entry.data.date),
    tags: entry.data.tags ?? [],
    host: site?.hostname || "grug.h14h.com",
  });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
