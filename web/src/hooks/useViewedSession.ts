import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import { isInvalidParamsRejection, useWSStore } from "../lib/wsStore";
import type { ChatMessagesHistoryPage, SessionDetail } from "../types/message";

/**
 * A session read out of a worktree the connection is not bound to: everything
 * the screen needs about it, from the two `session_view.*` reads that answer
 * for it.
 */
export interface ViewedSession {
	/** The worktree it is read from; "" is the main worktree. */
	worktree: string;
	/** Its metadata, and null until the read answers. */
	detail: SessionDetail | null;
	/**
	 * The newest page of its transcript — what subscribing would otherwise have
	 * handed over — and null until it arrives.
	 */
	page: ChatMessagesHistoryPage | null;
	/** Whether both reads have answered, whether or not they answered well. */
	isSettled: boolean;
	/** The server said there is no such session in that worktree. */
	isMissing: boolean;
	/** Why the read failed, for anything that is not a missing session. */
	error: string | null;
}

/** Whichever reason is the one to show, and null when neither read failed. */
function readError(...errors: unknown[]): string | null {
	for (const error of errors) {
		if (!error) continue;
		return error instanceof Error && error.message
			? error.message
			: "Unknown error";
	}
	return null;
}

/**
 * Reads one session out of another worktree — including one whose worktree has
 * been deleted, whose session data the server deliberately keeps.
 *
 * Both reads live here rather than one here and one in the transcript hook,
 * because there is one question on screen — *can this conversation be read* —
 * and it must have one answer. Split across two hooks, a transcript that failed
 * while the metadata arrived would show as an empty conversation, which is the
 * one thing a failure must never be allowed to say.
 *
 * Neither read is a subscription and neither ever re-runs on its own: what is
 * read belongs to a conversation the reader cannot take part in, so there is no
 * update this screen could follow. Installing a page also replaces the
 * transcript wholesale and starts paging over, so a refetch behind the reader's
 * back would throw away every earlier page they had pulled in.
 *
 * Deliberately outside `sessionDetailStore`, which holds *the open session* of
 * the bound worktree and is cleared whenever that subscription resets. Writing
 * another worktree's session into it would make those resets erase this screen.
 */
export function useViewedSession(
	worktree: string,
	sessionId: string,
	enabled: boolean,
): ViewedSession | null {
	const sessionViewGet = useWSStore((s) => s.actions.sessionViewGet);
	const sessionViewHistory = useWSStore((s) => s.actions.sessionViewHistory);

	const isEnabled = enabled && sessionId !== "";
	const shared = {
		enabled: isEnabled,
		staleTime: Number.POSITIVE_INFINITY,
		// A session the server refuses to name is not there, and asking again will
		// not change that.
		retry: (failureCount: number, err: unknown) =>
			!isInvalidParamsRejection(err) && failureCount < DEFAULT_RETRY_COUNT,
	};

	const detail = useQuery({
		...shared,
		queryKey: ["session-view-detail", worktree, sessionId],
		queryFn: () => sessionViewGet(worktree, sessionId),
	});

	const page = useQuery({
		...shared,
		queryKey: ["session-view-history", worktree, sessionId],
		queryFn: () => sessionViewHistory(worktree, sessionId),
	});

	const detailData = detail.data;
	const detailError = detail.error;
	const pageData = page.data;
	const pageError = page.error;

	// A disabled query still hands back whatever is cached under its key, and the
	// same session is reachable both ways — read out of main from another
	// worktree, then opened in main for real. Answering at all for a screen that
	// is in no view is how that cache would leak into it.
	return useMemo(() => {
		if (!isEnabled) return null;
		const isMissing =
			isInvalidParamsRejection(detailError) ||
			isInvalidParamsRejection(pageError);
		return {
			worktree,
			detail: detailData ?? null,
			page: pageData ?? null,
			isSettled:
				(detailData !== undefined || detailError !== null) &&
				(pageData !== undefined || pageError !== null),
			// Either read refusing is enough: both name the same session in the
			// same worktree, so one of them being told there is no such session is
			// the answer for both.
			isMissing,
			// Separate from `isMissing` because they send the reader different
			// ways: "it is not there" is final, anything else is worth reloading.
			error: isMissing ? null : readError(detailError, pageError),
		};
	}, [isEnabled, worktree, detailData, detailError, pageData, pageError]);
}
