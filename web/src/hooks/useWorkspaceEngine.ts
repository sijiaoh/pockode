import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import { type GlobalEngine, useGlobalEngine } from "./useGlobalEngine";
import { useRouteState } from "./useRouteState";

/**
 * The engine a one-off AI call from the Git workspace runs on: that of the
 * session the workspace was opened over (its URL's `session`), or the global
 * default when there is none or this worktree does not have it.
 *
 * One hook for both the label and the request, so the engine the UI names is
 * the engine that is billed (docs/git-ui.md#drafting-the-message-with-ai). The
 * session's detail is already held: the shell subscribes to the route's session
 * whatever overlay is up, the workspace included.
 */
export function useWorkspaceEngine(): GlobalEngine {
	const { sessionId } = useRouteState();
	const detail = useSessionDetailStore(selectSessionDetail(sessionId));
	const { engine } = useGlobalEngine();
	return detail
		? {
				agentType: detail.agent_type,
				model: detail.model,
				effort: detail.effort,
			}
		: engine;
}
