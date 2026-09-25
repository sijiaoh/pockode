import { useCallback } from "react";
import { useAgentRoleStore } from "../lib/agentRoleStore";
import { useWSStore } from "../lib/wsStore";
import type {
	AgentRoleListChangedNotification,
	AgentRoleListSubscribeResult,
} from "../types/agentRole";
import { useSubscription } from "./useSubscription";

export function useAgentRoleSubscription(enabled: boolean) {
	const agentRoleListSubscribe = useWSStore(
		(s) => s.actions.agentRoleListSubscribe,
	);
	const agentRoleListUnsubscribe = useWSStore(
		(s) => s.actions.agentRoleListUnsubscribe,
	);

	const setRoles = useAgentRoleStore((s) => s.setRoles);
	const updateRoles = useAgentRoleStore((s) => s.updateRoles);
	const setWorkRefCounts = useAgentRoleStore((s) => s.setWorkRefCounts);
	const setError = useAgentRoleStore((s) => s.setError);
	const reset = useAgentRoleStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: AgentRoleListChangedNotification) => {
			if (params.operation === "sync") {
				setRoles(params.roles);
				return;
			}
			if (params.operation === "ref_counts") {
				// Always the whole map: the counts live in the work store, so
				// they move without any role changing and are never patched.
				setWorkRefCounts(params.work_ref_counts);
				return;
			}
			updateRoles((old) => {
				switch (params.operation) {
					case "create":
						if (old.some((r) => r.id === params.role.id)) {
							return old.map((r) =>
								r.id === params.role.id ? params.role : r,
							);
						}
						return [...old, params.role];
					case "update":
						return old.map((r) => (r.id === params.role.id ? params.role : r));
					case "delete":
						return old.filter((r) => r.id !== params.roleId);
				}
			});
		},
		[setRoles, updateRoles, setWorkRefCounts],
	);

	const handleError = useCallback(
		(err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to load agent roles";
			setError(message);
		},
		[setError],
	);

	const applyInitial = useCallback(
		(initial: AgentRoleListSubscribeResult) => {
			setRoles(initial.items);
			setWorkRefCounts(initial.work_ref_counts);
		},
		[setRoles, setWorkRefCounts],
	);

	const { refresh } = useSubscription<
		AgentRoleListChangedNotification,
		AgentRoleListSubscribeResult
	>(agentRoleListSubscribe, agentRoleListUnsubscribe, handleNotification, {
		enabled,
		resubscribeOnWorktreeChange: false,
		onSubscribed: applyInitial,
		onReset: reset,
		onError: handleError,
	});

	return { refresh };
}
