import { Eye, Play } from "lucide-react";
import { memo } from "react";
import { useRoleStore } from "../../lib/roleStore";
import type { Ticket } from "../../types/message";
import DeleteButton from "../common/DeleteButton";

interface Props {
	ticket: Ticket;
	onStart?: (ticketId: string) => void;
	onView?: (sessionId: string) => void;
	onDelete?: (ticketId: string) => void;
}

const TicketCard = memo(function TicketCard({
	ticket,
	onStart,
	onView,
	onDelete,
}: Props) {
	const role = useRoleStore((s) =>
		s.roles.find((r) => r.id === ticket.role_id),
	);

	const canStart = ticket.status === "open";
	const hasSession = ticket.status === "in_progress" && ticket.session_id;

	return (
		<div className="rounded-lg border border-th-border bg-th-bg-secondary p-3">
			<div className="mb-2">
				<h3 className="text-sm font-medium text-th-text-primary truncate">
					{ticket.title}
				</h3>
				{ticket.description && (
					<p className="mt-1 text-xs text-th-text-muted line-clamp-2">
						{ticket.description}
					</p>
				)}
			</div>

			<div className="flex items-center justify-between">
				<span className="text-xs text-th-text-muted">
					{role?.name ?? "Unknown role"}
				</span>

				<div className="flex items-center gap-1">
					{canStart && onStart && (
						<button
							type="button"
							onClick={() => onStart(ticket.id)}
							className="p-1.5 rounded hover:bg-th-bg-tertiary text-th-accent"
							title="Start ticket"
						>
							<Play className="h-4 w-4" />
						</button>
					)}
					{hasSession && onView && (
						<button
							type="button"
							onClick={() => onView(ticket.session_id as string)}
							className="p-1.5 rounded hover:bg-th-bg-tertiary text-th-text-muted"
							title="View session"
						>
							<Eye className="h-4 w-4" />
						</button>
					)}
					{onDelete && (
						<DeleteButton
							itemName={ticket.title}
							itemType="ticket"
							onDelete={() => onDelete(ticket.id)}
							className="p-1.5 rounded hover:bg-th-bg-tertiary text-th-text-muted hover:text-red-500"
						/>
					)}
				</div>
			</div>
		</div>
	);
});

export default TicketCard;
