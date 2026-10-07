import type { AgentRole } from "../types/agentRole";
import type { WorkType } from "../types/work";

/**
 * Whether `role` may be assigned to a work item of `type` — the client's copy
 * of the server's `AgentRole.AcceptsWorkType`. Every filter and check here
 * asks this, so "absent means either" is written once.
 */
export function roleAcceptsWorkType(role: AgentRole, type: WorkType): boolean {
	return !role.work_type || role.work_type === type;
}

/** How the UI names many of a kind: "No role takes tasks." */
export const WORK_TYPE_PLURAL: Record<WorkType, string> = {
	story: "stories",
	task: "tasks",
};

/**
 * `stories only` / `tasks only`, or `null` for a role that takes either. The
 * one wording for a restriction, wherever a role is named beside it.
 */
export function workTypeSuffix(role: AgentRole): string | null {
	return role.work_type ? `${WORK_TYPE_PLURAL[role.work_type]} only` : null;
}
