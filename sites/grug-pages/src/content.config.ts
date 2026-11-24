import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const isoDate = z
  .union([z.string(), z.date()])
  .transform((value) => {
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
    return value.trim();
  })
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: "Expected ISO date in YYYY-MM-DD format",
  });

const pages = defineCollection({
  loader: glob({
    pattern: ["**/*.mdx", "**/*.md", "!**/.*"],
    base: "./src/content/pages",
  }),
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    date: isoDate,
    updated: isoDate.optional(),
    summary: z.string().min(1),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { pages };
