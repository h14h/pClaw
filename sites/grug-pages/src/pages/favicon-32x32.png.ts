import type { APIRoute } from "astro";
import { renderFaviconPng } from "@lib/og";

export const GET: APIRoute = () => {
  const png = renderFaviconPng(32, { rounded: true });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
