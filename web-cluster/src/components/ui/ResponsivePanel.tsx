import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	isDesktop: boolean;
	children: ReactNode;
}

export function ResponsivePanel({
	isOpen,
	onClose,
	title,
	isDesktop,
	children,
}: Props) {
	const panelRef = useRef<HTMLDivElement>(null);
	const titleId = useId();

	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		const handleClickOutside = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
				onClose();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener("mousedown", handleClickOutside);

		// Prevent body scroll on mobile
		if (!isDesktop) {
			document.body.style.overflow = "hidden";
		}

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("mousedown", handleClickOutside);
			if (!isDesktop) {
				document.body.style.overflow = "";
			}
		};
	}, [isOpen, onClose, isDesktop]);

	if (!isOpen) return null;

	// Mobile: bottom sheet
	if (!isDesktop) {
		return createPortal(
			<div className="fixed inset-0 z-50">
				{/* Backdrop */}
				<div className="absolute inset-0 bg-th-bg-overlay" />

				{/* Panel */}
				<div
					ref={panelRef}
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-th-border bg-th-bg-secondary pb-[env(safe-area-inset-bottom)]"
				>
					{/* Handle */}
					<div className="sticky top-0 z-10 flex items-center justify-center bg-th-bg-secondary py-3">
						<div className="h-1 w-10 rounded-full bg-th-text-muted" />
					</div>

					{/* Title */}
					<div className="border-b border-th-border px-4 pb-3">
						<h3
							id={titleId}
							className="text-center text-base font-semibold text-th-text-primary"
						>
							{title}
						</h3>
					</div>

					{/* Content */}
					<div className="p-4">{children}</div>
				</div>
			</div>,
			document.body,
		);
	}

	// Desktop: dropdown panel
	return createPortal(
		<div className="fixed inset-0 z-50">
			{/* Backdrop (transparent on desktop) */}
			<div className="absolute inset-0" />

			{/* Panel positioned from top-right */}
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="absolute right-4 top-4 w-80 max-h-[80vh] overflow-y-auto rounded-lg border border-th-border bg-th-bg-secondary shadow-xl"
			>
				{/* Header */}
				<div className="flex items-center justify-between border-b border-th-border p-4">
					<h3
						id={titleId}
						className="text-base font-semibold text-th-text-primary"
					>
						{title}
					</h3>
					<button
						type="button"
						onClick={onClose}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-th-text-secondary hover:bg-th-overlay-hover hover:text-th-text-primary"
						aria-label="Close"
					>
						<svg
							className="h-5 w-5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				{/* Content */}
				<div className="p-4">{children}</div>
			</div>
		</div>,
		document.body,
	);
}
