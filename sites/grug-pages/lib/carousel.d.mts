export type CarouselSlide = { html: string; fit: "cover" | "contain" };
export type BuiltCarousel =
  | { kind: "single"; html: string }
  | { kind: "carousel"; id: string; frame: number; slides: CarouselSlide[]; warnings: string[] };

export declare const CAROUSEL_MAX_SLIDES: number;
export declare const CAROUSEL_MAX_PER_PAGE: number;
export declare const CAROUSEL_FIT_TOLERANCE: number;
export declare const CAROUSEL_PEEK_REM: number;
export declare const CAROUSEL_MIN_FILL: number;
export declare const CAROUSEL_TOO_MANY: string;
export declare const CAROUSEL_SMALL_FILL: string;
export declare function carouselFrame(ratios: number[]): number;
export declare function slideSizes(frame: number, scale: number): string;
export declare function buildCarousel(html: string): BuiltCarousel;
export declare function lintCarousels(body: string): string[];
