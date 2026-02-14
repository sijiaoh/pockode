import { useCallback, useEffect, useState } from "react";
import { useRoleStore } from "../lib/roleStore";
import { useWSStore } from "../lib/wsStore";
import type { AgentRole } from "../types/message";

/**
 * Hook to fetch and manage agent roles.
 * Roles are fetched once and cached in the store.
 */
export function useRoles() {
	const status = useWSStore((s) => s.status);
	const listRoles = useWSStore((s) => s.actions.listRoles);

	const roles = useRoleStore((s) => s.roles);
	const isLoading = useRoleStore((s) => s.isLoading);
	const isSuccess = useRoleStore((s) => s.isSuccess);
	const setRoles = useRoleStore((s) => s.setRoles);
	const addRole = useRoleStore((s) => s.addRole);
	const updateRoleInStore = useRoleStore((s) => s.updateRole);
	const removeRole = useRoleStore((s) => s.removeRole);
	const reset = useRoleStore((s) => s.reset);

	const [error, setError] = useState<Error | null>(null);

	// Fetch roles when connected
	useEffect(() => {
		if (status !== "connected") {
			reset();
			return;
		}

		let cancelled = false;

		async function fetchRoles() {
			try {
				const result = await listRoles();
				if (!cancelled) {
					setRoles(result.roles);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) {
					setError(
						err instanceof Error ? err : new Error("Failed to fetch roles"),
					);
				}
			}
		}

		fetchRoles();

		return () => {
			cancelled = true;
		};
	}, [status, listRoles, setRoles, reset]);

	const refresh = useCallback(async () => {
		if (status !== "connected") return;
		try {
			const result = await listRoles();
			setRoles(result.roles);
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err : new Error("Failed to refresh roles"),
			);
		}
	}, [status, listRoles, setRoles]);

	return {
		roles,
		isLoading,
		isSuccess,
		error,
		refresh,
		// Store actions for optimistic updates
		addRole,
		updateRole: updateRoleInStore,
		removeRole,
	};
}

/**
 * Hook to get a role by ID.
 */
export function useRole(roleId: string | undefined): AgentRole | undefined {
	return useRoleStore((s) => s.roles.find((r) => r.id === roleId));
}
