import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	type EntryId,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { Agent } from "../agent.ts";
import { type Config, paths, saveConfig } from "../config.ts";
import { deliver, type Outbox } from "../delivery.ts";
import type { Job } from "../extensions/jobs.ts";
import { Reactions } from "../extensions/reactions.ts";
import { Workers } from "../extensions/workers.ts";
import { type Heard, memoLabel, transcribe } from "../speech.ts";
import { stamp } from "../time.ts";
import { isDelegateAck, ReplyThreads } from "./reply-threads.ts";
import {
	markdownToTelegramHtml,
	normalizeTelegramReaction,
	splitPlainText,
	splitTelegramHtml,
	stripTelegramHtml,
	TELEGRAM_MAX_CAPTION,
	TELEGRAM_MAX_MESSAGE,
	transcriptQuoteHtml,
} from "./telegram-format.ts";

const DEFAULT_API_BASE = "https://api.telegram.org";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Telegram Bot API `getFile` download cap is 20 MB. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Telegram typing indicators expire after ~5s. */
const TYPING_REFRESH_MS = 4_000;
const MEDIA_GROUP_DEBOUNCE_MS = 600;
const CAPTIONLESS_FILE_DEBOUNCE_MS = 2_000;
const QUOTE_LIMIT = 800;
const RESYNC_ON_ATTACH = 10;
/** The reaction a voice memo wears while it's being heard, until pclaw reacts or answers. */
const TRANSCRIBING = "✍";
const POLL_TIMEOUT_SECONDS = 30;
const ALLOWED_UPDATES = ["message", "message_reaction"] as const;

export type TelegramUser = {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
};

export type TelegramChat = {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
};

export type TelegramPhotoSize = {
	file_id: string;
	file_unique_id?: string;
	width: number;
	height: number;
	file_size?: number;
};

export type TelegramVoice = {
	file_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
};

export type TelegramAudio = {
	file_id: string;
	duration?: number;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
};

export type TelegramDocument = {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
};

export type TelegramTextQuote = {
	text: string;
	position?: number;
	is_manual?: boolean;
};

export type TelegramMessage = {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
	caption?: string;
	media_group_id?: string;
	reply_to_message?: TelegramMessage;
	quote?: TelegramTextQuote;
	photo?: TelegramPhotoSize[];
	voice?: TelegramVoice;
	audio?: TelegramAudio;
	document?: TelegramDocument;
};

export type TelegramReactionType =
	| { type: "emoji"; emoji: string }
	| { type: "custom_emoji"; custom_emoji_id: string }
	| { type: "paid" };

export type TelegramMessageReactionUpdated = {
	chat: TelegramChat;
	message_id: number;
	user?: TelegramUser;
	date: number;
	old_reaction: TelegramReactionType[];
	new_reaction: TelegramReactionType[];
};

export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	message_reaction?: TelegramMessageReactionUpdated;
};

export type TelegramFile = {
	file_id: string;
	file_size?: number;
	file_path?: string;
};

type TelegramApiResponse<T> = {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
};

export class TelegramApiError extends Error {
	readonly method: string;
	readonly status: number;
	readonly description: string;
	readonly retryAfter?: number;

	constructor(method: string, status: number, description: string, retryAfter?: number) {
		super(`Telegram ${method} failed (${status}): ${description}`);
		this.name = "TelegramApiError";
		this.method = method;
		this.status = status;
		this.description = description;
		if (retryAfter !== undefined) this.retryAfter = retryAfter;
	}
}

export function isTelegramParseError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError) || error.status !== 400) return false;
	return /parse entities|can't find end of the entity|unsupported start tag|unexpected end tag/i.test(error.description);
}

export type OutboundFileInput =
	| string
	| { data: Uint8Array; filename: string; mimeType?: string };

/** `allow_sending_without_reply` so a reply to a deleted message still goes out instead of failing with a 400. */
export type TelegramReplyParameters = { message_id: number; allow_sending_without_reply?: boolean };

const replyParameters = (messageId: number): TelegramReplyParameters => ({ message_id: messageId, allow_sending_without_reply: true });

export type SendMediaOptions = {
	caption?: string;
	replyToMessageId?: number;
	disableNotification?: boolean;
};

export type TelegramApi = {
	getMe(signal?: AbortSignal): Promise<TelegramUser>;
	getUpdates(
		params: { offset?: number; timeout?: number; allowed_updates?: readonly string[] },
		signal?: AbortSignal,
	): Promise<TelegramUpdate[]>;
	sendMessage(
		params: {
			chat_id: number | string;
			text: string;
			parse_mode?: "HTML";
			link_preview_options?: { is_disabled: boolean };
			reply_parameters?: TelegramReplyParameters;
			disable_notification?: boolean;
		},
		signal?: AbortSignal,
	): Promise<TelegramMessage>;
	sendFormattedMessage(
		chatId: number | string,
		markdown: string,
		options?: { replyToMessageId?: number; disableNotification?: boolean; disableLinkPreview?: boolean },
		signal?: AbortSignal,
	): Promise<TelegramMessage[]>;
	sendChatAction(chatId: number | string, action: "typing" | "upload_document" | "upload_photo", signal?: AbortSignal): Promise<boolean>;
	setMessageReaction(chatId: number | string, messageId: number, emoji: string | undefined, signal?: AbortSignal): Promise<boolean>;
	deleteMessage(chatId: number | string, messageId: number, signal?: AbortSignal): Promise<boolean>;
	deleteMyCommands(signal?: AbortSignal): Promise<boolean>;
	getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile>;
	downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
	sendDocument(chatId: number | string, file: OutboundFileInput, options?: SendMediaOptions, signal?: AbortSignal): Promise<TelegramMessage>;
	sendPhoto(chatId: number | string, file: OutboundFileInput, options?: SendMediaOptions, signal?: AbortSignal): Promise<TelegramMessage>;
};

