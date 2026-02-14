import { Plus, Settings } from "lucide-react";
import { useCallback, useState } from "react";
import { useRoles } from "../../hooks/useRoles";
import { useTickets } from "../../hooks/useTickets";
import { useWSStore } from "../../lib/wsStore";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import AgentSettingsOverlay from "./AgentSettingsOverlay";
import KanbanBoard from "./KanbanBoard";
import TicketCreateDialog from "./TicketCreateDialog";

interface Props {
	onSelectSession: (sessionId: string) => void;
}

function TeamTab({ onSelectSession }: Props) {
	const status = useWSStore((s) => s.status);
	const createTicket = useWSStore((s) => s.actions.createTicket);
	const deleteTicket = useWSStore((s) => s.actions.deleteTicket);
	const startTicket = useWSStore((s) => s.actions.startTicket);

	const { grouped, isLoading, refresh } = useTickets(status === "connected");
	const { isActive } = useSidebarRefresh("team", refresh);
	useRoles(); // Fetch roles for ticket creation

	const [showCreateDialog, setShowCreateDialog] = useState(false);
	const [showSettings, setShowSettings] = useState(false);

	const handleCreate = useCallback(
		async (data: { title: string; description: string; roleId: string }) => {
			await createTicket({
				title: data.title,
				description: data.description,
				role_id: data.roleId,
			});
			setShowCreateDialog(false);
		},
		[createTicket],
	);

	const handleStart = useCallback(
		async (ticketId: string) => {
			const result = await startTicket(ticketId);
			onSelectSession(result.session_id);
		},
		[startTicket, onSelectSession],
	);

	const handleViewSession = useCallback(
		(sessionId: string) => {
			onSelectSession(sessionId);
		},
		[onSelectSession],
	);

	const handleDelete = useCallback(
		async (ticketId: string) => {
			await deleteTicket(ticketId);
		},
		[deleteTicket],
	);

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<div className="flex items-center gap-2 p-2">
				<button
					type="button"
					onClick={() => setShowCreateDialog(true)}
					className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent p-3 text-th-accent-text hover:bg-th-accent-hover"
				>
					<Plus className="h-5 w-5" aria-hidden="true" />
					New Ticket
				</button>
				<button
					type="button"
					onClick={() => setShowSettings(true)}
					className="rounded-lg bg-th-bg-tertiary p-3 text-th-text-muted hover:text-th-text-primary"
					title="Agent Settings"
				>
					<Settings className="h-5 w-5" aria-hidden="true" />
				</button>
			</div>

			<PullToRefresh onRefresh={refresh}>
				{isLoading ? (
					<div className="p-4 text-center text-th-text-muted">Loading...</div>
				) : (
					<KanbanBoard
						grouped={grouped}
						onStartTicket={handleStart}
						onViewSession={handleViewSession}
						onDeleteTicket={handleDelete}
					/>
				)}
			</PullToRefresh>

			{showCreateDialog && (
				<TicketCreateDialog
					onSubmit={handleCreate}
					onCancel={() => setShowCreateDialog(false)}
				/>
			)}

			{showSettings && (
				<AgentSettingsOverlay onClose={() => setShowSettings(false)} />
			)}
		</div>
	);
}

export default TeamTab;
