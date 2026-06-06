import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "danger" | "default";
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	title,
	message,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	variant = "default",
	onConfirm,
	onCancel,
}: Props) {
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		cancelRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onCancel();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onCancel]);

	const confirmButtonClass =
		variant === "danger"
			? "bg-th-error text-white hover:opacity-90"
			: "bg-th-accent text-th-accent-text hover:bg-th-accent-hover";

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby="dialog-title"
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-th-bg-overlay"
				onClick={onCancel}
				aria-hidden="true"
			/>

			{/* Dialog */}
			<div
				className="relative mx-4 w-full max-w-sm rounded-lg border border-th-border bg-th-bg-secondary p-6 shadow-xl"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<h2
					id="dialog-title"
					className="text-lg font-semibold text-th-text-primary"
				>
					{title}
				</h2>
				<p className="mt-2 text-sm text-th-text-secondary">{message}</p>

				<div className="mt-6 flex justify-end gap-3">
					<button
						ref={cancelRef}
						type="button"
						onClick={onCancel}
						className="min-h-[44px] rounded-lg border border-th-border px-4 py-2 text-sm font-medium text-th-text-primary hover:bg-th-overlay-hover"
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className={`min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium ${confirmButtonClass}`}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
