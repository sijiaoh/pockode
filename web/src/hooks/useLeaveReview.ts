import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { isReviewFromList, overlayToNavigation } from "../lib/navigation";

/** The review entry a `back()` has been issued from and has not left yet. */
let backingFrom: string | undefined;

/**
 * Leaves the review for the Changes list, so that the review is one history
 * entry: back to the list it was pushed from, or — reached without one behind
 * it — replaced by the list (REVIEW_FROM_LIST_STATE).
 *
 * A second leave before the first `back()` has landed — a double tap on ←, a
 * commit answering while a discard does — would go back once more, past the
 * list, so it is dropped while the window is still on the entry left.
 */
export function useLeaveReview(): (
	worktree: string,
	sessionId: string | null,
) => void {
	const navigate = useNavigate();
	const router = useRouter();
	return useCallback(
		(worktree, sessionId) => {
			const { history } = router;
			const state = history.location.state;
			if (!isReviewFromList(state)) {
				navigate(
					overlayToNavigation(
						{ type: "git", segment: "changes" },
						worktree,
						sessionId,
						{ replace: true },
					),
				);
				return;
			}
			const key = state.__TSR_key ?? state.key;
			if (key !== undefined && key === backingFrom) return;
			backingFrom = key;
			const stop = history.subscribe(() => {
				const now = history.location.state;
				if ((now.__TSR_key ?? now.key) === key) return;
				backingFrom = undefined;
				stop();
			});
			history.back();
		},
		[navigate, router],
	);
}
