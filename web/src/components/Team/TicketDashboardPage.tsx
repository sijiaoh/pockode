import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { useRoles } from "../../hooks/useRoles";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { useTickets } from "../../hooks/useTickets";
import { overlayToNavigation } from "../../lib/navigation";
import { toast } from "../../lib/toastStore";
import { useWSStore } from "../../lib/wsStore";
import type { Ticket, TicketStatus } from "../../types/message";
import BackToChatButton from "../ui/BackToChatButton";
import AutorunToggle from "./AutorunToggle";
import KanbanBoard from "./KanbanBoard";
import TicketEditorOverlay from "./TicketEditorOverlay";

interface Props {
	onBack: () => void;
	onSelectSession?: (sessionId: string) => void;
}

export default function TicketDashboardPage({
	onBack,
	onSelectSession,
}: Props) {
	const navigate = useNavigate();
	const worktree = useCurrentWorktree();
	const { sessionId } = useRouteState();

	const status = useWSStore((s) => s.status);
	const createTicket = useWSStore((s) => s.actions.createTicket);
	const updateTicket = useWSStore((s) => s.actions.updateTicket);
	const deleteTicket = useWSStore((s) => s.actions.deleteTicket);
	const deleteTicketsByStatus = useWSStore(
		(s) => s.actions.deleteTicketsByStatus,
	);
	const startTicket = useWSStore((s) => s.actions.startTicket);

	const { grouped, isLoading } = useTickets(status === "connected");
	useRoles();

	const [showCreateDialog, setShowCreateDialog] = useState(false);
	const [editingTicket, setEditingTicket] = useState<Ticket | null>(null);

	const handleCreate = useCallback(
		async (data: { title: string; description: string; roleId: string }) => {
			try {
				await createTicket({
					title: data.title,
					description: data.description,
					role_id: data.roleId,
				});
				setShowCreateDialog(false);
			} catch (err) {
				toast.error("Failed to create ticket");
				console.error("Failed to create ticket:", err);
			}
		},
		[createTicket],
	);

	const handleStart = useCallback(
		async (ticketId: string) => {
			try {
				const result = await startTicket(ticketId);
				onSelectSession?.(result.session_id);
			} catch (err) {
				toast.error("Failed to start ticket");
				console.error("Failed to start ticket:", err);
			}
		},
		[startTicket, onSelectSession],
	);

	const handleViewSession = useCallback(
		(sid: string) => {
			onSelectSession?.(sid);
		},
		[onSelectSession],
	);

	const handleViewTicketDetail = useCallback(
		(ticketId: string) => {
			navigate(
				overlayToNavigation(
					{ type: "ticket-detail", ticketId },
					worktree,
					sessionId,
				),
			);
		},
		[navigate, worktree, sessionId],
	);

	const handleDelete = useCallback(
		async (ticketId: string) => {
			try {
				await deleteTicket(ticketId);
			} catch (err) {
				toast.error("Failed to delete ticket");
				console.error("Failed to delete ticket:", err);
			}
		},
		[deleteTicket],
	);

	const handleDeleteAllByStatus = useCallback(
		async (ticketStatus: TicketStatus) => {
			try {
				await deleteTicketsByStatus(ticketStatus);
			} catch (err) {
				toast.error("Failed to delete tickets");
				console.error("Failed to delete tickets by status:", err);
			}
		},
		[deleteTicketsByStatus],
	);

	const handleEdit = useCallback(
		async (
			ticketId: string,
			updates: {
				title?: string;
				description?: string;
				status?: TicketStatus;
				priority?: number;
			},
		) => {
			try {
				await updateTicket(ticketId, updates);
				setEditingTicket(null);
			} catch (err) {
				toast.error("Failed to update ticket");
				console.error("Failed to update ticket:", err);
			}
		},
		[updateTicket],
	);

	const handleCancelCreate = useCallback(() => {
		setShowCreateDialog(false);
	}, []);

	const handleCloseEdit = useCallback(() => {
		setEditingTicket(null);
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Ticket Dashboard
				</h1>
				<AutorunToggle />
				<button
					type="button"
					onClick={() => setShowCreateDialog(true)}
					className="flex items-center gap-1 rounded-lg bg-th-accent px-3 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
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
						onViewTicketDetail={handleViewTicketDetail}
						onEditTicket={setEditingTicket}
						onDeleteTicket={handleDelete}
						onDeleteAllByStatus={handleDeleteAllByStatus}
					/>
				)}
			</main>

			{showCreateDialog && (
				<TicketEditorOverlay
					onSave={handleCreate}
					onCancel={handleCancelCreate}
				/>
			)}

			{editingTicket && (
				<TicketEditorOverlay
					ticket={editingTicket}
					onSave={handleEdit}
					onCancel={handleCloseEdit}
				/>
			)}
		</div>
	);
}
