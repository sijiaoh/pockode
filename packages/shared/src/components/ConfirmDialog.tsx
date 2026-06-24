import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export interface ConfirmDialogProps {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "danger" | "default";
	/** z-index for the dialog overlay. Default: 70 */
	zIndex?: number;
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * Modal confirmation dialog with backdrop, keyboard handling, and accessibility support.
 * Uses createPortal to render at document.body level.
 */
export function ConfirmDialog({
	title,
	message,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	variant = "default",
	zIndex = 70,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const titleId = useId();

	useEffect(() => {
		cancelButtonRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onCancel();
			}
		};

		// Lock body scroll while dialog is open
		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = originalOverflow;
		};
	}, [onCancel]);

	const confirmButtonStyle =
		variant === "danger"
			? "bg-th-error text-th-text-inverse hover:opacity-90"
			: "bg-th-accent text-th-accent-text hover:bg-th-accent-hover";

	// Isolate all events from parent components
	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

	return createPortal(
		/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in useEffect */
		<div
			className="fixed inset-0 flex items-center justify-center bg-th-bg-overlay"
			style={{ zIndex }}
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onClick={stopEvent}
			onMouseDown={stopEvent}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop */}
			<div className="absolute inset-0" onClick={onCancel} />
			<div className="relative mx-4 w-full max-w-sm rounded-lg bg-th-bg-secondary p-4 shadow-xl">
				<h2 id={titleId} className="text-lg font-bold text-th-text-primary">
					{title}
				</h2>
				<p className="mt-2 text-sm text-th-text-muted">{message}</p>

				<div className="mt-4 flex justify-end gap-3">
					<button
						ref={cancelButtonRef}
						type="button"
						onClick={onCancel}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className={`rounded-lg px-4 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${confirmButtonStyle}`}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