export function createTelegramApi(options: {
	token: string;
	apiBase?: string;
	fetchFn?: typeof fetch;
}): TelegramApi {
	const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
	const fetchFn = options.fetchFn ?? fetch;

	async function call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await fetchFn(`${base}/bot${options.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params ?? {}),
			...(signal === undefined ? {} : { signal }),
		});
		const payload = (await response.json().catch(() => undefined)) as TelegramApiResponse<T> | undefined;
		if (!response.ok || payload?.ok !== true) {
			throw new TelegramApiError(
				method,
				payload?.error_code ?? response.status,
				payload?.description ?? response.statusText ?? "unknown error",
				payload?.parameters?.retry_after,
			);
		}
		return payload.result as T;
	}

	async function sendMessage(
		params: {
			chat_id: number | string;
			text: string;
			parse_mode?: "HTML";
			link_preview_options?: { is_disabled: boolean };
			reply_parameters?: TelegramReplyParameters;
			disable_notification?: boolean;
		},
		signal?: AbortSignal,
	): Promise<TelegramMessage> {
		return call<TelegramMessage>("sendMessage", params, signal);
	}

	async function sendFormattedMessage(
		chatId: number | string,
		markdown: string,
		sendOptions?: { replyToMessageId?: number; disableNotification?: boolean; disableLinkPreview?: boolean },
		signal?: AbortSignal,
	): Promise<TelegramMessage[]> {
		const html = markdownToTelegramHtml(markdown);
		const chunks = splitTelegramHtml(html, TELEGRAM_MAX_MESSAGE);
		if (chunks.length === 0) return [];
		const linkPreview = { is_disabled: sendOptions?.disableLinkPreview ?? true };
		const sent: TelegramMessage[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const reply = index === 0 && sendOptions?.replyToMessageId !== undefined ? { reply_parameters: replyParameters(sendOptions.replyToMessageId) } : {};
			const silent = sendOptions?.disableNotification === true ? { disable_notification: true } : {};
			try {
				const message = await sendMessage(
					{ chat_id: chatId, text: chunk, parse_mode: "HTML", link_preview_options: linkPreview, ...reply, ...silent },
					signal,
				);
				sent.push(message);
			} catch (error) {
				if (!isTelegramParseError(error)) throw error;
				console.warn(
					`[pclaw] Telegram sendMessage HTML parse fallback to plain text: ${error instanceof TelegramApiError ? error.description : String(error)}`,
				);
				// Plain-text fallback so Telegram 400 entity parse errors never drop a reply.
				const plainChunks = splitPlainText(stripTelegramHtml(chunk), TELEGRAM_MAX_MESSAGE);
				for (const [plainIdx, plain] of plainChunks.entries()) {
					const plainReply = index === 0 && plainIdx === 0 ? reply : {};
					const message = await sendMessage(
						{ chat_id: chatId, text: plain, link_preview_options: linkPreview, ...plainReply, ...silent },
						signal,
					);
					sent.push(message);
				}
			}
		}
		return sent;
	}

	async function uploadMedia(
		method: "sendDocument" | "sendPhoto",
		fieldName: "document" | "photo",
		chatId: number | string,
		file: OutboundFileInput,
		sendOptions?: SendMediaOptions,
		signal?: AbortSignal,
	): Promise<TelegramMessage> {
		const resolved =
			typeof file === "string"
				? { data: new Uint8Array(readFileSync(file)), filename: basename(file), mimeType: mimeFromPath(file) }
				: { data: new Uint8Array(file.data), filename: file.filename, mimeType: file.mimeType ?? mimeFromPath(file.filename) };

		const buildForm = (caption: string | undefined, parseMode: "HTML" | undefined) => {
			const form = new FormData();
			form.set("chat_id", String(chatId));
			form.set(fieldName, new Blob([resolved.data], { type: resolved.mimeType }), resolved.filename);
			if (caption !== undefined && caption !== "") {
				form.set("caption", caption);
				if (parseMode !== undefined) form.set("parse_mode", parseMode);
			}
			if (sendOptions?.replyToMessageId !== undefined) {
				form.set("reply_parameters", JSON.stringify(replyParameters(sendOptions.replyToMessageId)));
			}
			if (sendOptions?.disableNotification === true) form.set("disable_notification", "true");
			return form;
		};

		const sendForm = async (form: FormData) => {
			const response = await fetchFn(`${base}/bot${options.token}/${method}`, {
				method: "POST",
				body: form,
				...(signal === undefined ? {} : { signal }),
			});
			const payload = (await response.json().catch(() => undefined)) as TelegramApiResponse<TelegramMessage> | undefined;
			if (!response.ok || payload?.ok !== true) {
				throw new TelegramApiError(
					method,
					payload?.error_code ?? response.status,
					payload?.description ?? response.statusText ?? "unknown error",
					payload?.parameters?.retry_after,
				);
			}
			return payload.result as TelegramMessage;
		};

		const rawCaption = sendOptions?.caption?.trim();
		const htmlCaption =
			rawCaption !== undefined && rawCaption !== ""
				? splitTelegramHtml(markdownToTelegramHtml(rawCaption), TELEGRAM_MAX_CAPTION)[0]
				: undefined;

		try {
			return await sendForm(buildForm(htmlCaption, htmlCaption === undefined ? undefined : "HTML"));
		} catch (error) {
			if (!isTelegramParseError(error) || htmlCaption === undefined) throw error;
			console.warn(
				`[pclaw] Telegram ${method} HTML parse fallback to plain text: ${error instanceof TelegramApiError ? error.description : String(error)}`,
			);
			const plainCaption = splitPlainText(stripTelegramHtml(htmlCaption), TELEGRAM_MAX_CAPTION)[0];
			return sendForm(buildForm(plainCaption, undefined));
		}
	}

	return {
		getMe: (signal) => call<TelegramUser>("getMe", undefined, signal),
		getUpdates: (params, signal) => call<TelegramUpdate[]>("getUpdates", params, signal),
		sendMessage,
		sendFormattedMessage,
		sendChatAction: (chatId, action, signal) => call<boolean>("sendChatAction", { chat_id: chatId, action }, signal),
		setMessageReaction: (chatId, messageId, emoji, signal) => {
			const normalized = emoji === undefined ? undefined : normalizeTelegramReaction(emoji);
			return call<boolean>(
				"setMessageReaction",
				{
					chat_id: chatId,
					message_id: messageId,
					reaction: normalized === undefined ? [] : [{ type: "emoji", emoji: normalized }],
				},
				signal,
			);
		},
		deleteMessage: async (chatId, messageId, signal) => {
			try {
				return await call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId }, signal);
			} catch (error) {
				if (error instanceof TelegramApiError && error.status === 400) return false;
				throw error;
			}
		},
		deleteMyCommands: (signal) => call<boolean>("deleteMyCommands", {}, signal),
		getFile: (fileId, signal) => call<TelegramFile>("getFile", { file_id: fileId }, signal),
		downloadFile: async (filePath, signal) => {
			const response = await fetchFn(`${base}/file/bot${options.token}/${filePath.replace(/^\/+/, "")}`, {
				...(signal === undefined ? {} : { signal }),
			});
			if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
			return new Uint8Array(await response.arrayBuffer());
		},
		sendDocument: (chatId, file, sendOptions, signal) => uploadMedia("sendDocument", "document", chatId, file, sendOptions, signal),
		sendPhoto: (chatId, file, sendOptions, signal) => uploadMedia("sendPhoto", "photo", chatId, file, sendOptions, signal),
	};
}

/**
 * How pclaw maps Telegram chats onto Pi Durable conversations:
 *   telegram:dm:<userId>      a private chat (DM): one long conversation
 *   telegram:group:<chatId>   an allowlisted group or supergroup: one long conversation
 */
export const telegramAddress = {
	dm: (userId: string | number) => `telegram:dm:${userId}`,
	group: (chatId: string | number) => `telegram:group:${chatId}`,
};

export function parseTelegramAddress(addr: string): { kind: "dm" | "group"; chatId: string } | undefined {
	const [channel, kind, id] = addr.split(":");
	if (channel !== "telegram" || id === undefined || id === "") return undefined;
	if (kind !== "dm" && kind !== "group") return undefined;
	return { kind, chatId: id };
}

/**
 * Where to show typing in Telegram while background workers or jobs run, matching Discord's rule:
 * no activity means nothing is happening.
 */
export function telegramTypingTargets(
	conversations: { address: string; workers: { status: string }[] }[],
	jobs: Pick<Job, "origin" | "background" | "state" | "worker" | "discordThreadId">[],
): string[] {
	const running = jobs.filter((job) => job.state === "working" && job.origin.startsWith("telegram:"));
	const workers = conversations
		.filter(({ address, workers }) => address.startsWith("telegram:") && workers.some((worker) => worker.status === "working"))
		.map(({ address }) => address);
	const jobOrigins = running.map((job) => job.origin);
	return [...new Set([...workers, ...jobOrigins])];
}

export type TelegramAuthState = {
	ownerId?: string;
	allowedUsers: ReadonlySet<string>;
	allowedGroups: ReadonlySet<string>;
	/** When true (e.g. `users` is configured), never auto-pair an unmapped sender on first DM. */
	disablePairing?: boolean;
};

export type TelegramAuthResult =
	| { allowed: false }
	| { allowed: true; pairedOwnerId?: string; addr: string; label: string; isGroup: boolean };

/**
 * Authorize an inbound Telegram message.
 * - Bots and messages without `from` are ignored.
 * - In private chats: if `allowedUsers` is non-empty, sender must be in `allowedUsers` (or `ownerId`).
 *   Otherwise if `ownerId` is set, sender must match `ownerId`.
 *   Otherwise (unpaired instance with no allowlist and pairing enabled), the first private sender pairs as `ownerId`.
 * - In groups/supergroups: group chat id must be in `allowedGroups` AND sender must be an authorized user.
 *   Pairing never happens in groups.
 */
export function authorizeTelegramMessage(message: TelegramMessage, state: TelegramAuthState): TelegramAuthResult {
	if (message.from === undefined || message.from.is_bot === true) return { allowed: false };
	const userId = String(message.from.id);
	const chatId = String(message.chat.id);
	const hasAllowlist = state.allowedUsers.size > 0;
	const isKnownAllowedUser = hasAllowlist
		? state.allowedUsers.has(userId) || (state.ownerId !== undefined && userId === state.ownerId)
		: state.ownerId !== undefined && userId === state.ownerId;

	if (message.chat.type === "private") {
		if (!hasAllowlist && state.ownerId === undefined && state.disablePairing !== true) {
			return { allowed: true, pairedOwnerId: userId, addr: telegramAddress.dm(chatId), label: "Telegram DM", isGroup: false };
		}
		if (!isKnownAllowedUser) return { allowed: false };
		return { allowed: true, addr: telegramAddress.dm(chatId), label: "Telegram DM", isGroup: false };
	}

	if (message.chat.type === "group" || message.chat.type === "supergroup") {
		if (!state.allowedGroups.has(chatId)) return { allowed: false };
		if (!isKnownAllowedUser) return { allowed: false };
		return {
			allowed: true,
			addr: telegramAddress.group(chatId),
			label: message.chat.title ?? `Telegram group ${chatId}`,
			isGroup: true,
		};
	}

	return { allowed: false };
}

/** Which transcript entry and text snippet each outbound Telegram message came from, for inbound reaction handling. */
const TelegramSentMessages = defineDoc<{
	messages: Record<string, { conversation: ConversationId; entry: EntryId; text: string; date: number }>;
}>({
	kind: "pclaw.telegram-sent",
	version: 1,
	scope: "session",
	initial: () => ({ messages: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

const clip = (text: string) => (text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text);

function senderName(user: TelegramUser | undefined): string {
	if (user === undefined) return "someone";
	const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	if (full !== "") return full;
	return user.username !== undefined ? `@${user.username}` : `user ${user.id}`;
}

/**
 * Extract `[replying to ...]` / `[quoting ...]` context from `reply_to_message` and `quote`. A replied-to photo or file
 * keeps its label even when it had a caption, and `savedAt` (where pclaw saved it) is named when given.
 */
export function extractReplyContext(
	message: TelegramMessage,
	botId: number | undefined,
	timeZone: string,
	savedAt?: string,
): string[] {
	const reply = message.reply_to_message;
	const quoteText = message.quote?.text?.trim();
	if (reply === undefined && (quoteText === undefined || quoteText === "")) return [];

	const whose =
		reply?.from === undefined
			? "an earlier"
			: reply.from.id === botId
				? "your"
				: message.from !== undefined && reply.from.id === message.from.id
					? "their own"
					: `${senderName(reply.from)}'s`;

	const when = reply?.date === undefined ? "" : ` from ${stamp(reply.date * 1000, timeZone)}`;

	const what =
		reply === undefined ? "message"
		: reply.photo !== undefined && reply.photo.length > 0 ? "photo"
		: reply.document !== undefined ? `file "${reply.document.file_name ?? "document"}"`
		: reply.voice !== undefined || reply.audio !== undefined ? "voice message"
		: "message";
	const saved = savedAt === undefined ? "" : ` (saved at ${savedAt})`;

	if (quoteText !== undefined && quoteText !== "") {
		return [`[quoting ${whose} ${what}${when}${saved}: "${clip(quoteText)}"]`];
	}

	if (reply === undefined) return [];
	const body = (reply.text ?? reply.caption ?? "").trim();
	if (body !== "") return [`[replying to ${whose} ${what}${when}${saved}: "${clip(body)}"]`];
	if (what !== "message") return [`[replying to ${whose} ${what}${when}${saved}]`];
	return [];
}

/**
 * Debounce Telegram media-group albums (`media_group_id`). Telegram delivers each photo/document in an album
 * as a separate `message` update; batching them over ~600ms keeps the whole album in one agent turn.
 */
export function createMediaGroupBuffer(options: {
	delayMs?: number;
	onFlush: (messages: TelegramMessage[]) => void | Promise<void>;
	onError?: (error: unknown) => void;
}) {
	const delayMs = options.delayMs ?? MEDIA_GROUP_DEBOUNCE_MS;
	const pending = new Map<string, { messages: TelegramMessage[]; timer: NodeJS.Timeout }>();
	const inFlight = new Set<Promise<void>>();

	const runFlush = (key: string) => {
		const entry = pending.get(key);
		if (entry === undefined) return;
		pending.delete(key);
		clearTimeout(entry.timer);
		const promise = Promise.resolve()
			.then(() => options.onFlush(entry.messages))
			.catch((error: unknown) => {
				if (options.onError !== undefined) options.onError(error);
				else console.error("[pclaw] telegram media group flush failed", error);
			})
			.finally(() => {
				inFlight.delete(promise);
			});
		inFlight.add(promise);
	};

	return {
		add(message: TelegramMessage) {
			const key = `${message.chat.id}:${message.media_group_id!}`;
			const existing = pending.get(key);
			if (existing !== undefined) {
				existing.messages.push(message);
				clearTimeout(existing.timer);
				existing.timer = setTimeout(() => runFlush(key), delayMs);
				return;
			}
			const timer = setTimeout(() => runFlush(key), delayMs);
			pending.set(key, { messages: [message], timer });
		},
		async flushAll() {
			for (const key of [...pending.keys()]) runFlush(key);
			await Promise.all([...inFlight]);
		},
		stop() {
			for (const entry of pending.values()) clearTimeout(entry.timer);
			pending.clear();
		},
	};
}

function isCaptionlessMediaBatch(messages: readonly TelegramMessage[]): boolean {
	if (messages.length === 0) return false;
	return messages.every((msg) => {
		const hasMedia = msg.document !== undefined || (msg.photo !== undefined && msg.photo.length > 0);
		const hasAudio = msg.voice !== undefined || msg.audio !== undefined;
		const hasText = (msg.text ?? msg.caption ?? "").trim() !== "";
		return hasMedia && !hasAudio && !hasText;
	});
}

/**
 * Briefly hold a captionless document/photo (~2s default) so if the same user sends their instruction text
 * right after the file, both merge into one turn instead of kicking off a bare-file worker prematurely.
 */
export function createCaptionlessFileBuffer(options: {
	delayMs?: number;
	onFlush: (messages: TelegramMessage[]) => void | Promise<void>;
	onError?: (error: unknown) => void;
}) {
	const delayMs = options.delayMs ?? CAPTIONLESS_FILE_DEBOUNCE_MS;
	const pending = new Map<string, { messages: TelegramMessage[]; timer: NodeJS.Timeout }>();
	const inFlight = new Set<Promise<void>>();

	const dispatch = (messages: TelegramMessage[]) => {
		const promise = Promise.resolve()
			.then(() => options.onFlush(messages))
			.catch((error: unknown) => {
				if (options.onError !== undefined) options.onError(error);
				else console.error("[pclaw] telegram captionless file flush failed", error);
			})
			.finally(() => {
				inFlight.delete(promise);
			});
		inFlight.add(promise);
	};

	const flushKey = (key: string) => {
		const entry = pending.get(key);
		if (entry === undefined) return;
		pending.delete(key);
		clearTimeout(entry.timer);
		dispatch(entry.messages);
	};

	return {
		enqueue(messages: TelegramMessage[]) {
			const primary = messages[0];
			if (primary === undefined) return;
			if (delayMs <= 0) {
				dispatch(messages);
				return;
			}
			const key = `${primary.chat.id}:${primary.from?.id ?? "anon"}`;
			const existing = pending.get(key);
			if (existing !== undefined) {
				const merged = [...existing.messages, ...messages];
				if (isCaptionlessMediaBatch(messages)) {
					existing.messages = merged;
					clearTimeout(existing.timer);
					existing.timer = setTimeout(() => flushKey(key), delayMs);
					return;
				}
				// User sent follow-up text (or captioned media): merge and flush right away.
				pending.delete(key);
				clearTimeout(existing.timer);
				dispatch(merged);
				return;
			}
			if (isCaptionlessMediaBatch(messages)) {
				const timer = setTimeout(() => flushKey(key), delayMs);
				pending.set(key, { messages: [...messages], timer });
				return;
			}
			dispatch(messages);
		},
		async flushAll() {
			for (const key of [...pending.keys()]) flushKey(key);
			await Promise.all([...inFlight]);
		},
		stop() {
			for (const entry of pending.values()) clearTimeout(entry.timer);
			pending.clear();
		},
	};
}

function mimeFromPath(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".pdf":
			return "application/pdf";
		case ".ogg":
		case ".oga":
			return "audio/ogg";
		case ".mp3":
			return "audio/mpeg";
		case ".m4a":
			return "audio/mp4";
		case ".wav":
			return "audio/wav";
		case ".txt":
			return "text/plain";
		case ".json":
			return "application/json";
		case ".csv":
			return "text/csv";
		default:
			return "application/octet-stream";
	}
}

