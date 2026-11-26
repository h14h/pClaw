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
export declare function buildCarousel(html: string, label?: string): BuiltCarousel;
export declare function frameFill(ratio: number, frame: number): number;
export declare function fillWarnings(label: string, photos: { alt: string; ratio: number }[]): string[];
export type CarouselSettler = { scroll(): void; scrollEnd(): void; press(): void; release(): void; readonly held: boolean };
export declare function createSettler(options: {
  nativeScrollEnd: boolean;
  settle: () => void;
  delay?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): CarouselSettler;
export declare function lintCarousels(body: string, options?: { sizeOf?: (src: string) => [number, number] | undefined }): string[];
export type PointerLike = { pointerType: string; pointerId: number; clientX: number; clientY: number };
export declare function createPressGate(options?: { now?: () => number; slop?: number; window?: number }): {
  pointerDown(event: PointerLike): void;
  pointerCancel(): void;
  pointerUp(event: PointerLike): boolean;
  click(): boolean;
};
