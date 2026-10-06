import { useMemo } from "react";
import { type DraftAttachment, useInputStore } from "../lib/inputStore";
import type { Draft } from "../utils/discardedMessage";

const NO_ATTACHMENTS: DraftAttachment[] = [];

/** The draft as `readDraft` sees it, kept current. */
export function useComposerDraft(sessionId: string): Draft {
	const text = useInputStore((state) => state.inputs[sessionId] ?? "");
	const attachments = useInputStore(
		(state) => state.attachments[sessionId] ?? NO_ATTACHMENTS,
	);
	return useMemo(() => toDraft(text, attachments), [text, attachments]);
}

/** A session's draft as it is now, for a handler that reads it at the press. */
export function readDraft(sessionId: string): Draft {
	const state = useInputStore.getState();
	return toDraft(
		state.inputs[sessionId] ?? "",
		state.attachments[sessionId] ?? NO_ATTACHMENTS,
	);
}

function toDraft(text: string, attachments: DraftAttachment[]): Draft {
	return {
		text,
		attachmentIds: attachments.flatMap((item) =>
			item.uploaded ? [item.uploaded.id] : [],
		),
		isEmpty: text.trim() === "" && attachments.length === 0,
	};
}