function sanitizeFilename(name: string): string {
	const base = basename(name).replace(/[\x00-\x1f/\\:*?"<>|]/g, "_").trim();
	return base === "" || base === "." || base === ".." ? "file" : base.slice(0, 120);
}

function saveToInbox(
	inboxDir: string,
	message: Pick<TelegramMessage, "chat" | "message_id">,
	originalName: string,
	bytes: Uint8Array,
): string {
	mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
	const safe = sanitizeFilename(originalName);
	const savedName = `tg-${message.chat.id}-${message.message_id}-${safe}`;
	const savedPath = join(inboxDir, savedName);
	writeFileSync(savedPath, bytes, { mode: 0o600 });
	return savedPath;
}

function photoExtension(mime: string): string {
	switch (mime) {
		case "image/png":
			return ".png";
		case "image/webp":
			return ".webp";
		case "image/gif":
			return ".gif";
		default:
			return ".jpg";
	}
}

/**
 * Save a compressed Telegram photo to the inbox (and stage it to the user's workspace when a hook is given)
 * so workers can open the file by path. Returns the note for the user turn; never throws, because the inline
 * image already reached the front model.
 */
async function savePhoto(
	inboxDir: string,
	message: TelegramMessage,
	mime: string,
	bytes: Uint8Array,
	stageFile: BuildInputOptions["stageFile"],
): Promise<string> {
	const name = `photo-${message.message_id}${photoExtension(mime)}`;
	let savedPath: string;
	try {
		savedPath = saveToInbox(inboxDir, message, name, bytes);
	} catch (error) {
		console.error("[pclaw] couldn't save Telegram photo to inbox", error);
		return `[attached photo "${name}" (${mime}, ${bytes.byteLength} bytes), shown inline but not saved to a file]`;
	}
	if (stageFile === undefined) return `[attached photo "${name}" (${mime}, ${bytes.byteLength} bytes), saved at ${savedPath}]`;
	try {
		const stagedPath = await stageFile(savedPath, basename(savedPath));
		return `[attached photo "${name}" (${mime}, ${bytes.byteLength} bytes), saved at ${stagedPath}]`;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn("[pclaw] couldn't stage Telegram photo to sandbox", error);
		return `[attached photo "${name}" (${mime}, ${bytes.byteLength} bytes), saved locally at ${savedPath}, but staging to workspace failed: ${reason}]`;
	}
}

/** A file pclaw already saved for this Telegram message, if any (`tg-<chat>-<message>-<name>`). */
function findInInbox(inboxDir: string, chatId: number, messageId: number): string | undefined {
	const prefix = `tg-${chatId}-${messageId}-`;
	try {
		const name = readdirSync(inboxDir).find((each) => each.startsWith(prefix));
		return name === undefined ? undefined : join(inboxDir, name);
	} catch {
		return undefined;
	}
}

/**
 * When they swipe-reply to an earlier photo or file, bring it back: reuse the copy saved in the inbox (or download it
 * again, for ones from before pclaw saved photos), stage it to their workspace, and show images inline again so the
 * front model sees what they're pointing at. Never throws: the text of the reply context still goes in.
 */
async function replyMedia(
	message: TelegramMessage,
	inboxDir: string,
	options: Pick<BuildInputOptions, "api" | "stageFile">,
): Promise<{ savedAt?: string; image?: ImageContent }> {
	const reply = message.reply_to_message;
	if (reply === undefined) return {};
	const photo = reply.photo !== undefined && reply.photo.length > 0 ? reply.photo[reply.photo.length - 1]! : undefined;
	const doc = reply.document;
	if (photo === undefined && doc === undefined) return {};
	const limit = photo !== undefined ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
	const size = photo?.file_size ?? doc?.file_size;
	if (size !== undefined && size > limit) return {};
	const chatId = message.chat.id;
	try {
		let localPath = findInInbox(inboxDir, chatId, reply.message_id);
		let bytes: Uint8Array;
		let mime: string;
		if (localPath !== undefined) {
			bytes = new Uint8Array(readFileSync(localPath));
			mime = doc?.mime_type ?? mimeFromPath(localPath);
		} else {
			const file = await options.api.getFile((photo ?? doc)!.file_id);
			if (file.file_path === undefined) throw new Error("Telegram returned no file path");
			bytes = await options.api.downloadFile(file.file_path);
			if (bytes.byteLength > limit) return {};
			if (photo !== undefined) {
				const detected = mimeFromPath(file.file_path);
				mime = detected.startsWith("image/") ? detected : "image/jpeg";
			} else {
				mime = doc!.mime_type ?? mimeFromPath(doc!.file_name ?? file.file_path);
			}
			const name = photo !== undefined ? `photo-${reply.message_id}${photoExtension(mime)}` : (doc!.file_name ?? `document-${reply.message_id}`);
			localPath = saveToInbox(inboxDir, { chat: message.chat, message_id: reply.message_id }, name, bytes);
		}
		const imageMime = photo !== undefined && !mime.startsWith("image/") ? "image/jpeg" : mime.split(";")[0]!;
		const image: ImageContent | undefined =
			imageMime.startsWith("image/") && bytes.byteLength <= MAX_IMAGE_BYTES
				? { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: imageMime }
				: undefined;
		let savedAt: string | undefined = localPath;
		if (options.stageFile !== undefined) {
			try {
				savedAt = await options.stageFile(localPath, basename(localPath));
			} catch (error) {
				console.warn(`[pclaw] couldn't stage a replied-to Telegram file: ${error instanceof Error ? error.message : String(error)}`);
				savedAt = undefined;
			}
		}
		return { ...(savedAt === undefined ? {} : { savedAt }), ...(image === undefined ? {} : { image }) };
	} catch (error) {
		console.warn(`[pclaw] couldn't bring back a replied-to Telegram file: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

export type BuildInputOptions = {
	/** `setMessageReaction` and `sendMessage` drive voice-memo feedback (✍, the transcript quote); without them it's skipped. */
	api: Pick<TelegramApi, "getFile" | "downloadFile" | "sendChatAction"> & Partial<Pick<TelegramApi, "setMessageReaction" | "sendMessage">>;
	timeZone: string;
	botId?: number;
	inboxDir?: string;
	voiceDir?: string;
	speechUrl?: string;
	isGroup?: boolean;
	extraContext?: string[];
	/** Optional remote staging hook (e.g. `sandbox.putFile` for SSH VM users); returns the sandbox path. */
	stageFile?: (localPath: string, filename: string) => Promise<string>;
	transcribeFn?: typeof transcribe;
	onVoiceResult?: (result: { id: string; ok: true; seconds: number; ms: number; words: number } | { id: string; ok: false; error: string }) => void;
};

/**
 * Normalize one Telegram message (or a batched album of messages sharing `media_group_id`) into a `UserInput`
 * for Pi Durable, handling photos (`ImageContent` <= 10 MB, also saved to inbox), voice/audio transcription (`speechUrl`),
 * documents (<= 20 MB saved to inbox), and reply/quote context.
 */
export async function buildTelegramUserInput(
	messages: readonly TelegramMessage[],
	options: BuildInputOptions,
): Promise<{ content: UserInput; plainText: string; hasVoice: boolean; heardVoiceRefs: string[] }> {
	const primary = messages[0]!;
	/** Voice memos heard and quoted back, still wearing ✍ until pclaw reacts or answers. */
	const heardVoiceRefs: string[] = [];
	const parts: (TextContent | ImageContent)[] = [];
	const textLines: string[] = [];
	const notes: string[] = [];
	let hasVoice = false;

	const inboxDir = options.inboxDir ?? paths.inbox;
	const voiceDir = options.voiceDir ?? paths.voice;
	const transcribeFn = options.transcribeFn ?? transcribe;

	// Extract reply/quote context from the first message in the batch that carries one. A replied-to photo or file
	// comes back too: inline for images, and saved where workers can open it.
	const replyLines: string[] = [];
	for (const message of messages) {
		if (extractReplyContext(message, options.botId, options.timeZone).length === 0) continue;
		const media = await replyMedia(message, inboxDir, options);
		replyLines.push(...extractReplyContext(message, options.botId, options.timeZone, media.savedAt));
		if (media.image !== undefined) parts.push(media.image);
		break;
	}

	for (const message of messages) {
		const body = (message.text ?? message.caption ?? "").trim();
		if (body !== "") textLines.push(body);

		// 1. Photos: pick largest PhotoSize (photo[-1]), <= 10 MB -> ImageContent, plus a saved (and staged) file for workers.
		if (message.photo !== undefined && message.photo.length > 0) {
			const largest = message.photo[message.photo.length - 1]!;
			if (largest.file_size !== undefined && largest.file_size > MAX_IMAGE_BYTES) {
				notes.push(`[attached photo (${largest.file_size} bytes), larger than the 10 MB image limit]`);
			} else {
				try {
					const file = await options.api.getFile(largest.file_id);
					if (file.file_path === undefined) {
						notes.push("[attached photo, but Telegram returned no file path]");
					} else {
						const bytes = await options.api.downloadFile(file.file_path);
						if (bytes.byteLength > MAX_IMAGE_BYTES) {
							notes.push(`[attached photo (${bytes.byteLength} bytes), larger than the 10 MB image limit]`);
						} else {
							const detected = mimeFromPath(file.file_path);
							const mime = detected.startsWith("image/") ? detected : "image/jpeg";
							parts.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime });
							notes.push(await savePhoto(inboxDir, message, mime, bytes, options.stageFile));
						}
					}
				} catch (error) {
					console.error("[pclaw] couldn't download Telegram photo", error);
					notes.push("[attached photo, but pclaw couldn't download it]");
				}
			}
		}

		// 2. Voice / audio -> transcribe via speechUrl.
		const audioMedia = message.voice ?? message.audio;
		if (audioMedia !== undefined) {
			const isVoice = message.voice !== undefined;
			const id = `telegram:${message.message_id}`;
			if (options.speechUrl === undefined) {
				notes.push(isVoice ? "[sent a voice memo, but pclaw has no speech server configured]" : "[sent an audio file, but pclaw has no speech server configured]");
			} else if (audioMedia.file_size !== undefined && audioMedia.file_size > MAX_FILE_BYTES) {
				notes.push("[sent an audio message larger than Telegram's 20 MB Bot API download limit]");
			} else {
				const chatId = message.chat.id;
				// Show it's being heard right away; a reaction that fails never holds up the transcript.
				const marked = options.api.setMessageReaction?.(chatId, message.message_id, TRANSCRIBING).catch(() => false);
				const unmark = async () => {
					await marked;
					await options.api.setMessageReaction?.(chatId, message.message_id, undefined).catch(() => undefined);
				};
				const ping = () => void options.api.sendChatAction(chatId, "typing").catch(() => undefined);
				ping();
				const typing = setInterval(ping, TYPING_REFRESH_MS);
				try {
					const file = await options.api.getFile(audioMedia.file_id);
					if (file.file_path === undefined) throw new Error("Telegram returned no file_path");
					const audio = await options.api.downloadFile(file.file_path);
					if (audio.byteLength > MAX_FILE_BYTES) throw new Error("audio exceeds 20 MB limit");
					const ext = extname(file.file_path) || ".ogg";
					mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
					writeFileSync(join(voiceDir, `telegram-${chatId}-${message.message_id}${ext}`), audio, { mode: 0o600 });
					const heard: Heard = await transcribeFn(options.speechUrl, audio);
					hasVoice = true;
					options.onVoiceResult?.({
						id,
						ok: true,
						seconds: heard.seconds,
						ms: heard.ms,
						words: heard.text.split(/\s+/).filter(Boolean).length,
					});
					console.log(`[pclaw] heard a ${Math.round(heard.seconds)}s Telegram voice memo in ${heard.ms}ms`);
					notes.push(memoLabel(heard.seconds), heard.text);
					if (heard.text.trim() === "") {
						await unmark();
					} else {
						// The transcript stays in the chat as a quiet quote under the memo. It isn't a reply, so it leaves
						// ReplyThreads alone: the answer right under it still goes out plain.
						await options.api
							.sendMessage?.({
								chat_id: chatId,
								text: transcriptQuoteHtml(heard.text),
								parse_mode: "HTML",
								reply_parameters: replyParameters(message.message_id),
								disable_notification: true,
								link_preview_options: { is_disabled: true },
							})
							.catch((error: unknown) =>
								console.warn(`[pclaw] couldn't post a Telegram voice transcript: ${error instanceof Error ? error.message : String(error)}`),
							);
						heardVoiceRefs.push(id);
					}
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					options.onVoiceResult?.({ id, ok: false, error: reason });
					console.error(`[pclaw] couldn't hear a Telegram voice memo: ${reason}`);
					notes.push("[sent a voice memo, but pclaw couldn't transcribe it]");
					await unmark();
				} finally {
					clearInterval(typing);
				}
			}
		}

		// 3. Documents (PDFs, archives, uncompressed images, code files, etc.) <= 20 MB -> save to inbox.
		if (message.document !== undefined) {
			const doc = message.document;
			const name = doc.file_name ?? `document-${message.message_id}`;
			const mime = doc.mime_type ?? mimeFromPath(name);
			if (doc.file_size !== undefined && doc.file_size > MAX_FILE_BYTES) {
				notes.push(`[attached file "${name}" (${mime}, ${doc.file_size} bytes), too large for Telegram Bot API download (20 MB limit)]`);
			} else {
				try {
					const file = await options.api.getFile(doc.file_id);
					if (file.file_path === undefined) {
						notes.push(`[attached file "${name}" (${mime}), but Telegram returned no file path]`);
					} else {
						const bytes = await options.api.downloadFile(file.file_path);
						if (bytes.byteLength > MAX_FILE_BYTES) {
							notes.push(`[attached file "${name}" (${mime}, ${bytes.byteLength} bytes), too large for Telegram Bot API download (20 MB limit)]`);
						} else {
							const savedPath = saveToInbox(inboxDir, message, name, bytes);
							if (mime.startsWith("image/") && bytes.byteLength <= MAX_IMAGE_BYTES) {
								parts.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime.split(";")[0]! });
							}
							if (options.stageFile !== undefined) {
								try {
									const stagedPath = await options.stageFile(savedPath, basename(savedPath));
									notes.push(`[attached file "${name}" (${mime}, ${bytes.byteLength} bytes), saved at ${stagedPath}]`);
								} catch (stageError) {
									const reason = stageError instanceof Error ? stageError.message : String(stageError);
									console.error("[pclaw] couldn't stage Telegram document to sandbox", stageError);
									notes.push(
										`[attached file "${name}" (${mime}, ${bytes.byteLength} bytes), saved locally at ${savedPath}, but staging to workspace failed: ${reason}]`,
									);
								}
							} else {
								notes.push(`[attached file "${name}" (${mime}, ${bytes.byteLength} bytes), saved at ${savedPath}]`);
							}
						}
					}
				} catch (error) {
					console.error("[pclaw] couldn't download Telegram document", error);
					notes.push(`[attached file "${name}" (${mime}), but pclaw couldn't download it]`);
				}
			}
		}
	}

	const header = `[${stamp(primary.date * 1000, options.timeZone)}]`;
	const groupPrefix = options.isGroup === true ? `[from ${senderName(primary.from)}]` : undefined;
	const combinedText = [
		header,
		groupPrefix,
		...replyLines,
		...(options.extraContext ?? []),
		...textLines,
		...notes,
	]
		.filter((line): line is string => line !== undefined && line !== "")
		.join("\n");

	const plainText = [...textLines, ...notes].filter(Boolean).join("\n");
	const content: UserInput = parts.length === 0 ? combinedText : [{ type: "text", text: combinedText }, ...parts];
	return { content, plainText, hasVoice, heardVoiceRefs };
}

