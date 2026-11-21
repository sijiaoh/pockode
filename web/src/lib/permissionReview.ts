/**
 * The words for a reviewed permission answer's `review.category` and
 * `review.automatic` (docs/unattended-mode-ui.md §3.2; the ids are the server's,
 * docs/agent-event.md#permission-requests-and-their-answers).
 */

const CATEGORY_LABELS: Record<string, string> = {
	system_damage: "Could damage the system",
	prompt_injection: "Possible prompt injection",
	system_reach_unverifiable: "Can't verify what it reaches",
};

const AUTOMATIC_LABELS: Record<string, string> = {
	timeout: "No verdict in time",
	no_verdict: "Reviewer gave no verdict",
	reviewer_failed: "Reviewer failed",
	reviewer_request: "Reviewers can't ask for permission",
};

/** An id this build does not know is shown as sent: it is still the reviewer's word. */
export function reviewCategoryLabel(category: string): string {
	return Object.hasOwn(CATEGORY_LABELS, category)
		? CATEGORY_LABELS[category]
		: category;
}

/** An id this build does not know says only what is certain: nobody judged it. */
export function reviewAutomaticLabel(automatic: string | undefined): string {
	return automatic && Object.hasOwn(AUTOMATIC_LABELS, automatic)
		? AUTOMATIC_LABELS[automatic]
		: "Denied automatically";
}
