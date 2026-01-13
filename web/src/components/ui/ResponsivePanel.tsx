import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
	/** Whether the panel is open */
	isOpen: boolean;
	/** Called when the panel should close */
	onClose: () => void;
	/** Title shown in mobile header */
	title: string;
	/** Reference to the trigger button (for click-outside detection) */
	triggerRef?: React.RefObject<HTMLElement>;
	/** Whether in desktop mode */
	isDesktop: boolean;
	/** Panel content */
	children: ReactNode;
	/** Desktop panel position relative to trigger */
	desktopPosition?: "left" | "right" | "stretch";
	/** Desktop panel width (ignored when position is "stretch") */
	desktopWidth?: string;
	/** Maximum height on mobile (dvh unit) */
	mobileMaxHeight?: string;
	/** Maximum height on desktop (vh unit) */
	desktopMaxHeight?: string;
}

/**
 * Responsive panel that renders as a bottom sheet on mobile and a dropdown on desktop.
 * Handles: outside click, Escape key, body scroll prevention (mobile).
 */
function ResponsivePanel({
	isOpen,
	onClose,
	title,
	triggerRef,
	isDesktop,
	children,
	desktopPosition = "stretch",
	desktopWidth = "w-72",
	mobileMaxHeight = "70dvh",
	desktopMaxHeight = "50vh",
}: Props) {
	const panelRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const mobile = !isDesktop;

	// Close on outside click
	useEffect(() => {
		if (!isOpen) return;

		const handleClickOutside = (e: MouseEvent) => {
			const target = e.target as Element;

			// Ignore clicks on trigger
			if (triggerRef?.current?.contains(target)) {
				return;
			}

			// Ignore clicks inside portaled dialogs (e.g., confirmation modals)
			if (target.closest('[role="dialog"]')) {
				return;
			}

			if (panelRef.current && !panelRef.current.contains(target)) {
				onClose();
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [isOpen, onClose, triggerRef]);

	// Close on Escape
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [isOpen, onClose]);

	// Prevent body scroll on mobile
	useEffect(() => {
		if (!isOpen || !mobile) return;

		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			document.body.style.overflow = originalOverflow;
		};
	}, [isOpen, mobile]);

	if (!isOpen) return null;

	const desktopPositionClass =
		desktopPosition === "left"
			? "left-0"
			: desktopPosition === "right"
				? "right-0"
				: "left-0 right-0";

	const mobileStyle = { maxHeight: mobileMaxHeight };
	const desktopStyle = { maxHeight: desktopMaxHeight };

	const content = (
		<div
			ref={panelRef}
			style={mobile ? mobileStyle : desktopStyle}
			className={
				mobile
					? "fixed inset-x-0 bottom-0 z-[60] flex flex-col overflow-hidden rounded-t-2xl border-t border-th-border bg-th-bg-secondary shadow-xl"
					: `absolute ${desktopPositionClass} top-full z-50 mt-1 flex flex-col overflow-hidden rounded-xl border border-th-border bg-th-bg-secondary shadow-lg ${desktopPosition !== "stretch" ? desktopWidth : ""}`
			}
			role="dialog"
			aria-modal={mobile}
			aria-labelledby={mobile ? titleId : undefined}
			aria-label={mobile ? undefined : title}
		>
			{/* Mobile header */}
			{mobile && (
				<div className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
					<h2
						id={titleId}
						className="text-base font-semibold text-th-text-primary"
					>
						{title}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="-mr-2 flex h-8 w-8 items-center justify-center rounded-full text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary active:scale-95"
						aria-label="Close"
					>
						<X className="h-5 w-5" />
					</button>
				</div>
			)}

			{children}
		</div>
	);

	if (mobile) {
		return createPortal(
			<>
				{/* Backdrop - above sidebar (z-50) */}
				<div
					className="fixed inset-0 z-[55] bg-black/50"
					onClick={onClose}
					aria-hidden="true"
				/>
				{content}
			</>,
			document.body,
		);
	}

	return content;
}

export default ResponsivePanel;
