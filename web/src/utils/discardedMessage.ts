import type { FileBlock } from "../types/content";
import type { Message, UserMessage } from "../types/message";
import { formatPockodeCommand } from "./pockodeCommand";

/**
 * What the composer holds for a session, as far as restoring a message into it
 * cares: the text, and the ids of the files already stored for it.
 */
export interface Draft {
	text: string;
	attachmentIds: readonly string[];
	/** No text worth keeping and no file, not even one still uploading. */
	isEmpty: boolean;
}

/**
 * Every message a Stop threw away unread, by the server id each turn names it
 * by, mapped to the message itself where it is loaded. Derived from the
 * records on every pass rather than written onto the message when the record
 * arrives: the sender's own echo learns its id only from the `chat.message`
 * reply, which may land after the Stop's record does, and an older page brings
 * a message in long after its turn was read (docs/discarded-messages-ui.md).
 */
export function discardedMessages(
	messages: readonly Message[],
): ReadonlyMap<string, UserMessage | undefined> {
	const discarded = new Map<string, UserMessage | undefined>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const id of message.discardedMessageIds ?? []) {
			discarded.set(id, undefined);
		}
	}
	if (discarded.size === 0) return discarded;
	for (const message of messages) {
		if (
			message.role === "user" &&
			message.messageId &&
			discarded.has(message.messageId)
		) {
			discarded.set(message.messageId, message);
		}
	}
	return discarded;
}

/**
 * Whether the message holds words the user can take back. An answer to posted
 * questions does not — its text is the answers flattened for the agent — and
 * neither does anything Pockode or another agent sent.
 */
export function isRestorable(message: UserMessage): boolean {
	return message.source === undefined && !message.answering;
}

/** The message as the user would type it again. A command comes back as typed. */
export function restoreText(message: UserMessage): string {
	return message.command
		? formatPockodeCommand(message.command)
		: message.content;
}

/**
 * Whether the draft already holds all of the message: its text somewhere in
 * the draft's, and every one of its files. Nothing records that a message was
 * restored — that is this device's passing state, not an event — so this is
 * read off the draft as it is now, and goes false the moment the user sends or
 * edits the text away.
 */
export function isInDraft(message: UserMessage, draft: Draft): boolean {
	const text = restoreText(message).trim();
	if (text && !draft.text.includes(text)) return false;
	return (message.attachments ?? []).every(
		(file) =>
			!file.attachment_id || draft.attachmentIds.includes(file.attachment_id),
	);
}

/**
 * Why a command cannot be restored into this draft, or undefined when it can.
 * A Pockode command is only recognised when it is the whole message, so one
 * appended to other text would go out as plain prose — silently not the thing
 * the user typed.
 */
export function commandRestoreBlocked(
	message: UserMessage,
	draft: Draft,
): string | undefined {
	if (!message.command || draft.isEmpty || isInDraft(message, draft)) {
		return undefined;
	}
	return "Clear the input first. A command only runs as a whole message.";
}

/**
 * What restoring `messages` into `draft` changes: the text to set, absent when
 * it stays as it is, and the files to add. Only what is missing is added, so
 * pressing again — or after a reload, which keeps the text and loses the files —
 * repeats nothing. Existing words are never replaced: what is restored goes
 * after them, a blank line apart.
 */
export function restoreIntoDraft(
	draft: Draft,
	messages: readonly UserMessage[],
): { text?: string; attachments: FileBlock[] } {
	const before = draft.isEmpty ? "" : draft.text;
	let text = before;
	const ids = new Set(draft.attachmentIds);
	const attachments: FileBlock[] = [];
	for (const message of messages) {
		const restored = restoreText(message).trim();
		if (restored && !text.includes(restored)) {
			const kept = text.trimEnd();
			text = kept ? `${kept}\n\n${restored}` : restored;
		}
		for (const file of message.attachments ?? []) {
			if (!file.attachment_id || ids.has(file.attachment_id)) continue;
			ids.add(file.attachment_id);
			attachments.push(file);
		}
	}
	return { ...(text !== before ? { text } : {}), attachments };
}

/** What the end of a stopped turn offers back, from the messages it threw away. */
export interface TurnRestore {
	/**
	 * What one press puts back: every plain message the user typed, in the order
	 * they were sent — or, when the only one is a command, that command. Empty
	 * when there is nothing to offer.
	 */
	messages: UserMessage[];
	/** Commands left to their own menus, which only restore one at a time. */
	leavesCommands: boolean;
	/** Discarded messages in history this transcript has not loaded yet. */
	notLoaded: number;
}

export function turnRestore(
	ids: readonly string[],
	discarded: ReadonlyMap<string, UserMessage | undefined>,
): TurnRestore {
	const loaded = ids.flatMap((id) => {
		const message = discarded.get(id);
		return message ? [message] : [];
	});
	const restorable = loaded.filter(isRestorable);
	const plain = restorable.filter((message) => !message.command);
	const commands = restorable.filter((message) => message.command);
	const messages =
		plain.length === 0 && commands.length === 1 ? commands : plain;
	return {
		messages,
		leavesCommands: messages === plain && commands.length > 0,
		notLoaded: ids.length - loaded.length,
	};
}
