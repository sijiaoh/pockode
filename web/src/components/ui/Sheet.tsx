import { useIsDesktop } from "@pockode/shared";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";
import { createPortal } from "react-dom";

interface Props {
	title: string;
	onClose: () => void;
	/**
	 * Set false while an operation is in flight: the backdrop, Escape and the
	 * close button stop dismissing, so a slow relay link cannot leave the user
	 * unsure whether the operation was cancelled.
	 */
	dismissible?: boolean;
	/**
	 * Wraps the body and footer in a form, so Enter submits and a footer button
	 * can be type="submit".
	 */
	onSubmit?: (e: React.FormEvent) => void;
	footer?: ReactNode;
	children: ReactNode;
}

let openSheets = 0;
let overflowBeforeFirstSheet = "";

/**
 * Locks body scroll while any sheet is open.
 *
 * Counted rather than saved-and-restored per sheet because sheets replace one
 * another: the branch sheet swaps itself for the new-branch sheet in a single
 * commit. If the arriving sheet's effect ever ran before the leaving sheet's
 * cleanup, a per-sheet restore would record "hidden" as the value to go back
 * to and leave the page permanently unscrollable.
 */
function useLockBodyScroll(): void {
	useEffect(() => {
		if (openSheets === 0) {
			overflowBeforeFirstSheet = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		openSheets += 1;

		return () => {
			openSheets -= 1;
			if (openSheets === 0) {
				document.body.style.overflow = overflowBeforeFirstSheet;
			}
		};
	}, []);
}

/**
 * Bottom drawer on mobile, centered modal on desktop.
 *
 * The body scrolls between a fixed header and footer; it has no padding of its
 * own so a sheet can put full-bleed rows in it.
 */
function Sheet({
	title,
	onClose,
	dismissible = true,
	onSubmit,
	footer,
	children,
}: Props) {
	const isDesktop = useIsDesktop();
	const titleId = useId();
	const mobile = !isDesktop;

	useEffect(() => {
		if (!dismissible) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [onClose, dismissible]);

	useLockBodyScroll();

	const body = (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
			{footer && (
				<div className="flex shrink-0 gap-3 border-t border-th-border p-4">
					{footer}
				</div>
			)}
		</>
	);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-th-bg-overlay md:items-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			{/* Backdrop */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Overlay backdrop - Escape key handled in useEffect */}
			<div
				className="absolute inset-0"
				onClick={dismissible ? onClose : undefined}
			/>

			{/* Content */}
			<div
				className={`relative flex w-full flex-col bg-th-bg-secondary shadow-xl ${
					mobile ? "max-h-[90dvh] rounded-t-2xl" : "mx-4 max-w-md rounded-xl"
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
						onClick={onClose}
						disabled={!dismissible}
						className="-mr-1 rounded p-1 text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary disabled:cursor-not-allowed disabled:opacity-50"
						aria-label="Close"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{onSubmit ? (
					<form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
						{body}
					</form>
				) : (
					body
				)}
			</div>
		</div>,
		document.body,
	);
}

export default Sheet;
