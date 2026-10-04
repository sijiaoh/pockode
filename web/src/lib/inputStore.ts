import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileBlock } from "../types/content";
import { formatBytes } from "../utils/bytes";
import { isAbortError } from "./api";
import { type ChatAttachment, uploadChatAttachment } from "./chatAttachments";
import { useWorktreeStore } from "./worktreeStore";
import { useWSStore } from "./wsStore";

/**
 * A file picked in the composer. Uploaded the moment it is picked, so the send
 * waits on nothing the user has not already watched finish.
 */
export interface DraftAttachment {
	key: string;
	name: string;
	size: number;
	/** A local `blob:` URL for an image, so the preview costs no round trip. */
	previewUrl: string | null;
	status: "uploading" | "ready" | "failed";
	uploaded?: ChatAttachment;
	error?: string;
}

interface InputState {
	inputs: Record<string, string>;
	/**
	 * The draft's files, keyed by session like its text: each was uploaded to
	 * that session's attachment store, the only one that can name it. Here
	 * rather than in the bar for the reason the text is (`InputBarProps`), and
	 * for the uploads still running, which the bar unmounting must not drop.
	 * Not persisted: neither the `File` nor its `blob:` URL survives a reload.
	 */
	attachments: Record<string, DraftAttachment[]>;
}

export const useInputStore = create<InputState>()(
	persist(
		() => ({
			inputs: {},
			attachments: {},
		}),
		{
			name: "input_drafts",
			partialize: ({ inputs }) => ({ inputs }),
		},
	),
);

export const inputActions = {
	set: (sessionId: string, content: string) =>
		useInputStore.setState((state) => ({
			inputs: { ...state.inputs, [sessionId]: content },
		})),
	clear: (sessionId: string) =>
		useInputStore.setState((state) => {
			const { [sessionId]: _, ...rest } = state.inputs;
			return { inputs: rest };
		}),
};

const controllers = new Map<string, AbortController>();
let nextKey = 0;

function updateAttachments(
	sessionId: string,
	update: (items: DraftAttachment[]) => DraftAttachment[],
) {
	useInputStore.setState((state) => {
		const items = update(state.attachments[sessionId] ?? []);
		const { [sessionId]: _, ...rest } = state.attachments;
		return {
			attachments: items.length > 0 ? { ...rest, [sessionId]: items } : rest,
		};
	});
}

function patchAttachment(
	sessionId: string,
	key: string,
	change: Partial<DraftAttachment>,
) {
	updateAttachments(sessionId, (items) =>
		items.map((item) => (item.key === key ? { ...item, ...change } : item)),
	);
}

export const attachmentActions = {
	add: (sessionId: string, files: File[]) => {
		// Read at pick time: the session's store is in the worktree that is
		// current now, whatever is current when the upload lands.
		const worktree = useWorktreeStore.getState().current;
		const maxSize = useWSStore.getState().maxAttachmentSize;
		const added = files.map((file): DraftAttachment => {
			const key = `attachment-${nextKey++}`;
			// Refused here rather than by the server, so a photo too large to
			// send is not uploaded in full only to be told so. No preview for it:
			// a failed entry is drawn as a chip, so its blob URL would never be read.
			if (maxSize > 0 && file.size > maxSize) {
				return {
					key,
					name: file.name,
					size: file.size,
					previewUrl: null,
					status: "failed",
					error: `Too large (max ${formatBytes(maxSize)})`,
				};
			}
			const base = {
				key,
				name: file.name,
				size: file.size,
				previewUrl: file.type.startsWith("image/")
					? URL.createObjectURL(file)
					: null,
			};
			const controller = new AbortController();
			controllers.set(key, controller);
			uploadChatAttachment({
				file,
				sessionId,
				worktree,
				signal: controller.signal,
			})
				.then(
					(uploaded) =>
						patchAttachment(sessionId, key, { status: "ready", uploaded }),
					(error: unknown) => {
						if (isAbortError(error)) return;
						patchAttachment(sessionId, key, {
							status: "failed",
							error:
								error instanceof Error && error.message
									? error.message
									: "Upload failed",
						});
					},
				)
				.finally(() => controllers.delete(key));
			return { ...base, status: "uploading" };
		});
		updateAttachments(sessionId, (items) => [...items, ...added]);
	},

	remove: (sessionId: string, key: string) => {
		const item = useInputStore
			.getState()
			.attachments[sessionId]?.find((i) => i.key === key);
		if (item) attachmentActions.release([item]);
		updateAttachments(sessionId, (items) => items.filter((i) => i.key !== key));
	},

	/**
	 * Takes a session's files out of the draft for a send. The caller either
	 * `release`s them once the message is in, or `restore`s them if it was
	 * refused.
	 */
	take: (sessionId: string): DraftAttachment[] => {
		const taken = useInputStore.getState().attachments[sessionId] ?? [];
		updateAttachments(sessionId, () => []);
		return taken;
	},

	/**
	 * Puts files a message already carried back into a session's draft — a
	 * message the user is sending again, or forked away from. They are in the
	 * session's store already, so there is nothing to upload. No preview: the
	 * bytes are on the server, and a chip names them.
	 */
	adopt: (sessionId: string, files: FileBlock[]) => {
		const adopted = files.flatMap((file): DraftAttachment[] => {
			if (!file.attachment_id) return [];
			const name = file.name ?? file.attachment_id;
			return [
				{
					key: `attachment-${nextKey++}`,
					name,
					size: file.size ?? 0,
					previewUrl: null,
					status: "ready",
					uploaded: {
						id: file.attachment_id,
						name,
						size: file.size ?? 0,
						mime: file.mime,
					},
				},
			];
		});
		if (adopted.length > 0) {
			updateAttachments(sessionId, (items) => [...items, ...adopted]);
		}
	},

	/** Ahead of anything picked since: these were picked first. */
	restore: (sessionId: string, taken: DraftAttachment[]) =>
		updateAttachments(sessionId, (items) => [...taken, ...items]),

	discard: (sessionId: string) =>
		attachmentActions.release(attachmentActions.take(sessionId)),

	release: (items: DraftAttachment[]) => {
		for (const item of items) {
			controllers.get(item.key)?.abort();
			if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
		}
	},
};
