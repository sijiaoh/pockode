import { Loader2 } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import {
	RUNS_CHOICES,
	RUNS_HINT,
	RUNS_LABEL,
	type RunsChoice,
} from "../../lib/roleWorkType";
import { useWSStore } from "../../lib/wsStore";
import { Sheet } from "../ui";
import { inputClass } from "../ui/inputClass";
import ToggleGroup from "../ui/ToggleGroup";

interface Props {
	onClose: () => void;
	/**
	 * The role that now exists. The caller navigates to it, for the reason
	 * `CreateStorySheet` gives: `AppShell` owns every navigation in the app.
	 */
	onCreated: (roleId: string) => void;
}

/**
 * The name and what the role runs, and nothing else: the role prompt, the
 * engine and the steps all have their editors on the detail page the user
 * lands on the moment this succeeds (docs/agent-roles-ui.md).
 *
 * Tasks is preselected: nobody creates a task by hand and the default story
 * role is usually already there, so a new role is almost always one for story
 * agents to hand tasks to.
 */
export default function CreateAgentRoleSheet({ onClose, onCreated }: Props) {
	const nameFieldId = useId();
	const [name, setName] = useState("");
	const [runs, setRuns] = useState<RunsChoice>("task");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createAgentRole = useWSStore((s) => s.actions.createAgentRole);
	const addCreatedRole = useAgentRoleStore((s) => s.addCreatedRole);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmed = name.trim();
			if (!trimmed || isSubmitting) return;

			setError(null);
			setIsSubmitting(true);
			try {
				const created = await createAgentRole({
					name: trimmed,
					role_prompt: "",
					...(runs && { work_type: runs }),
				});
				// The detail page reads the role from the list store.
				addCreatedRole(created);
				// The busy flag stays set: the caller closes this sheet, and until
				// it does a second submit would create a second role.
				onCreated(created.id);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create role");
				setIsSubmitting(false);
			}
		},
		[name, runs, isSubmitting, createAgentRole, addCreatedRole, onCreated],
	);

	return (
		<Sheet
			title="New Role"
			onClose={onClose}
			dismissible={!isSubmitting}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={isSubmitting}
						className="min-h-[44px] flex-1 rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!name.trim() || isSubmitting}
						className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isSubmitting ? (
							<Loader2 className="size-4 animate-spin" aria-label="Creating" />
						) : (
							"Create"
						)}
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				<div className="space-y-1.5">
					<label htmlFor={nameFieldId} className="text-sm text-th-text-primary">
						Name
					</label>
					<input
						id={nameFieldId}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Role name"
						disabled={isSubmitting}
						autoComplete="off"
						className={`min-h-[44px] w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
					/>
				</div>

				<ToggleGroup<RunsChoice>
					label="Runs"
					items={RUNS_CHOICES}
					selected={runs}
					onSelect={setRuns}
					getInfo={(choice) => ({ label: RUNS_LABEL[choice] })}
					hint={RUNS_HINT[runs]}
				/>

				{error && (
					<p className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
