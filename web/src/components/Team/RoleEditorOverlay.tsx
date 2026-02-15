import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import TextareaAutosize from "react-textarea-autosize";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import type { AgentRole } from "../../types/message";
import ConfirmDialog from "../common/ConfirmDialog";

interface Props {
	role?: AgentRole;
	onSave: (name: string, systemPrompt: string) => void;
	onCancel: () => void;
}

/**
 * Full-screen overlay for editing agent roles.
 * Provides a focused editing experience with ample space for system prompts.
 */
function RoleEditorOverlay({ role, onSave, onCancel }: Props) {
	const isDesktop = useIsDesktop();
	const mobile = !isDesktop;

	const [name, setName] = useState(role?.name ?? "");
	const [systemPrompt, setSystemPrompt] = useState(role?.system_prompt ?? "");
	const [showDiscardDialog, setShowDiscardDialog] = useState(false);

	const nameInputRef = useRef<HTMLInputElement>(null);
	const handleCloseRef = useRef<() => void>(() => {});

	const titleId = useId();
	const isEditing = !!role;
	const title = isEditing ? "Edit Role" : "New Role";
	const submitLabel = isEditing ? "Save" : "Create";

	const isValid = name.trim().length > 0;
	const hasChanges =
		name.trim() !== (role?.name ?? "") ||
		systemPrompt.trim() !== (role?.system_prompt ?? "");

	const handleClose = () => {
		if (hasChanges) {
			setShowDiscardDialog(true);
		} else {
			onCancel();
		}
	};
	handleCloseRef.current = handleClose;

	// Focus name input on mount
	useEffect(() => {
		nameInputRef.current?.focus();
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
		onSave(name.trim(), systemPrompt.trim());
	};

	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

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
						{title}
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
						{/* Name input */}
						<div className="space-y-1.5">
							<label
								htmlFor="role-name"
								className="text-sm font-medium text-th-text-primary"
							>
								Name
							</label>
							<input
								ref={nameInputRef}
								id="role-name"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Role name"
								className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20"
								autoComplete="off"
							/>
						</div>

						{/* System prompt textarea */}
						<div className="space-y-1.5">
							<label
								htmlFor="role-system-prompt"
								className="text-sm font-medium text-th-text-primary"
							>
								System Prompt
							</label>
							<TextareaAutosize
								id="role-system-prompt"
								value={systemPrompt}
								onChange={(e) => setSystemPrompt(e.target.value)}
								placeholder="Enter system prompt..."
								minRows={mobile ? 5 : 8}
								maxRows={mobile ? 12 : 20}
								className="w-full resize-none rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none focus:ring-2 focus:ring-th-accent/20"
							/>
						</div>
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
							disabled={!isValid}
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

export default RoleEditorOverlay;
