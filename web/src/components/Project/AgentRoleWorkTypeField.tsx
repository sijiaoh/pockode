import { useState } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import type { WorkType } from "../../types/work";
import ToggleGroup from "../ui/ToggleGroup";

/** `""` is "Both": the value `agent_role.update` takes to clear the restriction. */
type Choice = WorkType | "";

const CHOICES: readonly Choice[] = ["", "story", "task"];

const LABEL: Record<Choice, string> = {
	"": "Both",
	story: "Stories",
	task: "Tasks",
};

const HINT: Record<Choice, string> = {
	"": "Can be assigned to stories and tasks.",
	story: "Can only be assigned to stories.",
	task: "Can only be assigned to tasks.",
};

/**
 * Which kind of work the role may be assigned to. Applies on tap like the
 * engine above it, and shows the server's record rather than the tap: the lit
 * segment moves when the update comes back.
 */
export default function AgentRoleWorkTypeField({ role }: { role: AgentRole }) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
	const workRefCount = useAgentRoleStore((s) => s.workRefCounts[role.id] ?? 0);
	const [error, setError] = useState<string | null>(null);

	const selected: Choice = role.work_type ?? "";

	const select = (workType: Choice) => {
		setError(null);
		updateAgentRole({ id: role.id, work_type: workType }).catch(
			(err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			},
		);
	};

	// The server checks a role's work type only when an assignment changes, so a
	// restriction never takes the role off work that already has it. Said
	// whenever anything uses the role, whatever type those items are: it states
	// the rule, which is true either way.
	const hint =
		selected && workRefCount > 0
			? `${HINT[selected]} Work items already using it keep it.`
			: HINT[selected];

	return (
		<ToggleGroup<Choice>
			label="Work type"
			items={CHOICES}
			selected={selected}
			onSelect={select}
			getInfo={(choice) => ({ label: LABEL[choice] })}
			hint={hint}
			error={error}
		/>
	);
}
