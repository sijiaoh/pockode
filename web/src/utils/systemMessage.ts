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
	child_question: "Subtask asked",
	wait_stranded: "Wait cleared",
	watched_story_closed: "Story done",
	watched_story_stopped: "Story stopped",
	watched_story_question: "Story asked",
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
	// These messages went to the parent but report on a child; the parent's own
	// title is noise next to it.
	if (
		subtype === "child_done" ||
		subtype === "child_question" ||
		subtype === "wait_stranded"
	) {
		return { label, summary: meta?.child?.title ?? "" };
	}
	// Sent to whoever started a story with a watch — often a plain chat with no
	// title of its own — about that story.
	if (subtype?.startsWith("watched_story_")) {
		return { label, summary: meta?.story?.title ?? "" };
	}
	// Auto-continues repeat, and repeating one title is the least informative
	// line there is. Left blank so they stay visually weightless.
	if (subtype === "auto_continue") return { label, summary: "" };

	return { label, summary: meta?.title ?? "" };
}

/** The work a work event's expanded body names and links into. */
export interface WorkEventSubject {
	workId?: string;
	title?: string;
}

/**
 * Normally the work the message was sent to. A watched story's news is the
 * exception: it is about a story the reader started, not about the reader —
 * which is often a plain chat with no work at all — so it leads to that story.
 */
export function workEventSubject(
	subtype: string | undefined,
	meta: SystemMessageMeta | undefined,
): WorkEventSubject {
	if (subtype?.startsWith("watched_story_") && meta?.story) {
		return { workId: meta.story.id, title: meta.story.title };
	}
	return { workId: meta?.work_id, title: meta?.title };
}
