export type ImageType = { ext: "jpg" | "png" | "gif" | "webp" | "avif"; mime: string };

export declare const MAX_IMAGE_BYTES: number;
export declare const IMAGE_TIMEOUT_MS: number;
export declare function isPrivateAddress(address: string): boolean;
export declare function sniffImageType(bytes: Buffer): ImageType | undefined;
export declare function fetchImage(
	rawUrl: string,
	options?: { allowPrivate?: boolean; maxBytes?: number; timeoutMs?: number },
): Promise<{ bytes: Buffer; type: ImageType; finalUrl: string }>;
