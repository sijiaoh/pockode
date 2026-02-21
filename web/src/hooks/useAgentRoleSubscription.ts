import { useCallback } from "react";
import { useAgentRoleStore } from "../lib/agentRoleStore";
import { useWSStore } from "../lib/wsStore";
import type {
	AgentRole,
	AgentRoleListChangedNotification,
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
	const setError = useAgentRoleStore((s) => s.setError);
	const reset = useAgentRoleStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: AgentRoleListChangedNotification) => {
			if (params.operation === "sync") {
				setRoles(params.roles);
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
		[setRoles, updateRoles],
	);

	const handleError = useCallback(
		(err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to load agent roles";
			setError(message);
		},
		[setError],
	);

	const { refresh } = useSubscription<
		AgentRoleListChangedNotification,
		AgentRole[]
	>(agentRoleListSubscribe, agentRoleListUnsubscribe, handleNotification, {
		enabled,
		resubscribeOnWorktreeChange: false,
		onSubscribed: setRoles,
		onReset: reset,
		onError: handleError,
	});

	return { refresh };
}
