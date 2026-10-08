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

/** What a role may run, as `agent_role.update` writes it: `""` is "Both". */
export type RunsChoice = WorkType | "";

/** The order the choices are offered in, and the order the role list groups by. */
export const RUNS_CHOICES: readonly RunsChoice[] = ["story", "task", ""];

export const RUNS_LABEL: Record<RunsChoice, string> = {
	story: "Stories",
	task: "Tasks",
	"": "Both",
};

/**
 * What each choice means for where the role turns up. Tasks are never made by
 * hand, so a task role is one a story agent picks.
 */
export const RUNS_HINT: Record<RunsChoice, string> = {
	story: "Runs stories. Can be the default story role.",
	task: "Picked by story agents for the tasks they create.",
	"": "Can run stories and tasks.",
};
