import { MessageSquare, Pencil, Play } from "lucide-react";
import { memo, useMemo } from "react";
import { selectRoleById, useRoleStore } from "../../lib/roleStore";
import type { Ticket } from "../../types/message";
import DeleteButton from "../common/DeleteButton";

interface Props {
	ticket: Ticket;
	onStart?: (ticketId: string) => void;
	onView?: (sessionId: string) => void;
	onViewDetail?: (ticketId: string) => void;
	onEdit?: (ticket: Ticket) => void;
	onDelete?: (ticketId: string) => void;
}

const TicketCard = memo(function TicketCard({
	ticket,
	onStart,
	onView,
	onViewDetail,
	onEdit,
	onDelete,
}: Props) {
	const selector = useMemo(
		() => selectRoleById(ticket.role_id),
		[ticket.role_id],
	);
	const role = useRoleStore(selector);

	const canStart = ticket.status === "open";
	const hasSession = ticket.status === "in_progress" && ticket.session_id;

	const showPriorityBadge = ticket.status === "open";

	const contentSection = (
		<>
			<div className="flex items-center gap-2">
				{showPriorityBadge && (
					<span className="shrink-0 rounded bg-th-bg-tertiary px-1.5 py-0.5 text-xs text-th-text-muted">
						#{ticket.priority}
					</span>
				)}
				<h3
					className={`text-sm font-medium text-th-text-primary truncate${onViewDetail ? " hover:text-th-accent transition-colors" : ""}`}
				>
					{ticket.title}
				</h3>
			</div>
			{ticket.description && (
				<p className="mt-1 text-xs text-th-text-muted line-clamp-2">
					{ticket.description}
				</p>
			)}
		</>
	);

	return (
		<div className="rounded-lg border border-th-border bg-th-bg-secondary p-3">
			{onViewDetail ? (
				<button
					type="button"
					className="mb-2 w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent rounded"
					onClick={() => onViewDetail(ticket.id)}
				>
					{contentSection}
				</button>
			) : (
				<div className="mb-2">{contentSection}</div>
			)}

			<div className="flex items-center justify-between">
				<span className="text-xs text-th-text-muted">
					{role?.name ?? "Unknown role"}
				</span>

				<div className="flex items-center gap-0.5">
					{canStart && onStart && (
						<button
							type="button"
							onClick={() => onStart(ticket.id)}
							className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-accent hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
							title="Start ticket"
						>
							<Play className="h-5 w-5" />
						</button>
					)}
					{hasSession && onView && (
						<button
							type="button"
							onClick={() => onView(ticket.session_id as string)}
							className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
							title="View session"
						>
							<MessageSquare className="h-5 w-5" />
						</button>
					)}
					{onEdit && (
						<button
							type="button"
							onClick={() => onEdit(ticket)}
							className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
							title="Edit ticket"
						>
							<Pencil className="h-5 w-5" />
						</button>
					)}
					{onDelete && (
						<DeleteButton
							itemName={ticket.title}
							itemType="ticket"
							onDelete={() => onDelete(ticket.id)}
							className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-error focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						/>
					)}
				</div>
			</div>
		</div>
	);
});

export default TicketCard;
