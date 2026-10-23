import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLockBodyScroll } from "../hooks/useLockBodyScroll.ts";
import { useCloseWhenCovered } from "./CoveredSurface.tsx";
import { Spinner } from "./Spinner.tsx";

export interface ConfirmDialogProps {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "danger" | "default";
	/** z-index for the dialog overlay. Default: 70 */
	zIndex?: number;
	/**
	 * Return the action's promise to keep the dialog up while it runs: until it
	 * settles, the dialog shows it is working and refuses both a second confirm
	 * and a cancel. A rejection is shown in the dialog, which can then be
	 * confirmed again or cancelled.
	 */
	onConfirm: () => unknown;
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
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The state lags a render behind: two presses inside one frame would both
	// read `running` as false.
	const runningRef = useRef(false);

	const confirm = () => {
		if (runningRef.current) return;
		const result = onConfirm();
		if (!(result instanceof Promise)) return;
		runningRef.current = true;
		setRunning(true);
		setError(null);
		result
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				runningRef.current = false;
				setRunning(false);
			});
	};

	// Cancelling cannot take back a request already sent, so it is refused
	// rather than offered as if it could; the dialog would only vanish and the
	// action land anyway.
	const cancel = () => {
		if (!runningRef.current) onCancel();
	};

	useLockBodyScroll();
	// Portalled to the body, so the surface that raised it cannot take it away
	// by covering itself; cancelling is what a question about a surface the
	// user has left comes to (CoveredSurface). Even while an action runs: it
	// carries on, and the dialog has nothing left to show over a surface gone.
	useCloseWhenCovered(onCancel);

	// On open only: callers pass `onCancel` inline, so tying this to it would
	// pull focus back to Cancel whenever the caller re-renders — mid-action
	// included, where the confirm button is meant to keep it.
	useEffect(() => {
		cancelButtonRef.current?.focus();
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Claimed while running too: the dialog is still what the key is for.
				e.stopPropagation();
				if (!runningRef.current) onCancel();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
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
			<div className="absolute inset-0 z-0" onClick={cancel} />
			<div className="relative z-10 mx-4 w-full max-w-sm rounded-lg bg-th-bg-secondary p-4 shadow-xl">
				<h2 id={titleId} className="text-lg font-bold text-th-text-primary">
					{title}
				</h2>
				<p className="mt-2 text-sm text-th-text-muted">{message}</p>
				{error && (
					<p className="mt-2 text-sm text-th-error" role="alert">
						{error}
					</p>
				)}

				<div className="mt-4 flex justify-end gap-3">
					<button
						ref={cancelButtonRef}
						type="button"
						onClick={cancel}
						aria-disabled={running || undefined}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						onClick={confirm}
						// aria-disabled rather than disabled: a disabled button drops
						// focus to the body, and a failed action would hand the dialog
						// back with nothing focused in it.
						aria-disabled={running || undefined}
						aria-busy={running || undefined}
						className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent aria-disabled:cursor-wait ${confirmButtonStyle}`}
					>
						{running && (
							<Spinner variant="current" size="h-3.5 w-3.5" srText={null} />
						)}
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
