import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import satori, { type Font } from "satori";
import { GRUG_MARK_PATH, GRUG_MARK_VIEWBOX, renderGrugBadgeSvg } from "./grug-mark";

const require = createRequire(import.meta.url);

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

let cachedFonts: Font[] | null = null;

function loadFonts(): Font[] {
  if (cachedFonts) return cachedFonts;

  const geistRegular = readFileSync(
    require.resolve("@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff"),
  );
  const geistMedium = readFileSync(
    require.resolve("@fontsource/geist-sans/files/geist-sans-latin-500-normal.woff"),
  );
  const geistSemiBold = readFileSync(
    require.resolve("@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff"),
  );
  const geistMonoRegular = readFileSync(
    require.resolve("@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff"),
  );

  cachedFonts = [
    { name: "Geist", data: geistRegular, weight: 400, style: "normal" },
    { name: "Geist", data: geistMedium, weight: 500, style: "normal" },
    { name: "Geist", data: geistSemiBold, weight: 600, style: "normal" },
    { name: "Geist Mono", data: geistMonoRegular, weight: 400, style: "normal" },
  ];
  return cachedFonts;
}

function truncateWords(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const sliced = clean.slice(0, maxChars - 1);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[,.;:\s]+$/, "")}…`;
}

function titleFontSize(title: string): number {
  const len = title.length;
  if (len <= 28) return 62;
  if (len <= 52) return 54;
  if (len <= 80) return 46;
  return 40;
}

export interface OgCardOptions {
  title: string;
  summary: string;
  pill?: string;
  tags?: string[];
  host?: string;
}

export async function renderOgCardPng(options: OgCardOptions): Promise<Uint8Array> {
  const title = truncateWords(options.title, 115);
  const summary = truncateWords(options.summary, 165);
  const tags = (options.tags ?? []).filter(Boolean).slice(0, 3);
  const host = (options.host ?? "grug.h14h.com").trim() || "grug.h14h.com";
  const pill = options.pill?.trim();

  const frameWidth = OG_WIDTH - 64;
  const frameHeight = OG_HEIGHT - 6 - 60;
  const contentWidth = frameWidth - 104;

  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          width: OG_WIDTH,
          height: OG_HEIGHT,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#faf9f7",
          fontFamily: "Geist",
          color: "#1c1917",
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                width: OG_WIDTH,
                height: 6,
                backgroundColor: "#0f5c57",
                display: "flex",
                flexShrink: 0,
              },
            },
          },
          {
            type: "div",
            props: {
              style: {
                width: OG_WIDTH,
                height: OG_HEIGHT - 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              },
              children: {
                type: "div",
                props: {
                  style: {
                    width: frameWidth,
                    height: frameHeight,
                    display: "flex",
                    flexDirection: "column",
                    borderRadius: 16,
                    border: "1px solid rgba(28, 25, 23, 0.1)",
                    backgroundColor: "#faf9f7",
                  },
                  children: {
                    type: "div",
                    props: {
                      style: {
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        padding: "40px 52px",
                      },
                      children: [
                    // Top bar
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: contentWidth,
                        },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                display: "flex",
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 14,
                              },
                              children: [
                                {
                                  type: "svg",
                                  props: {
                                    width: 38,
                                    height: 38,
                                    viewBox: GRUG_MARK_VIEWBOX,
                                    children: {
                                      type: "path",
                                      props: {
                                        d: GRUG_MARK_PATH,
                                        fill: "#1c1917",
                                        fillRule: "evenodd",
                                      },
                                    },
                                  },
                                },
                                {
                                  type: "div",
                                  props: {
                                    style: {
                                      fontSize: 25,
                                      fontWeight: 500,
                                      letterSpacing: "-0.02em",
                                      color: "#1c1917",
                                    },
                                    children: "grug pages",
                                  },
                                },
                              ],
                            },
                          },
                          pill
                            ? {
                                type: "div",
                                props: {
                                  style: {
                                    display: "flex",
                                    alignItems: "center",
                                    padding: "7px 16px",
                                    borderRadius: 999,
                                    backgroundColor: "rgba(28, 25, 23, 0.05)",
                                    border: "1px solid rgba(28, 25, 23, 0.08)",
                                    fontFamily: "Geist Mono",
                                    fontSize: 17,
                                    color: "#57534e",
                                  },
                                  children: pill,
                                },
                              }
                            : {
                                type: "div",
                                props: { style: { display: "flex" } },
                              },
                        ],
                      },
                    },

                    // Main body
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          gap: 20,
                          flexGrow: 1,
                          paddingTop: 18,
                          paddingBottom: 18,
                        },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                fontSize: titleFontSize(title),
                                fontWeight: 600,
                                letterSpacing: "-0.03em",
                                lineHeight: 1.12,
                                color: "#1c1917",
                              },
                              children: title,
                            },
                          },
                          {
                            type: "div",
                            props: {
                              style: {
                                fontSize: 26,
                                fontWeight: 400,
                                lineHeight: 1.45,
                                color: "#57534e",
                                maxWidth: 960,
                              },
                              children: summary,
                            },
                          },
                        ],
                      },
                    },

                    // Footer
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: contentWidth,
                          paddingTop: 22,
                          borderTop: "1px solid rgba(28, 25, 23, 0.09)",
                        },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                display: "flex",
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 10,
                              },
                              children: tags.map((tag) => ({
                                type: "div",
                                props: {
                                  style: {
                                    display: "flex",
                                    alignItems: "center",
                                    padding: "6px 14px",
                                    borderRadius: 8,
                                    backgroundColor: "rgba(28, 25, 23, 0.055)",
                                    fontSize: 18,
                                    fontWeight: 500,
                                    color: "#44403c",
                                  },
                                  children: tag,
                                },
                              })),
                            },
                          },
                          {
                            type: "div",
                            props: {
                              style: {
                                fontFamily: "Geist Mono",
                                fontSize: 19,
                                color: "#57534e",
                                letterSpacing: "-0.01em",
                              },
                              children: host,
                            },
                          },
                        ],
                      },
                    },
                  ],
                    },
                  },
                },
              },
            },
          },
        ],
      },
    } as Parameters<typeof satori>[0],
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts: loadFonts(),
    },
  );

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: OG_WIDTH,
    },
  });
  return resvg.render().asPng();
}

export function renderFaviconPng(size: number, options?: { rounded?: boolean }): Uint8Array {
  const svg = renderGrugBadgeSvg({
    background: "#faf9f7",
    foreground: "#1c1917",
    rounded: options?.rounded ?? true,
  });
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: size,
    },
  });
  return resvg.render().asPng();
}
