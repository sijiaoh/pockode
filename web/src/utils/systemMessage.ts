import type { SystemMessageMeta, WorkTimelineEntry } from "../types/message";

// subtype → action label. Where values come from: the backend system message
// subtypes in server/work/prompt.go (kickoff, restart, ...).
const SYSTEM_MESSAGE_LABELS: Record<string, string> = {
	kickoff: "Kickoff",
	restart: "Restart",
	auto_continue: "Auto-continue",
	step_advance: "Next step",
	reopen: "Reopen",
	child_done: "Child task done",
};

function baseLabel(subtype?: string): string {
	return (subtype && SYSTEM_MESSAGE_LABELS[subtype]) || "System Message";
}

/** Label for a standalone system banner (history without a work card). */
export function systemActionLabel(
	subtype?: string,
	meta?: SystemMessageMeta,
): string {
	const base = baseLabel(subtype);
	if (subtype === "step_advance" && meta?.step) {
		return `${base} (Step ${meta.step.current}/${meta.step.total})`;
	}
	return base;
}

/**
 * Label for one row of a work card's timeline. Shorter than the banner's: the
 * card header already names the work, so a row only has to say what happened.
 */
export function timelineEntryLabel(entry: WorkTimelineEntry): string {
	const base = baseLabel(entry.subtype);
	if (entry.subtype === "step_advance" && entry.step) {
		return `${base} ${entry.step.current}`;
	}
	if (entry.subtype === "child_done" && entry.child) {
		return `${base}: ${entry.child.title}`;
	}
	return base;
}

/**
 * One timeline row. Usually one entry, but a consecutive run of auto-continues
 * collapses into a single counted row: it is the only subtype that repeats in
 * practice, and a stack of identical "Auto-continue" rows is the noisiest,
 * least informative part of the timeline.
 */
export interface TimelineGroup {
	/** The first entry's id — stable across appends, so React keys hold. */
	id: string;
	entries: WorkTimelineEntry[];
}

export function groupTimelineEntries(
	entries: WorkTimelineEntry[],
): TimelineGroup[] {
	const groups: TimelineGroup[] = [];
	for (const entry of entries) {
		const last = groups[groups.length - 1];
		if (
			entry.subtype === "auto_continue" &&
			last?.entries[0].subtype === "auto_continue"
		) {
			last.entries.push(entry);
			continue;
		}
		groups.push({ id: entry.id, entries: [entry] });
	}
	return groups;
}

/** Group label, with a repeat count when the run holds more than one entry. */
export function timelineGroupLabel(group: TimelineGroup): string {
	const label = timelineEntryLabel(group.entries[0]);
	return group.entries.length > 1 ? `${label} ×${group.entries.length}` : label;
}
