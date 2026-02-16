import { Trash2 } from "lucide-react";
import { memo, useState } from "react";
import type { Ticket, TicketStatus } from "../../types/message";
import ConfirmDialog from "../common/ConfirmDialog";
import TicketCard from "./TicketCard";

const STATUS_LABELS: Record<TicketStatus, string> = {
	open: "Open",
	in_progress: "In Progress",
	done: "Done",
};

interface Props {
	status: TicketStatus;
	tickets: Ticket[];
	onStartTicket?: (ticketId: string) => void;
	onViewSession?: (sessionId: string) => void;
	onViewTicketDetail?: (ticketId: string) => void;
	onEditTicket?: (ticket: Ticket) => void;
	onDeleteTicket?: (ticketId: string) => void;
	onDeleteAllByStatus?: (status: TicketStatus) => void;
}

const KanbanColumn = memo(function KanbanColumn({
	status,
	tickets,
	onStartTicket,
	onViewSession,
	onViewTicketDetail,
	onEditTicket,
	onDeleteTicket,
	onDeleteAllByStatus,
}: Props) {
	const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);

	const handleDeleteAllClick = () => {
		setShowDeleteAllConfirm(true);
	};

	const handleDeleteAllConfirm = () => {
		setShowDeleteAllConfirm(false);
		onDeleteAllByStatus?.(status);
	};

	return (
		<div className="flex min-w-[260px] max-w-[320px] flex-1 flex-col">
			<div className="flex items-center justify-between mb-2 px-1">
				<h2 className="text-sm font-medium text-th-text-primary">
					{STATUS_LABELS[status]}
				</h2>
				<div className="flex items-center gap-1">
					{tickets.length > 0 && onDeleteAllByStatus && (
						<button
							type="button"
							onClick={handleDeleteAllClick}
							className="flex items-center justify-center rounded p-1 text-th-text-muted hover:text-th-error hover:bg-th-bg-tertiary transition-colors"
							title={`Delete all ${STATUS_LABELS[status]} tickets`}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					)}
					<span className="text-xs text-th-text-muted bg-th-bg-tertiary px-2 py-0.5 rounded-full">
						{tickets.length}
					</span>
				</div>
			</div>
			<div className="flex flex-1 flex-col gap-3 overflow-y-auto">
				{tickets.map((ticket) => (
					<TicketCard
						key={ticket.id}
						ticket={ticket}
						onStart={onStartTicket}
						onView={onViewSession}
						onViewDetail={onViewTicketDetail}
						onEdit={onEditTicket}
						onDelete={onDeleteTicket}
					/>
				))}
				{tickets.length === 0 && (
					<div className="text-center text-xs text-th-text-muted py-8">
						No tickets
					</div>
				)}
			</div>
			{showDeleteAllConfirm && (
				<ConfirmDialog
					title={`Delete all ${STATUS_LABELS[status]} tickets?`}
					message={`This will delete ${tickets.length} ticket${tickets.length !== 1 ? "s" : ""}. This action cannot be undone.`}
					confirmLabel="Delete All"
					variant="danger"
					onConfirm={handleDeleteAllConfirm}
					onCancel={() => setShowDeleteAllConfirm(false)}
				/>
			)}
		</div>
	);
});

export default KanbanColumn;
