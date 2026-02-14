import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { useRoles } from "../../hooks/useRoles";
import { useTickets } from "../../hooks/useTickets";
import { useWSStore } from "../../lib/wsStore";
import BackToChatButton from "../ui/BackToChatButton";
import KanbanBoard from "./KanbanBoard";
import TicketCreateDialog from "./TicketCreateDialog";

interface Props {
	onBack: () => void;
	onSelectSession?: (sessionId: string) => void;
}

export default function TicketDashboardPage({
	onBack,
	onSelectSession,
}: Props) {
	const status = useWSStore((s) => s.status);
	const createTicket = useWSStore((s) => s.actions.createTicket);
	const deleteTicket = useWSStore((s) => s.actions.deleteTicket);
	const startTicket = useWSStore((s) => s.actions.startTicket);

	const { grouped, isLoading } = useTickets(status === "connected");
	useRoles();

	const [showCreateDialog, setShowCreateDialog] = useState(false);

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
			onSelectSession?.(result.session_id);
		},
		[startTicket, onSelectSession],
	);

	const handleViewSession = useCallback(
		(sessionId: string) => {
			onSelectSession?.(sessionId);
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
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Ticket Dashboard
				</h1>
				<button
					type="button"
					onClick={() => setShowCreateDialog(true)}
					className="flex items-center gap-1 rounded-lg bg-th-accent px-3 py-1.5 text-sm text-th-accent-text hover:bg-th-accent-hover"
				>
					<Plus className="h-4 w-4" />
					New
				</button>
			</header>

			<main className="min-h-0 flex-1 overflow-auto p-4">
				{isLoading ? (
					<div className="flex h-full items-center justify-center text-th-text-muted">
						Loading...
					</div>
				) : (
					<KanbanBoard
						grouped={grouped}
						onStartTicket={handleStart}
						onViewSession={handleViewSession}
						onDeleteTicket={handleDelete}
					/>
				)}
			</main>

			{showCreateDialog && (
				<TicketCreateDialog
					onSubmit={handleCreate}
					onCancel={() => setShowCreateDialog(false)}
				/>
			)}
		</div>
	);
}
