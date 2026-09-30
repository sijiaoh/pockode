import { useCallback } from "react";
import { cliLoginActions } from "../lib/cliLoginStore";
import { useWSStore } from "../lib/wsStore";
import type {
	CliUpdate,
	CliUpdateChangedNotification,
} from "../types/cliUpdate";
import type { AgentType } from "../types/settings";
import { errorMessage } from "../utils/errorMessage";
import { useSubscription } from "./useSubscription";

/**
 * Follows the CLI's update into `cliLoginStore` while mounted — the sign-in's
 * arrangement (`useCliLoginSubscription`): the snapshot is the server's current
 * copy, running or the last to end, and on a reset the store keeps what it has,
 * since the update runs on without the socket.
 */
export function useCliUpdateSubscription(agent: AgentType): void {
	const cliUpdateSubscribe = useWSStore((s) => s.actions.cliUpdateSubscribe);
	const cliUpdateUnsubscribe = useWSStore(
		(s) => s.actions.cliUpdateUnsubscribe,
	);

	const subscribe = useCallback(
		(callback: (params: CliUpdateChangedNotification) => void) =>
			cliUpdateSubscribe(agent, callback),
		[cliUpdateSubscribe, agent],
	);

	useSubscription<CliUpdateChangedNotification, CliUpdate | null>(
		subscribe,
		cliUpdateUnsubscribe,
		(params) => cliLoginActions.applyUpdate(agent, params.update),
		{
			// cli_update is app-scoped: its watcher does not go with the worktree.
			resubscribeOnWorktreeChange: false,
			onSubscribed: (initial) =>
				cliLoginActions.applyUpdate(agent, initial ?? null),
			onReset: () => {},
			onError: (err) =>
				cliLoginActions.setUpdateError(agent, errorMessage(err)),
		},
	);
}
