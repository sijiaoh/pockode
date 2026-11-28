import type { AssistantMessage } from "../types/message";

/** Below this the span is noise: `Worked 0s` says nothing about a turn. */
const MIN_SPAN_MS = 1000;

/**
 * The work figures of one settled reply (docs/tool-call-ui.md#the-work-figures),
 * besides its files, which are `turnChanges`'.
 */
export interface TurnWork {
	/**
	 * Distinct calls the reply made. Absent when the reply's start is not
	 * loaded, since it would count only the loaded half.
	 */
	calls?: number;
	/** The reply's span on the server's clock, when both ends were stamped. */
	durationMs?: number;
}

/**
 * The calls are the distinct `tool_use_id`s of the top-level `tool_call` and
 * `permission_request` parts, whatever their status. A part carrying
 * `parentToolUseId` is a subagent's step left flat because its call is not in
 * the history (a fork cut it off): it belongs to that call, which counts as
 * one, so it is not counted —
 * but it is work all the same, so a reply whose loaded half holds nothing
 * else still has figures (and a changes card).
 * Undefined for a reply that made no call — it has no figures at all.
 *
 * A reply whose start is on a page not loaded yet (`startNotLoaded`) has
 * figures of neither kind until that page joins it.
 */
export function turnWork(message: AssistantMessage): TurnWork | undefined {
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

	// The server says the start is on an older page; a step left flat with no
	// call of the reply's own beside it says the start is in no history at all.
	if (message.startNotLoaded || (calls.size === 0 && flatSteps)) return {};

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
