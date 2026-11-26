export type Size = { w: number; h: number };
export type View = { scale: number; x: number; y: number };
export type OpeningView = View & { mode: "fit" | "pan-x" | "pan-y" };

export declare const LIGHTBOX_MAX_DEVICE_SCALE: number;
export declare const LIGHTBOX_DOUBLE_TAP_ZOOM: number;
export declare const LIGHTBOX_PAN_SHAPE: number;
export declare const LIGHTBOX_PAN_MIN_RATIO: number;
export declare const LIGHTBOX_PAN_FILL: number;
export declare const LIGHTBOX_MAX_FIT: number;
export declare function openingView(stage: Size, image: Size): OpeningView;
export declare function scaleLimits(opening: View, dpr?: number): { min: number; max: number };
export declare function clampView(stage: Size, image: Size, view: View, centre?: boolean): View;
export declare function zoomAt(stage: Size, image: Size, view: View, nextScale: number, px: number, py: number, limits: { min: number; max: number }): View;
export declare function panBy(stage: Size, image: Size, view: View, dx: number, dy: number): View;
export declare function toggleZoom(stage: Size, image: Size, view: View, opening: View, px: number, py: number, limits: { min: number; max: number }): View;
export declare function canPan(stage: Size, image: Size, view: View): boolean;
export declare function classifySwipe(dx: number, dy: number): "next" | "prev" | "close" | null;
export declare function pickSource<T extends { w: number }>(candidates: T[], needed: number): T;
