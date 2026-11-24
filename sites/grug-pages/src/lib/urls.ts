const BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

/** Join an app-relative path with Astro's configured `base` (works for `/` and `/<userCode>`). */
export function withBase(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return BASE ? `${BASE}${clean}` : clean;
}

/** Build an absolute canonical/OG URL under Astro's configured `site` and `base`. */
export function absoluteUrl(path: string, site?: URL): string {
  const origin = (site?.origin ?? "https://grug.h14h.com").replace(/\/+$/, "");
  return `${origin}${withBase(path)}`;
}

/** Normalize an Astro Content Layer entry id (`foo/index` or `foo`) into its canonical URL slug (`foo`). */
export function normalizePageSlug(id: string): string {
  return id.replace(/\/index$/i, "").replace(/\.(md|mdx)$/i, "");
}

/** Format an ISO `YYYY-MM-DD` date into readable editorial form (`24 Nov 2026`). */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return iso;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
