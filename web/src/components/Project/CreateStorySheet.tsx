import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { resolveInitialRole } from "../../lib/initialRole";
import { roleAcceptsWorkType } from "../../lib/roleWorkType";
import { useSettingsStore } from "../../lib/settingsStore";
import { useWSStore } from "../../lib/wsStore";
import { Sheet } from "../ui";
import { inputClass } from "../ui/inputClass";
import RoleSelect from "./RoleSelect";

interface Props {
	onClose: () => void;
	/**
	 * The work that now exists. The caller navigates to it — this component
	 * never routes itself, because `AppShell` owns every navigation in the app
	 * and a second one here is a second place worktree-aware URLs get built
	 * (docs/project-ui.md §4).
	 */
	onCreated: (workId: string) => void;
}

const TITLE = "New Story";

/**
 * The two fields the server requires, and no others (docs/project-ui.md §4).
 *
 * Stories only: a task is created by its story's agent with `task_create`,
 * never by hand, and `work.create` refuses to make one.
 *
 * The description is deliberately absent: it is the brief the agent reads, it
 * is usually several paragraphs, and its editor is on the detail page the user
 * lands on the moment this succeeds. A second editor here would be two places
 * to write one field.
 *
 * Nothing here focuses the title on open, against §4's sketch of the sequence:
 * `Sheet` deliberately takes focus itself so the sheet's title is announced
 * before anything else, and it does so after this component's effects have
 * run. Focusing the field would mean outliving that on a timer, which trades a
 * documented shared-component decision for a race.
 */
export default function CreateStorySheet({ onClose, onCreated }: Props) {
	const titleFieldId = useId();
	const roleFieldId = useId();
	const [title, setTitle] = useState("");
	const [agentRoleId, setAgentRoleId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createWork = useWSStore((s) => s.actions.createWork);
	const roles = useAgentRoleStore((s) => s.roles);
	const rolesLoading = useAgentRoleStore((s) => s.isLoading);
	const rolesError = useAgentRoleStore((s) => s.error);
	const defaultRoleId = useSettingsStore(
		(s) => s.settings?.default_agent_role_id ?? "",
	);

	const selectedRole = roles.find((r) => r.id === agentRoleId);
	const selectedRoleFits =
		selectedRole !== undefined && roleAcceptsWorkType(selectedRole, "story");
	const hasEligibleRole = roles.some((r) => roleAcceptsWorkType(r, "story"));

	// The roles can arrive after the sheet opens, so this runs on every change
	// until one sticks — and never overwrites a role the user picked.
	//
	// The one exception is a pick that stopped taking stories while the sheet
	// was open (restricted elsewhere): the server would refuse it, and keeping
	// it selected beside a disabled Create explains nothing. Dropping it puts
	// the field back where opening the sheet would have, rule and all.
	useEffect(() => {
		if (selectedRole && !selectedRoleFits) {
			setAgentRoleId("");
			return;
		}
		if (!agentRoleId) {
			const initial = resolveInitialRole(roles, defaultRoleId);
			if (initial) setAgentRoleId(initial);
		}
	}, [roles, defaultRoleId, agentRoleId, selectedRole, selectedRoleFits]);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmed = title.trim();
			if (!trimmed || !selectedRoleFits || isSubmitting) return;

			setError(null);
			setIsSubmitting(true);
			try {
				const created = await createWork({
					agent_role_id: agentRoleId,
					title: trimmed,
				});
				// `work.create` answers with the created work, so the destination is
				// already here; nothing waits for the list notification to arrive.
				// The busy flag is left set: the caller closes this sheet, and until
				// it does, a second submit would create a second work.
				onCreated(created.id);
			} catch (err) {
				// The sheet stays open on a failure, with the typed title intact:
				// the one thing the user would have to retype is the one thing the
				// server never received.
				setError(err instanceof Error ? err.message : "Failed to create story");
				setIsSubmitting(false);
			}
		},
		[title, agentRoleId, selectedRoleFits, createWork, isSubmitting, onCreated],
	);

	// An empty list of roles is three different facts, and only one of them is
	// "there are none": the app-wide subscription starts out loading and goes
	// back to loading on every reconnect, and it can fail outright. Saying "no
	// agent roles registered" to a user whose roles are merely on their way is
	// the same lie either of the other two states would tell.
	//
	// Roles that all take tasks only are a fourth fact, with its own
	// way out: the fix is a restriction to change, not a role to create.
	if (!hasEligibleRole) {
		return (
			<Sheet
				title={TITLE}
				onClose={onClose}
				footer={
					<button
						type="button"
						onClick={onClose}
						className="min-h-[44px] flex-1 rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-opacity hover:opacity-90"
					>
						Close
					</button>
				}
			>
				<div className="space-y-1 p-4 text-sm text-th-text-secondary">
					{rolesError ? (
						<p className="text-th-error" role="alert">
							{rolesError}
						</p>
					) : rolesLoading ? (
						<div className="flex items-center gap-2 text-th-text-muted">
							<Loader2 className="size-4 animate-spin" />
							<p>Loading roles...</p>
						</div>
					) : roles.length > 0 ? (
						<>
							<p>No agent role takes stories.</p>
							<p className="text-th-text-muted">
								Set a role to take stories in{" "}
								<span className="font-medium text-th-text-secondary">
									Agent Roles
								</span>{" "}
								first.
							</p>
						</>
					) : (
						<>
							{/* The control opened rather than refusing to: a disabled
							    button with no explanation is the one version of this
							    that tells the user nothing (§4). */}
							<p>No agent roles registered.</p>
							{/* Where to go next: the list this opens from is not
							    where roles are made. */}
							<p className="text-th-text-muted">
								Create a role in{" "}
								<span className="font-medium text-th-text-secondary">
									Agent Roles
								</span>{" "}
								first.
							</p>
						</>
					)}
				</div>
			</Sheet>
		);
	}

	return (
		<Sheet
			title={TITLE}
			onClose={onClose}
			// Cancel is already disabled while creating; the backdrop and Escape
			// have to agree with it, or the sheet vanishes mid-create and leaves
			// the user unsure whether a work was made.
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
						disabled={!title.trim() || !selectedRoleFits || isSubmitting}
						className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isSubmitting ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Create"
						)}
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				<div className="space-y-1.5">
					<label
						htmlFor={titleFieldId}
						className="text-sm text-th-text-primary"
					>
						Title
					</label>
					<input
						id={titleFieldId}
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Story title"
						disabled={isSubmitting}
						autoComplete="off"
						className={`min-h-[44px] w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
					/>
				</div>

				<div className="space-y-1.5">
					<label htmlFor={roleFieldId} className="text-sm text-th-text-primary">
						Role
					</label>
					<RoleSelect
						id={roleFieldId}
						value={agentRoleId}
						onChange={setAgentRoleId}
						emptyLabel="Select role..."
						workType="story"
						disabled={isSubmitting}
					/>
				</div>

				{error && (
					<p className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
