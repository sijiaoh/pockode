import { useRouter, useRouterState } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { entryKeyOf, scrollMemoryFor } from "../lib/scrollMemory";
import type { ScrollRestorationScope } from "./useScrollRestoration";

/** The value of `ScrollRestorationContext`; called where the router is. */
export function useScrollRestorationScope(): ScrollRestorationScope {
	const { history } = useRouter();
	// The entry of the pages on screen, which is not the router's location:
	// that moves to the next entry as soon as the navigation starts, while the
	// page being left is still mounted and can still scroll — and what it
	// saved there would be restored into the next page. The rendered matches
	// change together with `isLoading` going false, so until then the entry
	// stays the one the pages were rendered for.
	const settled = useRouterState({
		select: (s) => (s.isLoading ? null : entryKeyOf(s.location)),
	});
	const lastSettled = useRef(settled);
	if (settled !== null) lastSettled.current = settled;
	const entry = settled ?? lastSettled.current;
	return useMemo(
		() => ({ memory: scrollMemoryFor(history), entry }),
		[history, entry],
	);
}
