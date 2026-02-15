import { memo } from "react";
import type { Ticket, TicketStatus } from "../../types/message";
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
	onEditTicket?: (ticket: Ticket) => void;
	onDeleteTicket?: (ticketId: string) => void;
}

const KanbanColumn = memo(function KanbanColumn({
	status,
	tickets,
	onStartTicket,
	onViewSession,
	onEditTicket,
	onDeleteTicket,
}: Props) {
	return (
		<div className="flex min-w-[260px] max-w-[320px] flex-1 flex-col">
			<div className="flex items-center justify-between mb-2 px-1">
				<h2 className="text-sm font-medium text-th-text-primary">
					{STATUS_LABELS[status]}
				</h2>
				<span className="text-xs text-th-text-muted bg-th-bg-tertiary px-2 py-0.5 rounded-full">
					{tickets.length}
				</span>
			</div>
			<div className="flex flex-1 flex-col gap-3 overflow-y-auto">
				{tickets.map((ticket) => (
					<TicketCard
						key={ticket.id}
						ticket={ticket}
						onStart={onStartTicket}
						onView={onViewSession}
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
		</div>
	);
});

export default KanbanColumn;
