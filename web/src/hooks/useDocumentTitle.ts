import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWSStore } from "../lib/wsStore";

// Zero-width space: not whitespace to Gecko's title compression nor to
// Android's blank check, so it survives as a real difference, yet draws nothing.
const MARKER = "\u200B";

/**
 * Keeps the tab titled after the connected project.
 *
 * TODO: Reassigning on every navigation, the marker and the deferral exist only
 * to work around https://bugzilla.mozilla.org/show_bug.cgi?id=1843682 —
 * Firefox for Android blanks the tab title (and shows the URL) whenever
 * pushState/replaceState or back/forward changes the URL's path or query, and
 * shows a title again only when Gecko reports a new one. Once that bug is
 * fixed, remove them and assign the title only when the project changes.
 *
 * Gecko reports a title only when it differs from the last one it sent, and
 * coalesces changes made within one task into a report of the final title. So
 * each navigation assigns a title that differs from the current one, toggling
 * an invisible marker, and does so in a task of its own: the router flushes
 * pushState in a microtask, and a timeout puts the report after it.
 */
export function useDocumentTitle() {
	const projectTitle = useWSStore((state) => state.projectTitle);
	// Replaced on every navigation, including one that only changes history
	// state, so it fires the effect each time.
	const location = useRouterState({ select: (state) => state.location });

	// biome-ignore lint/correctness/useExhaustiveDependencies: location is the trigger, not a value the body reads
	useEffect(() => {
		// Empty until the first auth; a disconnect empties it too, and the tab
		// keeps the last project's name rather than going blank.
		if (!projectTitle) return;
		const title = `${projectTitle} | Pockode`;
		const timer = setTimeout(() => {
			// Decided by the marker rather than by comparing with `title`: the
			// getter collapses whitespace, so a project name with runs of spaces
			// would never compare equal and the title would stop changing.
			document.title = document.title.endsWith(MARKER)
				? title
				: `${title}${MARKER}`;
		});
		return () => clearTimeout(timer);
	}, [projectTitle, location]);
}
