import type { Ticket, TicketStatus } from "../../types/message";
import KanbanColumn from "./KanbanColumn";

const STATUSES: TicketStatus[] = ["open", "in_progress", "done"];

interface Props {
	grouped: Record<TicketStatus, Ticket[]>;
	onStartTicket?: (ticketId: string) => void;
	onViewSession?: (sessionId: string) => void;
	onEditTicket?: (ticket: Ticket) => void;
	onDeleteTicket?: (ticketId: string) => void;
}

function KanbanBoard({
	grouped,
	onStartTicket,
	onViewSession,
	onEditTicket,
	onDeleteTicket,
}: Props) {
	return (
		<div className="flex h-full gap-4 overflow-x-auto">
			{STATUSES.map((status) => (
				<KanbanColumn
					key={status}
					status={status}
					tickets={grouped[status]}
					onStartTicket={onStartTicket}
					onViewSession={onViewSession}
					onEditTicket={onEditTicket}
					onDeleteTicket={onDeleteTicket}
				/>
			))}
		</div>
	);
}

export default KanbanBoard;
