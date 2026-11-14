import { useCallback } from "react";
import { cliLoginActions } from "../lib/cliLoginStore";
import { useWSStore } from "../lib/wsStore";
import type {
	CliProfileChangedNotification,
	CliProfileOverview,
} from "../types/cliProfile";
import { errorMessage } from "../utils/errorMessage";
import { useSubscription } from "./useSubscription";

/**
 * Follows every CLI's profiles into `cliLoginStore` while mounted, for the
 * screens that show or switch them — per screen, as `useCliLoginSubscription`
 * is. The server pushes only the changes it makes itself, so a fresh
 * subscribe is also how a screen catches up with a change another Pockode
 * process made.
 *
 * On a reset the store keeps the copy it has: the lists are the server's, and
 * the next subscribe's snapshot replaces it.
 */
export function useCliProfileSubscription(): void {
	const cliProfileSubscribe = useWSStore((s) => s.actions.cliProfileSubscribe);
	const cliProfileUnsubscribe = useWSStore(
		(s) => s.actions.cliProfileUnsubscribe,
	);

	const subscribe = useCallback(
		(callback: (params: CliProfileChangedNotification) => void) =>
			cliProfileSubscribe(callback),
		[cliProfileSubscribe],
	);

	useSubscription<CliProfileChangedNotification, CliProfileOverview>(
		subscribe,
		cliProfileUnsubscribe,
		(params) => cliLoginActions.applyProfiles(params.profiles),
		{
			// cli_profile is app-scoped: the list is the OS user's, not the worktree's.
			resubscribeOnWorktreeChange: false,
			onSubscribed: (initial) => cliLoginActions.applyProfiles(initial),
			onReset: () => {},
			onError: (err) => cliLoginActions.setProfilesError(errorMessage(err)),
		},
	);
}
