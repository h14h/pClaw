export type CarouselSlide = { html: string; fit: "cover" | "contain" };
export type BuiltCarousel =
  | { kind: "single"; html: string }
  | { kind: "carousel"; id: string; frame: number; slides: CarouselSlide[] };

export declare const CAROUSEL_MAX_SLIDES: number;
export declare const CAROUSEL_MAX_PER_PAGE: number;
export declare const CAROUSEL_FIT_TOLERANCE: number;
export declare const CAROUSEL_PEEK_REM: number;
export declare function carouselFrame(ratios: number[]): number;
export declare function slideSizes(frame: number, scale: number, options?: { eager?: boolean }): string;
export declare function buildCarousel(html: string): BuiltCarousel;
export declare function lintCarousels(body: string): string[];
