import type { IncomingMessage, ServerResponse } from "node:http";
import type { Stats } from "node:fs";

export declare const CONTENT_SECURITY_POLICY: string;
export declare const SECURITY_HEADERS: Readonly<{
	"Content-Security-Policy": string;
	"X-Robots-Tag": string;
	"Referrer-Policy": string;
	"X-Content-Type-Options": string;
}>;
export declare const MIME_TYPES: Readonly<Record<string, string>>;

export declare function mimeTypeFor(filePath: string): string;
export declare function normalizeBasePath(basePath: string | undefined): string;

export type ResolvedStaticFile =
	| { status: "file"; filePath: string; stat: Stats; isImmutable: boolean }
	| { status: "redirect"; location: string }
	| { status: "not_found" };

export declare function resolveSafeFile(
	rootDir: string,
	rawRelativePath: string,
	originalPathname?: string,
): ResolvedStaticFile;

export declare function createStaticHandler(options: {
	rootDir: string;
	basePath?: string;
}): (req: IncomingMessage, res: ServerResponse) => void;
