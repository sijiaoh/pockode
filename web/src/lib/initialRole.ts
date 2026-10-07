import type { AgentRole } from "../types/agentRole";
import type { WorkType } from "../types/work";
import { roleAcceptsWorkType } from "./roleWorkType";

/**
 * Which role a new story or task starts out on, or `""` when the user has to
 * pick one. `CreateWorkSheet` preselects with it, and the agent role list's
 * footer describes it in words — one rule, because a sentence that describes
 * the create form's behaviour from its own copy of the rule starts lying the
 * day the rule changes, with nothing to turn red.
 *
 * A single role wins over the stored default: there is nothing to choose
 * between, so asking would be a question with one answer. A stored default that
 * is no longer in the list does not preselect — it names a role that is gone.
 *
 * Only roles that take `workType` count, for both rules: the default is one
 * setting shared by stories and tasks, so a default restricted to the other
 * kind is no default at all here rather than a choice the server would refuse.
 */
export function resolveInitialRole(
	roles: AgentRole[],
	defaultRoleId: string,
	workType: WorkType,
): string {
	const eligible = roles.filter((r) => roleAcceptsWorkType(r, workType));
	if (eligible.length === 1) return eligible[0].id;
	if (defaultRoleId && eligible.some((r) => r.id === defaultRoleId))
		return defaultRoleId;
	return "";
}
