import { ConfirmDialog } from "@pockode/shared";
import { useState } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import {
	RUNS_CHOICES,
	RUNS_HINT,
	RUNS_LABEL,
	type RunsChoice,
} from "../../lib/roleWorkType";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import ToggleGroup from "../ui/ToggleGroup";

/**
 * Which kind of work the role runs. Applies on tap like the engine beside it,
 * and shows the server's record rather than the tap: the lit segment moves
 * when the update comes back.
 *
 * The one tap that asks first is the default story role going task-only: the
 * server accepts it and clears the default, and that is a second setting
 * changing as a side effect of this one.
 */
export default function AgentRoleWorkTypeField({
	role,
	isDefaultStoryRole,
}: {
	role: AgentRole;
	isDefaultStoryRole: boolean;
}) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
	const workRefCount = useAgentRoleStore((s) => s.workRefCounts[role.id] ?? 0);
	const [error, setError] = useState<string | null>(null);
	const [confirmTaskOnly, setConfirmTaskOnly] = useState(false);

	const selected: RunsChoice = role.work_type ?? "";

	const apply = (workType: RunsChoice) => {
		setError(null);
		updateAgentRole({ id: role.id, work_type: workType }).catch(
			(err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			},
		);
	};

	const select = (workType: RunsChoice) => {
		if (workType === selected) return;
		if (workType === "task" && isDefaultStoryRole) {
			setConfirmTaskOnly(true);
			return;
		}
		apply(workType);
	};

	// The server checks a role's work type only when an assignment changes, so a
	// restriction never takes the role off work that already has it. Said
	// whenever anything uses the role, whatever type those items are: it states
	// the rule, which is true either way.
	const hint =
		selected && workRefCount > 0
			? `${RUNS_HINT[selected]} Work items already using it keep it.`
			: RUNS_HINT[selected];

	return (
		<>
			<ToggleGroup<RunsChoice>
				label="Runs"
				items={RUNS_CHOICES}
				selected={selected}
				onSelect={select}
				getInfo={(choice) => ({ label: RUNS_LABEL[choice] })}
				hint={hint}
				error={error}
			/>
			{confirmTaskOnly && (
				<ConfirmDialog
					title={`Make ${role.name} task-only?`}
					message={`${role.name} is the default story role. Making it task-only clears that default.`}
					confirmLabel="Make task-only"
					onConfirm={() => {
						setConfirmTaskOnly(false);
						apply("task");
					}}
					onCancel={() => setConfirmTaskOnly(false)}
				/>
			)}
		</>
	);
}
