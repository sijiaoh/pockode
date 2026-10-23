import { Loader2 } from "lucide-react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { WORK_TYPE_PLURAL } from "../../lib/roleWorkType";
import type { WorkType } from "../../types/work";
import { Sheet } from "../ui";

interface Props {
	title: string;
	/** What the create sheet would have made; names the restriction to change. */
	workType: WorkType;
	onClose: () => void;
}

/**
 * What a create sheet opens as when no role can take what it makes — one
 * component, so the story and schedule sheets cannot word the same four facts
 * differently.
 *
 * An empty list of roles is three different facts, and only one of them is
 * "there are none": the app-wide subscription starts out loading and goes back
 * to loading on every reconnect, and it can fail outright. Saying "no agent
 * roles registered" to a user whose roles are merely on their way is the same
 * lie either of the other two states would tell.
 *
 * Roles that are all restricted to other kinds are a fourth fact, with its own
 * way out: the fix is a restriction to change, not a role to create.
 */
export default function NoEligibleRoleSheet({
	title,
	workType,
	onClose,
}: Props) {
	const roles = useAgentRoleStore((s) => s.roles);
	const rolesLoading = useAgentRoleStore((s) => s.isLoading);
	const rolesError = useAgentRoleStore((s) => s.error);
	const kind = WORK_TYPE_PLURAL[workType];

	return (
		<Sheet
			title={title}
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
						<p>No agent role takes {kind}.</p>
						<p className="text-th-text-muted">
							Set a role to take {kind} in{" "}
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
						    that tells the user nothing (docs/project-ui.md §4). */}
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
