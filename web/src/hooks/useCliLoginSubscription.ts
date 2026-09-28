import { useCallback } from "react";
import { cliLoginActions } from "../lib/cliLoginStore";
import { useWSStore } from "../lib/wsStore";
import type { CliLogin, CliLoginChangedNotification } from "../types/cliAuth";
import type { AgentType } from "../types/settings";
import { errorMessage } from "../utils/errorMessage";
import { useSubscription } from "./useSubscription";

/**
 * Follows the CLI's sign-in into `cliLoginStore` while mounted.
 *
 * Every screen showing a sign-in mounts this, rather than one subscription at
 * the top of the app: the store keeps what it last heard when nothing is
 * showing it, and the snapshot a fresh subscription answers with is the
 * server's current copy — running, or the last to end, including one that
 * succeeded while the page was away. A reconnect resubscribes the same way.
 *
 * On a reset the store keeps the copy it has: the flow is the server's, and a
 * dropped socket is the normal case while the user is in the browser.
 */
export function useCliLoginSubscription(agent: AgentType): void {
	const cliLoginSubscribe = useWSStore((s) => s.actions.cliLoginSubscribe);
	const cliLoginUnsubscribe = useWSStore((s) => s.actions.cliLoginUnsubscribe);

	const subscribe = useCallback(
		(callback: (params: CliLoginChangedNotification) => void) =>
			cliLoginSubscribe(agent, callback),
		[cliLoginSubscribe, agent],
	);

	useSubscription<CliLoginChangedNotification, CliLogin | null>(
		subscribe,
		cliLoginUnsubscribe,
		(params) => cliLoginActions.applyLogin(agent, params.login),
		{
			// cli_auth is app-scoped: its watcher does not go with the worktree.
			resubscribeOnWorktreeChange: false,
			onSubscribed: (initial) =>
				cliLoginActions.applyLogin(agent, initial ?? null),
			onReset: () => {},
			onError: (err) => cliLoginActions.setLoginError(agent, errorMessage(err)),
		},
	);
}
