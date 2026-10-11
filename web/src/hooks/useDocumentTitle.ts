import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWSStore } from "../lib/wsStore";

/**
 * Keeps the tab titled after the connected project.
 *
 * Assigned again on every navigation, not just when the title changes: Firefox
 * for Android clears the tab title whenever the URL's path or query changes —
 * same-document pushState included — and shows the URL instead, while Gecko
 * only reports a title when one is assigned. Assigning the same string again
 * does re-report it, and Gecko sends that report from a later task, so it
 * lands after the router's deferred pushState even when this effect runs
 * before it. Other browsers keep the title, so the repeat assignment changes
 * nothing there.
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
		document.title = `${projectTitle} | Pockode`;
	}, [projectTitle, location]);
}
