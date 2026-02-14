import type { Ticket, TicketStatus } from "../../types/message";
import KanbanColumn from "./KanbanColumn";

const STATUSES: TicketStatus[] = ["open", "in_progress", "done"];

interface Props {
	grouped: Record<TicketStatus, Ticket[]>;
	onStartTicket?: (ticketId: string) => void;
	onViewSession?: (sessionId: string) => void;
	onDeleteTicket?: (ticketId: string) => void;
}

function KanbanBoard({
	grouped,
	onStartTicket,
	onViewSession,
	onDeleteTicket,
}: Props) {
	return (
		<div className="flex gap-4 p-4 overflow-x-auto h-full">
			{STATUSES.map((status) => (
				<KanbanColumn
					key={status}
					status={status}
					tickets={grouped[status]}
					onStartTicket={onStartTicket}
					onViewSession={onViewSession}
					onDeleteTicket={onDeleteTicket}
				/>
			))}
		</div>
	);
}

export default KanbanBoard;
