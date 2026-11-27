import type { AssistantMessage } from "../types/message";

/** Below this the span is noise: `Worked 0s` says nothing about a turn. */
const MIN_SPAN_MS = 1000;

/**
 * The work figures of one settled reply (docs/tool-call-ui.md#the-work-figures),
 * besides its files, which are `turnChanges`'.
 */
export interface TurnWork {
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
 * but it is work all the same, so a reply whose loaded half holds nothing
 * else still has figures (and a changes card).
 * Undefined for a reply that made no call — it has no figures at all.
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
	let madeCall = false;
	let flatSteps = false;
	for (const part of message.parts) {
		if (part.type !== "tool_call" && part.type !== "permission_request") {
			continue;
		}
		madeCall = true;
		if (part.parentToolUseId) {
			flatSteps = true;
		} else {
			calls.add(
				part.type === "tool_call" ? part.tool.id : part.request.toolUseId,
			);
		}
	}
	if (!madeCall) return undefined;

	// A step left flat with no call loaded above it says outright that the
	// reply's start is on a page not loaded.
	const cut =
		(calls.size === 0 && flatSteps) ||
		(olderPagesAbove &&
			!message.openedAtReadPoint &&
			message.openedAt === undefined);
	if (cut) return {};

	const { openedAt, endedAt } = message;
	const span =
		openedAt !== undefined && endedAt !== undefined
			? endedAt - openedAt
			: undefined;
	return {
		calls: calls.size,
		durationMs: span !== undefined && span >= MIN_SPAN_MS ? span : undefined,
	};
}
