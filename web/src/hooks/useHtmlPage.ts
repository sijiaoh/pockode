import { useQuery } from "@tanstack/react-query";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import type { HtmlPage } from "../lib/rpc";
import { useSessionView } from "../lib/sessionView";
import {
	isInvalidParamsRejection,
	isRPCTimeout,
	useWSStore,
} from "../lib/wsStore";

/**
 * Reads a page the agent drew by its id, from the transcript's own worktree
 * when it is being read from outside (as `useAttachmentContent` does).
 *
 * Never refetched while cached: a page never changes once drawn, so the id
 * names its content, and a replayed record names the same id every time.
 * `enabled` is how a card keeps a long session from pulling every page it
 * scrolls past.
 */
export function useHtmlPage(sessionId: string, id: string, enabled: boolean) {
	const getHtmlPage = useWSStore((state) => state.actions.getHtmlPage);
	const sessionViewHtmlPage = useWSStore(
		(state) => state.actions.sessionViewHtmlPage,
	);
	const view = useSessionView();

	return useQuery<HtmlPage>({
		// The worktree is part of the key: the same session id names a different
		// directory there.
		queryKey: view
			? (["html_page", view.worktree, sessionId, id] as const)
			: (["html_page", sessionId, id] as const),
		queryFn: () =>
			view
				? sessionViewHtmlPage(view.worktree, sessionId, id)
				: getHtmlPage(sessionId, id),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		// "Page not found" and "session not found" are InvalidParams, a verdict:
		// retrying would only hold the card on its loading placeholder through
		// the backoff. A timeout means the read was slow, and retrying would send
		// the whole page again while the first answer is likely on its way. A
		// lost connection or an internal error is worth asking again.
		retry: (failureCount, error) =>
			!isInvalidParamsRejection(error) &&
			!isRPCTimeout(error) &&
			failureCount < DEFAULT_RETRY_COUNT,
	});
}
