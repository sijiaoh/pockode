import { useEffect, useRef } from "react";
import Dialog from "./Dialog";

interface Props {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "danger" | "default";
	onConfirm: () => void;
	onCancel: () => void;
}

function ConfirmDialog({
	title,
	message,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	variant = "default",
	onConfirm,
	onCancel,
}: Props) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		cancelButtonRef.current?.focus();
	}, []);

	const confirmButtonStyle =
		variant === "danger"
			? "bg-th-error text-th-text-inverse hover:opacity-90"
			: "bg-th-accent text-th-accent-text hover:bg-th-accent-hover";

	return (
		<Dialog title={title} onClose={onCancel} maxWidth="max-w-sm">
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
		</Dialog>
	);
}

export default ConfirmDialog;