export type StartTelegramOptions = {
	apiBase?: string;
	fetchFn?: typeof fetch;
	mediaGroupDelayMs?: number;
	captionlessDebounceMs?: number;
	pollTimeoutSeconds?: number;
	inboxDir?: string;
	voiceDir?: string;
	transcribeFn?: typeof transcribe;
	onOwnerPaired?: (ownerId: string) => void;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function addedReactionEmoji(update: TelegramMessageReactionUpdated): string | undefined {
	const oldSet = new Set(
		update.old_reaction.flatMap((r) => (r.type === "emoji" ? [r.emoji] : [])),
	);
	for (const reaction of update.new_reaction) {
		if (reaction.type === "emoji" && !oldSet.has(reaction.emoji)) return reaction.emoji;
	}
	return undefined;
}

/**
 * pclaw on Telegram via Bot API long polling (`getUpdates`).
 * Answers authorized users in private chats (`telegram:dm:<userId>`) and allowlisted groups (`telegram:group:<chatId>`).
 * When neither `telegramOwnerId` nor `telegramAllowedUsers` is configured, the first person to DM the bot pairs as owner.
 */
export async function startTelegram(
	agent: Agent,
	config: Config,
	context: Context,
	options: StartTelegramOptions = {},
): Promise<{ stop(): Promise<void>; api: TelegramApi }> {
	if (config.telegramToken === undefined) throw new Error("No Telegram token configured.");

	const api = createTelegramApi({
		token: config.telegramToken,
		...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
		...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
	});

	let ownerId = config.telegramOwnerId;
	const allowedUsers = new Set([...config.telegramAllowedUsers, ...agent.users.allowedExternalIds("telegram")]);
	const allowedGroups = new Set(config.telegramAllowedGroups);
	const { jobs } = agent;
	const me = await api.getMe();
	console.log(`[pclaw] on Telegram as ${me.username !== undefined ? `@${me.username}` : me.id}`);
	await api.deleteMyCommands().catch((error: unknown) =>
		console.warn(`[pclaw] Telegram deleteMyCommands failed: ${error instanceof Error ? error.message : error}`),
	);
	if (ownerId === undefined && allowedUsers.size === 0 && !agent.users.enabled) {
		console.log("[pclaw] Waiting for a Telegram DM. The first person to message it becomes its owner.");
	}

	/** Ephemeral status bubbles & delegate acks in Telegram DMs, dissolved when replaced or when the final answer lands. */
	type EphemeralState = {
		ackMessageIds: number[];
		progressMessageId?: number;
		userSpokeAfterAck: boolean;
		pendingFinish: boolean;
	};
	const ephemeral = new Map<string, EphemeralState>();
	const ephemeralFor = (addr: string): EphemeralState => {
		let state = ephemeral.get(addr);
		if (state === undefined) {
			state = { ackMessageIds: [], userSpokeAfterAck: false, pendingFinish: false };
			ephemeral.set(addr, state);
		}
		return state;
	};
	const deleteEphemeralIds = async (chatId: string | number, ids: number[]) => {
		for (const messageId of ids) {
			await api.deleteMessage(chatId, messageId).catch((error: unknown) =>
				console.warn(`[pclaw] Telegram deleteMessage ${messageId} failed: ${error instanceof Error ? error.message : error}`),
			);
		}
	};

	/** Which ask each chat is on, so replies leave breadcrumbs back to their topic once topics interleave. */
	const threads = new ReplyThreads("telegram");

	/**
	 * Address -> refs ("telegram:<id>") of voice memos still wearing ✍. A reaction from pclaw (the model's `react`, a
	 * worker starting) replaces it on its own; when the answer goes out without one, or the run ends in silence, ✍ comes off.
	 */
	const transcribingVoiceRefs = new Map<string, Set<string>>();
	async function settleVoiceMemos(addr: string, conversation: Conversation, refs: readonly string[]): Promise<void> {
		const pending = transcribingVoiceRefs.get(addr);
		const parsed = parseTelegramAddress(addr);
		if (pending === undefined || parsed === undefined) return;
		const settled = refs.filter((ref) => pending.delete(ref));
		if (pending.size === 0) transcribingVoiceRefs.delete(addr);
		if (settled.length === 0) return;
		const asks = (await agent.harness.snapshot(Reactions, conversation.id, context))?.asks ?? {};
		for (const ref of settled) {
			if (asks[ref] !== undefined) continue;
			await api
				.setMessageReaction(parsed.chatId, Number(ref.slice("telegram:".length)), undefined)
				.catch((error: unknown) => console.warn(`[pclaw] couldn't clear ✍ on ${ref}: ${error instanceof Error ? error.message : error}`));
		}
	}

	const unregisterProgress = agent.progressSurfaces.register("telegram", {
		async update({ address, message, replyTo, silent }) {
			const parsed = parseTelegramAddress(address);
			if (parsed === undefined || parsed.kind !== "dm") return;
			const state = ephemeralFor(address);
			if (state.progressMessageId !== undefined) {
				const previous = state.progressMessageId;
				delete state.progressMessageId;
				await deleteEphemeralIds(parsed.chatId, [previous]);
			}
			// Once they've talked about something else, an update quotes the ask it's about.
			const quoted = threads.target(address, replyTo, { forceQuote: state.userSpokeAfterAck || silent === true });
			const sent = await api.sendFormattedMessage(parsed.chatId, message, {
				disableNotification: silent === true,
				disableLinkPreview: true,
				...(quoted === undefined ? {} : { replyToMessageId: Number(quoted) }),
			});
			const lastId = sent.at(-1)?.message_id;
			if (lastId !== undefined) state.progressMessageId = lastId;
			// The chat is on the work's topic now, so the next side-chat reply quotes its own ask.
			threads.sent(address, replyTo);
		},
		async finish({ address }) {
			const parsed = parseTelegramAddress(address);
			if (parsed === undefined || parsed.kind !== "dm") return;
			ephemeralFor(address).pendingFinish = true;
		},
	});

	const unregisterFiles = agent.fileSenders.register("telegram", async (addr, file, meta) => {
		const parsed = parseTelegramAddress(addr);
		if (parsed === undefined) throw new Error(`Invalid Telegram address ${addr}`);
		const payload = {
			data: file.data,
			filename: file.filename,
			...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
		};
		const conversationId = (await agent.addresses(context))[addr];
		const workingAsks = conversationId === undefined ? [] : await agent.activeWorkerAsks(conversationId, context);
		const replyTo = threads.quote(addr, meta?.replyTo, { workingAsks });
		const sendOptions: SendMediaOptions | undefined =
			file.caption === undefined && replyTo === undefined
				? undefined
				: {
						...(file.caption === undefined ? {} : { caption: file.caption }),
						...(replyTo === undefined ? {} : { replyToMessageId: Number(replyTo) }),
					};
		let posted: TelegramMessage;
		if (file.asPhoto === true) {
			await api.sendChatAction(parsed.chatId, "upload_photo").catch(() => undefined);
			posted = await api.sendPhoto(parsed.chatId, payload, sendOptions);
		} else {
			await api.sendChatAction(parsed.chatId, "upload_document").catch(() => undefined);
			posted = await api.sendDocument(parsed.chatId, payload, sendOptions);
		}
		threads.posted(addr, [posted.message_id]);
		threads.sent(addr, meta?.replyTo);
	});

	const deliveries = new Map<string, { stop(): Promise<void> }>();

	function outbox(addr: string, conversation: Conversation): Outbox {
		const parsed = parseTelegramAddress(addr);
		let typing: NodeJS.Timeout | undefined;
		return {
			async send(text, entry, meta) {
				if (parsed === undefined) throw new Error(`Invalid Telegram address ${addr}`);
				const mode = jobs.delivery(addr, text);
				if (mode === "moved") return;
				const isAck = parsed.kind === "dm" && (await isDelegateAck(conversation, entry, context));
				const workingAsks = await agent.activeWorkerAsks(conversation.id, context);
				const replyTo = threads.quote(addr, meta?.replyTo, { isAck, workingAsks });
				const sent = await api.sendFormattedMessage(parsed.chatId, text, {
					disableNotification: mode === "silent",
					disableLinkPreview: true,
					...(replyTo === undefined ? {} : { replyToMessageId: Number(replyTo) }),
				});
				// An ack dissolves once the answer lands, so it doesn't move the chat on.
				if (!isAck) {
					threads.posted(addr, sent.map((msg) => msg.message_id));
					threads.sent(addr, meta?.replyTo);
					if (meta?.replyTo !== undefined) await settleVoiceMemos(addr, conversation, [meta.replyTo]);
				}
				if (parsed.kind === "dm") {
					if (isAck) {
						const state = ephemeralFor(addr);
						state.ackMessageIds = sent.map((msg) => msg.message_id);
						state.userSpokeAfterAck = false;
					} else {
						const state = ephemeral.get(addr);
						if (state !== undefined) {
							const workersDoc = await agent.harness.snapshot(Workers, conversation.id, context);
							const anyWorking = Object.values(workersDoc?.workers ?? {}).some((worker) => worker.status === "working");
							if (state.pendingFinish || !anyWorking) {
								const toDelete: number[] = [];
								if (state.progressMessageId !== undefined) {
									toDelete.push(state.progressMessageId);
									delete state.progressMessageId;
								}
								if (!state.userSpokeAfterAck && state.ackMessageIds.length > 0) {
									toDelete.push(...state.ackMessageIds);
								}
								state.ackMessageIds = [];
								state.userSpokeAfterAck = false;
								state.pendingFinish = false;
								if (toDelete.length > 0) await deleteEphemeralIds(parsed.chatId, toDelete);
							}
						}
					}
				}
				if (sent.length > 0) {
					await conversation.commit(async (tx) => {
						const doc = await tx.doc(TelegramSentMessages);
						for (const msg of sent) {
							doc.messages[`${parsed.chatId}:${msg.message_id}`] = {
								conversation: conversation.id,
								entry,
								text: clip(text.trim()),
								date: msg.date * 1000,
							};
						}
					}, context);
				}
			},
			working(busy) {
				clearInterval(typing);
				typing = undefined;
				if (!busy) {
					// A run that ended without a word (NO_REPLY) or a reaction still shouldn't leave ✍ behind.
					const pending = [...(transcribingVoiceRefs.get(addr) ?? [])];
					if (pending.length > 0) {
						void settleVoiceMemos(addr, conversation, pending).catch((error: unknown) => console.error("[pclaw] telegram ✍", error));
					}
				}
				if (!busy || parsed === undefined) return;
				const ping = () => void api.sendChatAction(parsed.chatId, "typing").catch(() => undefined);
				ping();
				typing = setInterval(ping, TYPING_REFRESH_MS);
			},
		};
	}

	/**
	 * Keep Telegram's bot reaction on each user message in sync with the conversation's `Reactions` doc.
	 * Uses `normalizeTelegramReaction` so emojis outside Telegram's whitelist (e.g. `⏳`, `✅`, `⚠️`) map cleanly
	 * and never fail with `REACTION_INVALID`.
	 */
	async function syncReactions(addr: string, conversation: Conversation): Promise<() => void> {
		const parsed = parseTelegramAddress(addr);
		if (parsed === undefined) return () => undefined;
		await conversation.commit((tx) => tx.doc(Reactions, conversation.id), context);
		const watch = await agent.harness.watchDoc(Reactions, conversation.id, context);
		if (watch === undefined) return () => undefined;
		let applied: Record<string, string> | undefined;
		let queue = Promise.resolve();
		const apply = async (ref: string, emoji: string) => {
			if (!ref.startsWith("telegram:")) return;
			const messageId = Number(ref.slice("telegram:".length));
			if (!Number.isInteger(messageId) || messageId <= 0) return;
			await api.setMessageReaction(parsed.chatId, messageId, emoji === "" ? undefined : emoji);
		};
		const sync = (value: (typeof watch)["value"]) => {
			const asks: Record<string, string> = { ...(value.asks ?? {}) };
			if (applied === undefined) {
				const recent = Object.entries(asks).slice(-RESYNC_ON_ATTACH);
				applied = Object.fromEntries(Object.entries(asks).slice(0, -RESYNC_ON_ATTACH));
				for (const [ref, emoji] of recent) applied[ref] = `${emoji}\u0000stale`;
			}
			const before = applied;
			applied = asks;
			for (const [ref, emoji] of Object.entries(asks)) {
				if (before[ref] === emoji) continue;
				queue = queue
					.then(() => apply(ref, emoji))
					.catch((error: unknown) => console.error(`[pclaw] telegram reaction ${ref}`, error));
			}
		};
		sync(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") sync(call.value);
		});
		return () => void watch.stop();
	}

	async function attach(addr: string, conversation: Conversation) {
		if (deliveries.has(addr)) return;
		deliveries.set(addr, { stop: async () => undefined });
		const delivery = await deliver(agent.harness, conversation.id, outbox(addr, conversation), context, {
			askOf: (userEntry) => agent.askOf(conversation.id, userEntry, context),
		});
		const unsync = await syncReactions(addr, conversation);
		deliveries.set(addr, {
			stop: async () => {
				unsync();
				await delivery.stop();
			},
		});
	}

	// Reattach every Telegram conversation so replies written while pclaw was down go out now.
	for (const [addr, id] of Object.entries(await agent.addresses(context))) {
		if (!addr.startsWith("telegram:")) continue;
		const conversation = await agent.harness.conversation(id, context);
		if (conversation !== undefined) {
			await attach(addr, conversation).catch((error: unknown) => console.error(`[pclaw] ${addr}`, error));
		}
	}

	async function handleMessageBatch(messages: TelegramMessage[]): Promise<void> {
		const primary = messages[0];
		if (primary === undefined) return;
		const auth = authorizeTelegramMessage(primary, {
			ownerId,
			allowedUsers,
			allowedGroups,
			disablePairing: agent.users.enabled,
		});
		if (!auth.allowed) return;
		if (auth.pairedOwnerId !== undefined) {
			ownerId = auth.pairedOwnerId;
			if (options.onOwnerPaired !== undefined) options.onOwnerPaired(ownerId);
			else saveConfig({ telegramOwnerId: ownerId });
			console.log(`[pclaw] paired on Telegram with ${senderName(primary.from)} (${ownerId})`);
		}

		const user = agent.users.resolveAddress(auth.addr);
		const userPaths = user === undefined ? undefined : agent.users.pathsFor(user.id);
		const userTimeZone = user?.timeZone ?? config.timeZone;
		const userSandbox = user === undefined ? undefined : agent.sandboxes.sandboxForUser(user);
		const label = user !== undefined && !auth.isGroup ? `Telegram DM (${user.name})` : auth.label;

		const conversation = await agent.conversationFor(auth.addr, context);
		await agent.describe(conversation.id, { label }, context);
		await attach(auth.addr, conversation);
		// In a forum topic every message "replies" to the topic's opening message; that's not a swipe back.
		const swiped = primary.reply_to_message;
		const jumpTarget = swiped === undefined || "forum_topic_created" in swiped ? undefined : swiped.message_id;
		threads.heard(
			auth.addr,
			messages.map((message) => message.message_id),
			jumpTarget,
		);
		if (!auth.isGroup) {
			const state = ephemeral.get(auth.addr);
			if (state !== undefined && state.ackMessageIds.length > 0) state.userSpokeAfterAck = true;
		}

		const inboxDir = options.inboxDir ?? userPaths?.inbox;
		const voiceDir = options.voiceDir ?? userPaths?.voice;
		const built = await buildTelegramUserInput(messages, {
			api,
			timeZone: userTimeZone,
			botId: me.id,
			...(inboxDir === undefined ? {} : { inboxDir }),
			...(voiceDir === undefined ? {} : { voiceDir }),
			...(config.speechUrl === undefined ? {} : { speechUrl: config.speechUrl }),
			isGroup: auth.isGroup,
			...(userSandbox?.type === "ssh"
				? { stageFile: (localPath: string, filename: string) => userSandbox.putFile(localPath, filename) }
				: {}),
			...(options.transcribeFn === undefined ? {} : { transcribeFn: options.transcribeFn }),
			onVoiceResult: (result) => jobs.decisions.record({ type: "voice", ...result }),
		});

		// Ignore empty messages with no attachments or text (e.g. service messages like pinned/join notices).
		if (built.plainText === "" && typeof built.content === "string") return;

		const repliedText = jumpTarget === undefined ? undefined : (swiped?.text ?? swiped?.caption)?.trim();
		const [guidance, crossClient] = await Promise.all([
			jobs.guideMessage({
				id: `tg-${primary.chat.id}-${primary.message_id}`,
				text: built.plainText,
				channel: auth.isGroup ? auth.label : "telegram direct message",
				conversationId: conversation.id,
				...(repliedText ? { replyTo: repliedText } : {}),
				...(built.hasVoice ? { voice: true } : {}),
			}),
			agent.crossClientHint(conversation.id, context),
		]);
		const tailHints = [crossClient, guidance].filter((item): item is string => item !== undefined).join("\n");

		const content: UserInput =
			tailHints === ""
				? built.content
				: typeof built.content === "string"
					? `${built.content}\n${tailHints}`
					: built.content.map((part, idx) => (idx === 0 && part.type === "text" ? { ...part, text: `${part.text}\n${tailHints}` } : part));

		// Right before submitting, so an earlier run ending meanwhile can't take ✍ off a memo it never saw.
		if (built.heardVoiceRefs.length > 0) {
			let pending = transcribingVoiceRefs.get(auth.addr);
			if (pending === undefined) transcribingVoiceRefs.set(auth.addr, (pending = new Set()));
			for (const ref of built.heardVoiceRefs) pending.add(ref);
		}
		await conversation.submit(
			{
				type: "input",
				content,
				whenBusy: "steer",
				// Single-colon requestId so `currentAsk` in reactions.ts recognizes it.
				requestId: `telegram:${primary.message_id}`,
			},
			context,
		);
	}

	async function handleReactionUpdate(update: TelegramMessageReactionUpdated): Promise<void> {
		if (update.user === undefined || update.user.is_bot === true) return;
		const userId = String(update.user.id);
		const isAllowed =
			allowedUsers.size > 0
				? allowedUsers.has(userId) || (ownerId !== undefined && userId === ownerId)
				: ownerId !== undefined && userId === ownerId;
		if (!isAllowed) return;
		const emoji = addedReactionEmoji(update);
		if (emoji === undefined) return;

		const sent = (await agent.harness.snapshot(TelegramSentMessages, context))?.messages[`${update.chat.id}:${update.message_id}`];
		if (sent === undefined) return;
		const conversation = await agent.harness.conversation(sent.conversation, context);
		if (conversation === undefined) return;
		const userTimeZone = agent.users.resolveExternal("telegram", userId)?.timeZone ?? config.timeZone;
		const content = `[${stamp(update.date * 1000, userTimeZone)}]\n[reacted ${emoji} to your message from ${stamp(sent.date, userTimeZone)}: "${sent.text}"]`;
		await conversation.submit(
			{
				type: "input",
				content,
				whenBusy: "followUp",
				requestId: `telegram-reaction:${update.message_id}:${emoji}:${Date.now()}`,
			},
			context,
		);
	}

	const captionlessBuffer = createCaptionlessFileBuffer({
		delayMs: options.captionlessDebounceMs ?? CAPTIONLESS_FILE_DEBOUNCE_MS,
		onFlush: (batch) => handleMessageBatch(batch),
		onError: (error) => console.error("[pclaw] couldn't handle a Telegram message batch", error),
	});

	const albumBuffer = createMediaGroupBuffer({
		delayMs: options.mediaGroupDelayMs ?? MEDIA_GROUP_DEBOUNCE_MS,
		onFlush: (batch) => captionlessBuffer.enqueue(batch),
		onError: (error) => console.error("[pclaw] couldn't handle a Telegram media group", error),
	});

	const keepTyping = setInterval(() => {
		void (async () => {
			const known = await agent.addresses(context);
			const conversations = await Promise.all(
				[...deliveries.keys()].flatMap((address) => {
					const id = known[address];
					return id === undefined
						? []
						: [agent.harness.snapshot(Workers, id, context).then((doc) => ({ address, workers: Object.values(doc?.workers ?? {}) }))];
				}),
			);
			for (const addr of telegramTypingTargets(conversations, jobs.store.active())) {
				const parsed = parseTelegramAddress(addr);
				if (parsed !== undefined) await api.sendChatAction(parsed.chatId, "typing").catch(() => undefined);
			}
		})().catch((error: unknown) => console.error("[pclaw] telegram typing", error));
	}, TYPING_REFRESH_MS);

	const abort = new AbortController();
	let offset: number | undefined;
	let backoffMs = 1_000;
	const pollTimeout = options.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS;

	const pollLoop = (async () => {
		while (!abort.signal.aborted) {
			try {
				const updates = await api.getUpdates(
					{
						...(offset === undefined ? {} : { offset }),
						timeout: pollTimeout,
						allowed_updates: ALLOWED_UPDATES,
					},
					abort.signal,
				);
				backoffMs = 1_000;
				for (const update of updates) {
					offset = update.update_id + 1;
					if (update.message !== undefined) {
						if (update.message.media_group_id !== undefined) {
							albumBuffer.add(update.message);
						} else {
							captionlessBuffer.enqueue([update.message]);
						}
					} else if (update.message_reaction !== undefined) {
						await handleReactionUpdate(update.message_reaction).catch((error: unknown) =>
							console.error("[pclaw] couldn't handle a Telegram reaction", error),
						);
					}
				}
			} catch (error) {
				if (abort.signal.aborted) break;
				const retryMs =
					error instanceof TelegramApiError && error.retryAfter !== undefined
						? error.retryAfter * 1000
						: backoffMs;
				console.error(`[pclaw] Telegram poll failed (retrying in ${Math.round(retryMs / 1000)}s):`, error instanceof Error ? error.message : error);
				await sleep(retryMs, abort.signal);
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	})();

	return {
		api,
		stop: async () => {
			unregisterFiles();
			unregisterProgress();
			abort.abort();
			albumBuffer.stop();
			captionlessBuffer.stop();
			clearInterval(keepTyping);
			await pollLoop;
			for (const delivery of deliveries.values()) await delivery.stop();
		},
	};
}
