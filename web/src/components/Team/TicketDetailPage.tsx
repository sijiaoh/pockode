import { MessageSquare, Play } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useRoles } from "../../hooks/useRoles";
import { useTickets } from "../../hooks/useTickets";
import { selectRoleById, useRoleStore } from "../../lib/roleStore";
import { toast } from "../../lib/toastStore";
import { useWSStore } from "../../lib/wsStore";
import BackToChatButton from "../ui/BackToChatButton";

interface Props {
	ticketId: string;
	onBack: () => void;
	onSelectSession?: (sessionId: string) => void;
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
	open: {
		label: "Open",
		className: "bg-th-bg-tertiary text-th-text-muted",
	},
	in_progress: {
		label: "In Progress",
		className: "bg-blue-500/20 text-blue-400",
	},
	done: {
		label: "Done",
		className: "bg-green-500/20 text-green-400",
	},
};

function formatDateTime(isoString: string): string {
	const date = new Date(isoString);
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export default function TicketDetailPage({
	ticketId,
	onBack,
	onSelectSession,
}: Props) {
	const status = useWSStore((s) => s.status);
	const { tickets, isLoading } = useTickets(status === "connected");
	useRoles();

	const ticket = useMemo(
		() => tickets.find((t) => t.id === ticketId),
		[tickets, ticketId],
	);

	const roleSelector = useMemo(
		() => selectRoleById(ticket?.role_id ?? ""),
		[ticket?.role_id],
	);
	const role = useRoleStore(roleSelector);

	const startTicket = useWSStore((s) => s.actions.startTicket);

	const handleStart = useCallback(async () => {
		if (!ticket) return;
		try {
			const result = await startTicket(ticket.id);
			onSelectSession?.(result.session_id);
		} catch (err) {
			toast.error("Failed to start ticket");
			console.error("Failed to start ticket:", err);
		}
	}, [ticket, startTicket, onSelectSession]);

	const handleViewSession = useCallback(() => {
		if (ticket?.session_id) {
			onSelectSession?.(ticket.session_id);
		}
	}, [ticket?.session_id, onSelectSession]);

	if (isLoading) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
					<BackToChatButton onClick={onBack} />
				</header>
				<main className="flex min-h-0 flex-1 items-center justify-center p-4">
					<div className="h-5 w-5 animate-spin rounded-full border-2 border-th-text-muted border-t-transparent" />
				</main>
			</div>
		);
	}

	if (!ticket) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
					<BackToChatButton onClick={onBack} />
					<h1 className="px-2 text-sm font-bold text-th-text-primary">
						Ticket Not Found
					</h1>
				</header>
				<main className="flex min-h-0 flex-1 items-center justify-center p-4">
					<p className="text-th-text-muted">
						The requested ticket could not be found.
					</p>
				</main>
			</div>
		);
	}

	const statusConfig = STATUS_LABELS[ticket.status] ?? STATUS_LABELS.open;
	const canStart = ticket.status === "open";
	const hasSession = ticket.status === "in_progress" && ticket.session_id;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 truncate px-2 text-sm font-bold text-th-text-primary">
					{ticket.title}
				</h1>
				{canStart && (
					<button
						type="button"
						onClick={handleStart}
						className="flex items-center gap-1 rounded-lg bg-th-accent px-3 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						<Play className="h-4 w-4" />
						Start
					</button>
				)}
				{hasSession && (
					<button
						type="button"
						onClick={handleViewSession}
						className="flex items-center gap-1 rounded-lg bg-th-accent px-3 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						<MessageSquare className="h-4 w-4" />
						View Session
					</button>
				)}
			</header>

			<main className="min-h-0 flex-1 overflow-auto p-4">
				<div className="mx-auto max-w-2xl space-y-6">
					{/* Status and Priority */}
					<div className="flex flex-wrap items-center gap-3">
						<span
							className={`rounded-full px-3 py-1 text-xs font-medium ${statusConfig.className}`}
						>
							{statusConfig.label}
						</span>
						<span className="rounded-full bg-th-bg-tertiary px-3 py-1 text-xs text-th-text-muted">
							Priority #{ticket.priority}
						</span>
					</div>

					{/* Description */}
					{ticket.description && (
						<section>
							<h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
								Description
							</h2>
							<div className="whitespace-pre-wrap rounded-lg border border-th-border bg-th-bg-secondary p-4 text-sm text-th-text-primary">
								{ticket.description}
							</div>
						</section>
					)}

					{/* Role */}
					<section>
						<h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
							Agent Role
						</h2>
						<div className="rounded-lg border border-th-border bg-th-bg-secondary p-4">
							<p className="text-sm font-medium text-th-text-primary">
								{role?.name ?? "Unknown role"}
							</p>
							{role?.system_prompt && (
								<p className="mt-2 line-clamp-3 text-xs text-th-text-muted">
									{role.system_prompt}
								</p>
							)}
						</div>
					</section>

					{/* Timestamps */}
					<section className="grid gap-4 sm:grid-cols-2">
						<div>
							<h2 className="mb-1 text-xs font-medium uppercase tracking-wider text-th-text-muted">
								Created
							</h2>
							<p className="text-sm text-th-text-primary">
								{formatDateTime(ticket.created_at)}
							</p>
						</div>
						<div>
							<h2 className="mb-1 text-xs font-medium uppercase tracking-wider text-th-text-muted">
								Last Updated
							</h2>
							<p className="text-sm text-th-text-primary">
								{formatDateTime(ticket.updated_at)}
							</p>
						</div>
					</section>
				</div>
			</main>
		</div>
	);
}
