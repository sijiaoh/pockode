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
 * loaded: it belongs to that call, which counts as one, so it is not counted —
 * but it is work, drawn where it arrived, so the line goes below it too.
 * Undefined for a reply that made no call — it draws no line at all.
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
	let flatSteps = false;
	for (const part of message.parts) {
		if (part.type !== "tool_call" && part.type !== "permission_request") {
			continue;
		}
		// Work all the same, so the line goes below it — and a reply whose
		// loaded half holds nothing else still has its changes card.
		lastCallPartId = part.id;
		if (part.parentToolUseId) {
			flatSteps = true;
		} else {
			calls.add(
				part.type === "tool_call" ? part.tool.id : part.request.toolUseId,
			);
		}
	}
	if (lastCallPartId === undefined) return undefined;

	// A step left flat with no call loaded above it says outright that the
	// reply's start is on a page not loaded.
	const cut =
		(calls.size === 0 && flatSteps) ||
		(olderPagesAbove &&
			!message.openedAtReadPoint &&
			message.openedAt === undefined);
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
