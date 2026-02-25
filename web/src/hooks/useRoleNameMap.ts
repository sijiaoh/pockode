import { useMemo } from "react";
import { useAgentRoleStore } from "../lib/agentRoleStore";

export function useRoleNameMap(): Map<string, string> {
	const roles = useAgentRoleStore((s) => s.roles);
	return useMemo(() => {
		const map = new Map<string, string>();
		for (const r of roles) {
			map.set(r.id, r.name);
		}
		return map;
	}, [roles]);
}
