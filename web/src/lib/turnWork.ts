import type { AssistantMessage } from "../types/message";

/** Below this the span is noise: `Worked 0s` says nothing about a turn. */
const MIN_SPAN_MS = 1000;

/**
 * The work line's figures for one settled reply (docs/tool-call-ui.md#the-work-line),
 * besides its files, which are `turnChanges`'.
 */
export interface TurnWork {
	/** The part of the reply's last call: the line stands after its block. */
	lastCallPartId: string;
	/**
	 * Distinct calls the reply made. Absent when the oldest loaded page may have
	 * cut the reply in half, since it would count only the loaded half.
	 */
	calls?: number;
	/** The reply's span on the server's clock, when both ends were stamped. */
	durationMs?: number;
}

/**
 * The calls are the distinct `tool_use_id`s of the top-level `tool_call` and
 * `permission_request` parts, whatever their status. A part carrying
 * `parentToolUseId` is a subagent's step left flat because its call is not
 * loaded: it belongs to that call, which counts as one, so it neither counts
 * nor places the line. Undefined for a reply that made no call — it draws no
 * line at all.
 *
 * `olderPagesAbove` says the message is the first loaded one with history
 * still above it. Unless a read point opened it, its opening may be on the
 * older page, so neither its count nor its span can be trusted until that page
 * joins it.
 */
export function turnWork(
	message: AssistantMessage,
	olderPagesAbove: boolean,
): TurnWork | undefined {
	const calls = new Set<string>();
	let lastCallPartId: string | undefined;
	for (const part of message.parts) {
		if (part.type === "tool_call" && !part.parentToolUseId) {
			calls.add(part.tool.id);
		} else if (part.type === "permission_request" && !part.parentToolUseId) {
			calls.add(part.request.toolUseId);
		} else {
			continue;
		}
		lastCallPartId = part.id;
	}
	if (lastCallPartId === undefined) return undefined;

	const cut =
		olderPagesAbove &&
		!message.openedAtReadPoint &&
		message.openedAt === undefined;
	if (cut) return { lastCallPartId };

	const { openedAt, endedAt } = message;
	const span =
		openedAt !== undefined && endedAt !== undefined
			? endedAt - openedAt
			: undefined;
	return {
		lastCallPartId,
		calls: calls.size,
		durationMs: span !== undefined && span >= MIN_SPAN_MS ? span : undefined,
	};
}
