import type { Context } from "@earendil-works/chord/context";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { type ConversationId, defineExtension, defineTool, type DocumentReader } from "@earendil-works/pi-durable";
import { addressOf } from "../routes.ts";
import type { WorkerSandbox } from "../sandbox.ts";

/** Telegram Bot API upload limit is 50 MB. */
export const DEFAULT_MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;

export type OutboundFilePayload = {
	data: Uint8Array;
	filename: string;
	mimeType?: string;
	caption?: string;
	asPhoto?: boolean;
};

export type ChannelFileSender = (address: string, file: OutboundFilePayload) => Promise<void>;

/** Registry of per-channel outbound file senders (registered by telegram.ts, discord.ts, etc.). */
export class FileSenders {
	readonly #senders = new Map<string, ChannelFileSender>();

	register(channel: string, sender: ChannelFileSender): () => void {
		this.#senders.set(channel, sender);
		return () => {
			if (this.#senders.get(channel) === sender) this.#senders.delete(channel);
		};
	}

	get(channel: string): ChannelFileSender | undefined {
		return this.#senders.get(channel);
	}
}

export type SandboxForConversation = (
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
) => Promise<{ address: string | undefined; sandbox: WorkerSandbox | undefined }>;

export function filesExtension(options: {
	fileSenders: FileSenders;
	resolveSandbox: SandboxForConversation;
	maxBytes?: number;
}) {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTBOUND_FILE_BYTES;
	return defineExtension({
		name: "pclaw.files",
		tools: [
			defineTool({
				name: "send_file",
				description:
					"Send a file from the user's workspace or inbox directly to the active chat (e.g. a generated .sql, .xmltv, .md, CSV, PDF, or image). " +
					"Path must be inside the user's workspace or inbox directory.",
				parameters: obj(
					{
						path: str({ description: "Path to the file inside the workspace or inbox (relative to workDir, or full path inside workDir/inboxDir)." }),
						caption: opt(str({ description: "Optional short caption shown with the file." })),
						asPhoto: opt(bool({ description: "Send an image inline as a photo instead of a document attachment." })),
					},
					{ open: true },
				),
				execute: async ({ path, caption, asPhoto }, api, context) => {
					const address = await addressOf(api, api.conversationId, context);
					if (address === undefined) throw new Error("Couldn't determine which chat to send the file to.");
					const channel = address.split(":")[0]!;
					const sender = options.fileSenders.get(channel);
					if (sender === undefined) throw new Error(`Sending files isn't supported on ${channel}.`);
					const { sandbox } = await options.resolveSandbox(api, api.conversationId, context);
					if (sandbox === undefined) throw new Error("No workspace is available for sending files in this conversation.");
					const file = await sandbox.getFile(path, maxBytes, context.abortSignal);
					await sender(address, {
						data: file.data,
						filename: file.filename,
						...(caption === undefined ? {} : { caption }),
						...(asPhoto === undefined ? {} : { asPhoto }),
					});
					return { output: [{ type: "text" as const, text: `Sent ${file.filename} (${file.sizeBytes} bytes).` }] };
				},
			}),
		],
	});
}
