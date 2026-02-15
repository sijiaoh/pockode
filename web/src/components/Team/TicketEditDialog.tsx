import { useEffect, useRef, useState } from "react";
import type { Ticket, TicketStatus } from "../../types/message";
import Dialog from "../common/Dialog";

interface Props {
	ticket: Ticket;
	onClose: () => void;
	onSave: (
		ticketId: string,
		updates: {
			title?: string;
			description?: string;
			status?: TicketStatus;
			priority?: number;
		},
	) => void;
}

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "in_progress", label: "In Progress" },
	{ value: "done", label: "Done" },
];

function TicketEditDialog({ ticket, onClose, onSave }: Props) {
	const titleInputRef = useRef<HTMLInputElement>(null);

	const [title, setTitle] = useState(ticket.title);
	const [description, setDescription] = useState(ticket.description);
	const [status, setStatus] = useState<TicketStatus>(ticket.status);
	const [priority, setPriority] = useState(ticket.priority);

	useEffect(() => {
		titleInputRef.current?.focus();
	}, []);

	const isPriorityEditable = status === "open";
	const hasPriorityChanged = isPriorityEditable && priority !== ticket.priority;
	const hasChanges =
		title.trim() !== ticket.title ||
		description.trim() !== ticket.description ||
		status !== ticket.status ||
		hasPriorityChanged;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !hasChanges) return;

		const updates: {
			title?: string;
			description?: string;
			status?: TicketStatus;
			priority?: number;
		} = {};

		if (title.trim() !== ticket.title) {
			updates.title = title.trim();
		}
		if (description.trim() !== ticket.description) {
			updates.description = description.trim();
		}
		if (status !== ticket.status) {
			updates.status = status;
		}
		if (hasPriorityChanged) {
			updates.priority = priority;
		}

		onSave(ticket.id, updates);
	};

	const isValid = title.trim() && hasChanges;

	return (
		<Dialog title="Edit Ticket" onClose={onClose}>
			<form onSubmit={handleSubmit} className="mt-4 space-y-4">
				<div>
					<label
						htmlFor="ticket-title"
						className="block text-sm font-medium text-th-text-primary mb-1"
					>
						Title
					</label>
					<input
						ref={titleInputRef}
						id="ticket-title"
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="What needs to be done?"
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					/>
				</div>

				<div>
					<label
						htmlFor="ticket-description"
						className="block text-sm font-medium text-th-text-primary mb-1"
					>
						Description
					</label>
					<textarea
						id="ticket-description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Provide more details..."
						rows={4}
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none resize-none"
					/>
				</div>

				<div className="flex gap-4">
					<div className="flex-1">
						<label
							htmlFor="ticket-status"
							className="block text-sm font-medium text-th-text-primary mb-1"
						>
							Status
						</label>
						<select
							id="ticket-status"
							value={status}
							onChange={(e) => setStatus(e.target.value as TicketStatus)}
							className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-accent focus:outline-none"
						>
							{STATUS_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>

					<div className="w-24">
						<label
							htmlFor="ticket-priority"
							className="block text-sm font-medium text-th-text-primary mb-1"
						>
							Priority
						</label>
						<input
							id="ticket-priority"
							type="number"
							min={1}
							value={priority}
							onChange={(e) => setPriority(Number(e.target.value))}
							disabled={!isPriorityEditable}
							title={
								!isPriorityEditable
									? "Priority only applies to open tickets"
									: undefined
							}
							className={`w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-accent focus:outline-none ${
								!isPriorityEditable ? "cursor-not-allowed opacity-50" : ""
							}`}
						/>
					</div>
				</div>

				<div className="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!isValid}
						className="rounded-lg bg-th-accent px-4 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50"
					>
						Save
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export default TicketEditDialog;
