import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import { useRouteState } from "./useRouteState";

/**
 * Whether the session a page goes back to has something the user has not read.
 *
 * From the open session's own metadata, not from the list: the list is
 * narrowed server-side and leaves out exactly the session a work item drives
 * (docs/code/subscription-system.md#which-sessions-belong-to-work), so reading
 * it there would silently never light the dot for those.
 */
export function useOpenSessionUnread(): boolean {
	const { sessionId } = useRouteState();
	const detail = useSessionDetailStore(selectSessionDetail(sessionId));
	return detail?.unread ?? false;
}
