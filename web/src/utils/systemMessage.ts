import type { SystemMessageMeta } from "../types/message";
import { formatStepProgress, recordedStepProgress } from "./workSteps";

// subtype → action word. Where values come from: the backend system message
// subtypes in server/work/prompt.go (kickoff, restart, ...).
const SYSTEM_MESSAGE_LABELS: Record<string, string> = {
	kickoff: "Started",
	restart: "Restarted",
	auto_continue: "Continued",
	// Only reached when the message recorded no step; otherwise the step itself
	// is the action word.
	step_advance: "Next step",
	reopen: "Reopened",
	child_done: "Subtask done",
};

/** How one work event reads in the stream. */
export interface WorkEventWording {
	/** What happened, stated as a finished fact — never a live status. */
	label: string;
	/** The secondary line, empty when repeating a title would say nothing. */
	summary: string;
}

/**
 * Both halves of a work event's collapsed line, decided together: which title
 * belongs on the line depends on the same subtype the action word does.
 */
export function workEventWording(
	subtype: string | undefined,
	meta: SystemMessageMeta | undefined,
): WorkEventWording {
	const label = (subtype && SYSTEM_MESSAGE_LABELS[subtype]) || "System Message";

	if (subtype === "step_advance" && meta?.step) {
		// Through the same formatter as everywhere else, so step wording has one
		// source. The action word *is* the step here: reaching it is the event.
		return {
			label: formatStepProgress(
				recordedStepProgress(meta.step.current, meta.step.total),
			),
			summary: meta.title ?? "",
		};
	}
	// This message went to the parent but reports on the child; the parent's own
	// title is noise next to it.
	if (subtype === "child_done") {
		return { label, summary: meta?.child?.title ?? "" };
	}
	// Auto-continues repeat, and repeating one title is the least informative
	// line there is. Left blank so they stay visually weightless.
	if (subtype === "auto_continue") return { label, summary: "" };

	return { label, summary: meta?.title ?? "" };
}
