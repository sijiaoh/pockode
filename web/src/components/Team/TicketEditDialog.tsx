import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Ticket, TicketStatus } from "../../types/message";

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
	const titleId = useId();
	const titleInputRef = useRef<HTMLInputElement>(null);

	const [title, setTitle] = useState(ticket.title);
	const [description, setDescription] = useState(ticket.description);
	const [status, setStatus] = useState<TicketStatus>(ticket.status);
	const [priority, setPriority] = useState(ticket.priority);

	useEffect(() => {
		titleInputRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};

		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = originalOverflow;
		};
	}, [onClose]);

	const hasChanges =
		title.trim() !== ticket.title ||
		description.trim() !== ticket.description ||
		status !== ticket.status ||
		priority !== ticket.priority;

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
		if (priority !== ticket.priority) {
			updates.priority = priority;
		}

		onSave(ticket.id, updates);
	};

	const isValid = title.trim() && hasChanges;
	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

	return createPortal(
		/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in useEffect */
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onClick={stopEvent}
			onMouseDown={stopEvent}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop */}
			<div className="absolute inset-0" onClick={onClose} />
			<div className="relative mx-4 w-full max-w-md rounded-lg bg-th-bg-secondary p-4 shadow-xl">
				<h2 id={titleId} className="text-lg font-bold text-th-text-primary">
					Edit Ticket
				</h2>

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
								className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-accent focus:outline-none"
							/>
						</div>
					</div>

					<div className="flex justify-end gap-3 pt-2">
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!isValid}
							className="rounded-lg bg-th-accent px-4 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Save
						</button>
					</div>
				</form>
			</div>
		</div>,
		document.body,
	);
}

export default TicketEditDialog;
