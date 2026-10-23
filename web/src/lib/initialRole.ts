import type { AgentRole } from "../types/agentRole";
import { roleAcceptsWorkType } from "./roleWorkType";

/**
 * Which role a new story starts out on, or `""` when the user has to pick one.
 * `CreateStorySheet` preselects with it, and the agent role list's default
 * story role field describes it in words — one rule, because a sentence that
 * describes the create form's behaviour from its own copy of the rule starts
 * lying the day the rule changes, with nothing to turn red.
 *
 * A single role wins over the stored default: there is nothing to choose
 * between, so asking would be a question with one answer. A stored default that
 * is no longer in the list does not preselect — it names a role that is gone.
 *
 * Only roles that take stories count, for both rules: a default restricted to
 * tasks is no default at all rather than a choice the server would refuse.
 * Tasks have no initial role — their story's agent names one with
 * `task_create`, and nobody creates them here.
 */
export function resolveInitialRole(
	roles: AgentRole[],
	defaultRoleId: string,
): string {
	const eligible = roles.filter((r) => roleAcceptsWorkType(r, "story"));
	if (eligible.length === 1) return eligible[0].id;
	if (defaultRoleId && eligible.some((r) => r.id === defaultRoleId))
		return defaultRoleId;
	return "";
}

/**
 * Whether `role` is the default story role as far as new stories are
 * concerned. A task-only role the stored default names — only a settings file
 * edited by hand leaves one — is not: new stories ignore it.
 */
export function isDefaultStoryRole(
	role: AgentRole,
	defaultRoleId: string,
): boolean {
	return role.id === defaultRoleId && roleAcceptsWorkType(role, "story");
}

/**
 * Which role a new schedule starts out on, or `""` when the user has to pick
 * one (docs/schedule-ui.md §5). There is no stored default for jobs, so the
 * rule is the story rule's first half, plus one step for the usual shape of a
 * role list: several roles that take any work, and one restricted to jobs —
 * the seeded job role — which is the one meant.
 */
export function resolveInitialJobRole(roles: AgentRole[]): string {
	const eligible = roles.filter((r) => roleAcceptsWorkType(r, "job"));
	if (eligible.length === 1) return eligible[0].id;
	const jobsOnly = eligible.filter((r) => r.work_type === "job");
	if (jobsOnly.length === 1) return jobsOnly[0].id;
	return "";
}
