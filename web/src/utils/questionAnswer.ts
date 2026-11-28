import type { AskUserQuestion } from "../types/message";

/**
 * A user's answer to one question, in the shape the form renders it: what
 * `QuestionForm` speaks.
 */
export interface QuestionSelection {
	labels: string[];
	/** null = the "Other" option was not used. */
	otherText: string | null;
}

export const EMPTY_SELECTION: QuestionSelection = {
	labels: [],
	otherText: null,
};

/**
 * Whether a note may go beside this selection — the client's half of the
 * server's `chat.validateNote`, so the form never offers a note the server
 * would refuse.
 *
 * It needs something picked to sit beside. A free-text answer and a single
 * choice of **Other** take none: both are already the user's own words.
 * Beside a multiple choice, Other is one more pick among the rest.
 */
export function noteApplies(
	question: Pick<AskUserQuestion, "options" | "multiSelect">,
	selection: QuestionSelection,
): boolean {
	if (question.options.length === 0) return false;
	return (
		selection.labels.length > 0 ||
		(question.multiSelect && selection.otherText !== null)
	);
}
