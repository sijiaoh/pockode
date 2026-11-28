import type { MessageSubtype } from "../types/message";
import type * as Wire from "../types/wire.generated";

/**
 * How a permission reviewer's transcript reads: the two system messages
 * Pockode sends it (docs/unattended-mode-ui.md §5.1). The subtypes and the
 * message shapes are the server's (`permreview.MessageSubtype`,
 * `permreview.NudgeSubtype`, `reviewMessage`, `nudgeMessage`).
 */

export const PERMISSION_REVIEW_SUBTYPE =
	"permission_review" satisfies Wire.MessageSubtype;
export const PERMISSION_REVIEW_NUDGE_SUBTYPE =
	"permission_review_nudge" satisfies Wire.MessageSubtype;

export type ReviewerEventSubtype =
	| typeof PERMISSION_REVIEW_SUBTYPE
	| typeof PERMISSION_REVIEW_NUDGE_SUBTYPE;

export function isReviewerEventSubtype(
	subtype: MessageSubtype | undefined,
): subtype is ReviewerEventSubtype {
	return (
		subtype === PERMISSION_REVIEW_SUBTYPE ||
		subtype === PERMISSION_REVIEW_NUDGE_SUBTYPE
	);
}

/** The request a review message hands the reviewer, as far as it parsed. */
export interface ReviewRequest {
	toolName: string;
	toolInput: unknown;
	/** The main session's worktree as it was when the request was sent. */
	cwd: string;
	/** The whole object, for the expanded body. */
	json: Record<string, unknown>;
}

/**
 * The JSON object a review message ends on, or null when it does not parse.
 *
 * The message is one line of instructions, a blank line, then the object; the
 * instructions hold no `{`, so the object starts at the first one after the
 * blank line.
 */
export function parseReviewRequest(content: string): ReviewRequest | null {
	const start = content.indexOf("\n\n{");
	if (start === -1) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.slice(start + 2));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const json = parsed as Record<string, unknown>;
	if (typeof json.tool_name !== "string") return null;
	return {
		toolName: json.tool_name,
		toolInput: json.tool_input,
		cwd: typeof json.cwd === "string" ? json.cwd : "",
		json,
	};
}

/**
 * How many requests a reminder lists, or null when it does not read as one.
 * Each waiting request is a `- <id> (<tool>)` line.
 */
export function nudgePendingCount(content: string): number | null {
	if (!content.startsWith("Reminder ")) return null;
	const count = content
		.split("\n")
		.filter((line) => line.startsWith("- ")).length;
	return count > 0 ? count : null;
}
