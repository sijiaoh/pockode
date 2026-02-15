import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import TextareaAutosize from "react-textarea-autosize";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import { useRoleStore } from "../../lib/roleStore";
import type { Ticket, TicketStatus } from "../../types/message";
import ConfirmDialog from "../common/ConfirmDialog";

interface CreateModeProps {
	ticket?: undefined;
	onSave: (data: {
		title: string;
		description: string;
		roleId: string;
	}) => void;
	onCancel: () => void;
}

interface EditModeProps {
	ticket: Ticket;
	onSave: (
		ticketId: string,
		updates: {
			title?: string;
			description?: string;
			status?: TicketStatus;
			priority?: number;
		},
	) => void;
	onCancel: () => void;
}

type Props = CreateModeProps | EditModeProps;

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "in_progress", label: "In Progress" },
	{ value: "done", label: "Done" },
];

/**
 * Full-screen overlay for creating and editing tickets.
 * Provides a focused editing experience with ample space for descriptions.
 */
function TicketEditorOverlay(props: Props) {
	const { onCancel } = props;
	const isEditing = "ticket" in props && props.ticket !== undefined;

	const isDesktop = useIsDesktop();
	const mobile = !isDesktop;
	const roles = useRoleStore((s) => s.roles);

	const [title, setTitle] = useState(isEditing ? props.ticket.title : "");
	const [description, setDescription] = useState(
		isEditing ? props.ticket.description : "",
	);
	const [roleId, setRoleId] = useState(() =>
		isEditing ? props.ticket.role_id : (roles[0]?.id ?? ""),
	);
	const [status, setStatus] = useState<TicketStatus>(
		isEditing ? props.ticket.status : "open",
	);
	const [priority, setPriority] = useState(
		isEditing ? props.ticket.priority : 1,
	);
	const [showDiscardDialog, setShowDiscardDialog] = useState(false);

	const titleInputRef = useRef<HTMLInputElement>(null);
	const handleCloseRef = useRef<() => void>(() => {});

	const titleId = useId();
	const overlayTitle = isEditing ? "Edit Ticket" : "New Ticket";
	const submitLabel = isEditing ? "Save" : "Create";

	const isValid = title.trim().length > 0 && (isEditing || roleId);

	const hasChanges = isEditing
		? (() => {
				const isPriorityEditable = status === "open";
				const hasPriorityChanged =
					isPriorityEditable && priority !== props.ticket.priority;
				return (
					title.trim() !== props.ticket.title ||
					description.trim() !== props.ticket.description ||
					status !== props.ticket.status ||
					hasPriorityChanged
				);
			})()
		: title.trim().length > 0 || description.trim().length > 0;

	const handleClose = () => {
		if (hasChanges) {
			setShowDiscardDialog(true);
		} else {
			onCancel();
		}
	};
	handleCloseRef.current = handleClose;

	// Focus title input on mount
	useEffect(() => {
		titleInputRef.current?.focus();
	}, []);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				handleCloseRef.current();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, []);

	// Prevent body scroll
	useEffect(() => {
		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			document.body.style.overflow = originalOverflow;
		};
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!isValid) return;

		if (isEditing) {
			const updates: {
				title?: string;
				description?: string;
				status?: TicketStatus;
				priority?: number;
			} = {};

			if (title.trim() !== props.ticket.title) {
				updates.title = title.trim();
			}
			if (description.trim() !== props.ticket.description) {
				updates.description = description.trim();
			}
			if (status !== props.ticket.status) {
				updates.status = status;
			}
			const isPriorityEditable = status === "open";
			if (isPriorityEditable && priority !== props.ticket.priority) {
				updates.priority = priority;
			}

			props.onSave(props.ticket.id, updates);
		} else {
			props.onSave({
				title: title.trim(),
				description: description.trim(),
				roleId,
			});
		}
	};

	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

	const isPriorityEditable = isEditing && status === "open";

	return createPortal(
		/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in useEffect */
		<div
			className="fixed inset-0 z-[70] flex items-end justify-center bg-th-bg-overlay md:items-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onClick={stopEvent}
			onMouseDown={stopEvent}
		>
			{/* Backdrop */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Escape handled in useEffect */}
			<div className="absolute inset-0" onClick={handleClose} />

			{/* Content */}
			<div
				className={`relative flex w-full flex-col bg-th-bg-secondary shadow-xl ${
					mobile
						? "max-h-[90dvh] rounded-t-2xl"
						: "mx-4 max-h-[80vh] max-w-lg rounded-xl"
				}`}
			>
				{/* Drag handle - mobile only */}
				{mobile && (
					<div className="flex shrink-0 justify-center pt-3">
						<div className="h-1 w-10 rounded-full bg-th-text-muted/30" />
					</div>
				)}

				{/* Header */}
				<div className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
					<h2 id={titleId} className="text-base font-bold text-th-text-primary">
						{overlayTitle}
					</h2>
					<button
						type="button"
						onClick={handleClose}
						className="flex h-9 w-9 items-center justify-center rounded-full text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary"
						aria-label="Close"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Form */}
				<form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
						{/* Title input */}
						<div className="space-y-1.5">
							<label
								htmlFor="ticket-title"
								className="text-sm font-medium text-th-text-primary"
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
								className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20"
								autoComplete="off"
							/>
						</div>

						{/* Description textarea */}
						<div className="space-y-1.5">
							<label
								htmlFor="ticket-description"
								className="text-sm font-medium text-th-text-primary"
							>
								Description
							</label>
							<TextareaAutosize
								id="ticket-description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Provide more details..."
								minRows={mobile ? 5 : 8}
								maxRows={mobile ? 12 : 20}
								className="w-full resize-none rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20"
							/>
						</div>

						{/* Role select - create mode only */}
						{!isEditing && (
							<div className="space-y-1.5">
								<label
									htmlFor="ticket-role"
									className="text-sm font-medium text-th-text-primary"
								>
									Agent Role
								</label>
								<select
									id="ticket-role"
									value={roleId}
									onChange={(e) => setRoleId(e.target.value)}
									className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20"
								>
									{roles.map((role) => (
										<option key={role.id} value={role.id}>
											{role.name}
										</option>
									))}
								</select>
							</div>
						)}

						{/* Status and Priority - edit mode only */}
						{isEditing && (
							<div className="flex gap-4">
								<div className="flex-1 space-y-1.5">
									<label
										htmlFor="ticket-status"
										className="text-sm font-medium text-th-text-primary"
									>
										Status
									</label>
									<select
										id="ticket-status"
										value={status}
										onChange={(e) => setStatus(e.target.value as TicketStatus)}
										className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20"
									>
										{STATUS_OPTIONS.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</div>

								<div className="w-24 space-y-1.5">
									<label
										htmlFor="ticket-priority"
										className="text-sm font-medium text-th-text-primary"
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
										className={`w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20 ${
											!isPriorityEditable ? "cursor-not-allowed opacity-50" : ""
										}`}
									/>
								</div>
							</div>
						)}
					</div>

					{/* Footer */}
					<div className="flex shrink-0 gap-3 border-t border-th-border p-4">
						<button
							type="button"
							onClick={handleClose}
							className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!isValid || (isEditing && !hasChanges)}
							className="flex-1 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50"
						>
							{submitLabel}
						</button>
					</div>
				</form>
			</div>

			{/* Discard confirmation dialog */}
			{showDiscardDialog && (
				<ConfirmDialog
					title="Discard Changes?"
					message="You have unsaved changes. Are you sure you want to discard them?"
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					variant="danger"
					onConfirm={onCancel}
					onCancel={() => setShowDiscardDialog(false)}
				/>
			)}
		</div>,
		document.body,
	);
}

export default TicketEditorOverlay;
