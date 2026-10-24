import type { Entry } from "../types/contents";

/**
 * The type a tree row's drag carries. Custom rather than `text/plain` or
 * `text/uri-list`: with either one, a row released over the chat composer or
 * the search field would be typed into it.
 */
export const ENTRY_DRAG_TYPE = "application/x-pockode-entry";

/**
 * Fills a tree row's drag in. The one place what a row drag carries is
 * written, so that dragging a row out of the window (as a download) is an
 * addition here rather than a second source to keep in step.
 *
 * The payload is the drag's identity only. During `dragover` a page can read
 * `types` and nothing else, so whoever checks a target against the source reads
 * the source from where it was recorded at `dragstart`, not from here.
 */
export function writeEntryDrag(
	dataTransfer: DataTransfer,
	entry: Pick<Entry, "path" | "type">,
): void {
	dataTransfer.effectAllowed = "move";
	dataTransfer.setData(
		ENTRY_DRAG_TYPE,
		JSON.stringify({ path: entry.path, type: entry.type }),
	);
}

export function carriesEntry(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.types).includes(ENTRY_DRAG_TYPE);
}
