import { useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Settings } from "lucide-react";
import { useCallback } from "react";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import { useSidebarRefresh } from "../Layout";

function TeamTab() {
	const { isActive } = useSidebarRefresh("team");
	const navigate = useNavigate();
	const worktree = useCurrentWorktree();
	const { sessionId } = useRouteState();

	const handleOpenTickets = useCallback(() => {
		navigate(overlayToNavigation({ type: "tickets" }, worktree, sessionId));
	}, [navigate, worktree, sessionId]);

	const handleOpenAgentRoles = useCallback(() => {
		navigate(overlayToNavigation({ type: "agent-roles" }, worktree, sessionId));
	}, [navigate, worktree, sessionId]);

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<div className="flex flex-col gap-3 p-4">
				<button
					type="button"
					onClick={handleOpenTickets}
					className="flex items-center gap-3 rounded-lg bg-th-bg-tertiary p-4 text-left hover:bg-th-bg-hover"
				>
					<LayoutDashboard className="h-6 w-6 text-th-accent" />
					<div>
						<div className="font-medium text-th-text-primary">
							Ticket Dashboard
						</div>
						<div className="text-sm text-th-text-muted">
							Manage tickets and agent tasks
						</div>
					</div>
				</button>

				<button
					type="button"
					onClick={handleOpenAgentRoles}
					className="flex items-center gap-3 rounded-lg bg-th-bg-tertiary p-4 text-left hover:bg-th-bg-hover"
				>
					<Settings className="h-6 w-6 text-th-text-muted" />
					<div>
						<div className="font-medium text-th-text-primary">Agent Roles</div>
						<div className="text-sm text-th-text-muted">
							Configure agent roles and prompts
						</div>
					</div>
				</button>
			</div>
		</div>
	);
}

export default TeamTab;
