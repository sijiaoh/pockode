import type { FileBlock } from "../types/content";
import type { MessageAttachmentParams } from "../types/message";
import { apiUrl } from "./api";
import { postUpload, UploadError } from "./fileUpload";

/**
 * A file stored in a session's attachment store, ready to be named by the
 * `chat.message` that carries it. What the client knows about it before the
 * server has described it: `mime` is the browser's guess from the `File`, and
 * is replaced by the server's reading of the bytes once the message is sent.
 */
export interface ChatAttachment {
	id: string;
	name: string;
	size: number;
	mime: string;
}

export interface ChatAttachmentUploadRequest {
	file: File;
	sessionId: string;
	/** Worktree name; empty for the main one. */
	worktree: string;
	/** Fraction of the body sent so far, 0 to 1. */
	onProgress?: (fraction: number) => void;
	signal?: AbortSignal;
}

function attachmentUploadUrl(sessionId: string, worktree: string): string {
	const params = new URLSearchParams({ session_id: sessionId });
	if (worktree) params.set("worktree", worktree);
	return apiUrl(`/api/chat/attachments?${params.toString()}`);
}

/**
 * Uploads one file to a session's attachment store (`POST /api/chat/attachments`).
 *
 * Over HTTP rather than inside `chat.message` for the reason workspace uploads
 * are: a photo is megabytes, and the WebSocket carries one message at a time.
 * The same content uploaded twice gets the same id, so retrying a failed upload
 * is always safe. Rejects with an `UploadError` (`too_large` carries the
 * server's ceiling in its message).
 */
export async function uploadChatAttachment(
	request: ChatAttachmentUploadRequest,
): Promise<ChatAttachment> {
	const { file, sessionId, worktree, onProgress, signal } = request;
	const body = new FormData();
	body.append("file", file, file.name);
	const text = await postUpload(
		attachmentUploadUrl(sessionId, worktree),
		body,
		{
			onProgress,
			signal,
		},
	);

	let stored: unknown;
	try {
		stored = (JSON.parse(text) as { files?: unknown }).files;
	} catch {
		stored = undefined;
	}
	const first = Array.isArray(stored)
		? (stored[0] as Record<string, unknown> | undefined)
		: undefined;
	if (!first || typeof first.id !== "string" || first.id === "") {
		throw new UploadError("The server did not say where the file was stored");
	}
	return {
		id: first.id,
		name: typeof first.name === "string" ? first.name : file.name,
		size: typeof first.size === "number" ? first.size : file.size,
		mime: file.type,
	};
}

/** The wire form `chat.message` names attachments by. */
export function toAttachmentParams(
	attachments: ChatAttachment[],
): MessageAttachmentParams[] {
	return attachments.map(({ id, name }) => ({ id, name }));
}

/**
 * What a sender's echo shows for its files until the reply describes them:
 * enough to hold a chip with a name, and the id that fetches the bytes.
 */
export function toEchoFileBlocks(attachments: ChatAttachment[]): FileBlock[] {
	return attachments.map(({ id, name, size, mime }) => ({
		name,
		mime,
		size,
		attachment_id: id,
	}));
}
