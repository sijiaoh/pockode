import { useCoverPage, useOutsideClick } from "@pockode/shared";
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
	triggerRef?: React.RefObject<HTMLElement | null>;
	/** Two columns fit: render as a dropdown rather than a bottom drawer. */
	isExpanded: boolean;
	/** Panel content */
	children: ReactNode;
	/** Desktop panel position relative to trigger */
	desktopPosition?: "left" | "right" | "stretch";
	/**
	 * Which side of the trigger the dropdown grows towards. "above" is for
	 * triggers that sit at the bottom of the viewport, where a panel hanging below
	 * them would be off-screen.
	 */
	desktopPlacement?: "below" | "above";
	/** Desktop panel width (ignored when position is "stretch") */
	desktopWidth?: string;
	/** Maximum height on mobile (dvh unit) */
	mobileMaxHeight?: string;
	/** Maximum height on desktop (vh unit) */
	desktopMaxHeight?: string;
}

/**
 * Bottom sheet below the expanded tier, dropdown anchored to the trigger at and
 * above it. Handles: outside click, Escape key, body scroll prevention (drawer).
 */
function ResponsivePanel({
	isOpen,
	onClose,
	title,
	triggerRef,
	isExpanded,
	children,
	desktopPosition = "stretch",
	desktopPlacement = "below",
	desktopWidth = "w-72",
	mobileMaxHeight = "70dvh",
	desktopMaxHeight = "50vh",
}: Props) {
	const panelRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const mobile = !isExpanded;

	// Focus held inside when the panel goes is dropped on `<body>` with it, so it
	// goes back to the trigger — unless something else has taken it since, such
	// as an overlay the panel's own row opened. A ref rather than a reading at
	// close time: by the time the effect runs the panel is gone, and so is the
	// focus that was in it.
	const focusInsideRef = useRef(false);
	useEffect(() => {
		if (isOpen || !focusInsideRef.current) return;
		focusInsideRef.current = false;
		if (document.activeElement === document.body) triggerRef?.current?.focus();
	}, [isOpen, triggerRef]);

	// Claiming the click is the other half of claiming Escape below, and is
	// needed for the same reason: above the expanded tier this is a dropdown
	// anchored to its trigger with no backdrop of its own, so the click that
	// dismisses it lands on whatever is behind — which may be a surface that
	// reads a press there as "put me away" too. `stopPropagation` only where it
	// actually closes: a click it lets through is not its to take.
	useOutsideClick(isOpen, (target, event) => {
		// Ignore clicks on trigger
		if (triggerRef?.current?.contains(target)) {
			return;
		}

		// Ignore clicks inside portaled dialogs (e.g., confirmation modals).
		// `aria-modal` and not `role="dialog"` alone: the chat's answer panel is
		// a dialog over one rectangle that deliberately leaves the rest of the
		// screen usable, and this header sits in that rest — a press in it is an
		// ordinary press elsewhere, not a modal holding this panel open behind
		// something the user cannot leave.
		if (target.closest('[role="dialog"][aria-modal="true"]')) {
			return;
		}

		// The path as it was when the press landed, not the tree as it is now: a
		// row that swaps the panel's content — a drill into a sub-view — has
		// left the document by the time the click reaches `document`, and
		// `contains` would take it for a press outside.
		if (panelRef.current && !event.composedPath().includes(panelRef.current)) {
			event.stopPropagation();
			onClose();
		}
	});

	// In either tier, not only the drawer that locks the body: the dropdown sits
	// between the user and the page just the same. Covering is what keeps the
	// chat's interrupt off the press — it is a sibling `document` listener, and
	// if it was registered first it runs before the mark below is made.
	useCoverPage(isOpen);

	// Close on Escape, and mark the press handled. This panel opens from the
	// session header, which stays live under surfaces
	// that claim Escape for themselves — today the chat's answer panel, which
	// waits until `window` to ask exactly so that this answer is in by then.
	// Without the mark, one press would put away both this panel and one the
	// user was not even looking at.
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			onClose();
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

	const desktopPlacementClass =
		desktopPlacement === "above" ? "bottom-full mb-1" : "top-full mt-1";

	const mobileStyle = { maxHeight: mobileMaxHeight };
	const desktopStyle = { maxHeight: desktopMaxHeight };

	const content = (
		<div
			ref={panelRef}
			style={mobile ? mobileStyle : desktopStyle}
			className={
				mobile
					? "fixed inset-x-0 bottom-0 z-[60] flex flex-col overflow-hidden rounded-t-2xl border-t border-th-border bg-th-bg-secondary shadow-xl"
					: `absolute ${desktopPositionClass} ${desktopPlacementClass} z-50 flex flex-col overflow-hidden rounded-xl border border-th-border bg-th-bg-secondary shadow-lg ${desktopPosition !== "stretch" ? desktopWidth : ""}`
			}
			role="dialog"
			aria-modal={mobile}
			aria-labelledby={mobile ? titleId : undefined}
			aria-label={mobile ? undefined : title}
			onFocus={() => {
				focusInsideRef.current = true;
			}}
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget)) {
					focusInsideRef.current = false;
				}
			}}
		>
			{/* Mobile header */}
			{mobile && (
				<div className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
					{/* Clamped: a title can be a whole sentence someone typed, and the
					    header must not push the content off a phone's sheet. */}
					<h2
						id={titleId}
						className="line-clamp-3 min-w-0 break-words text-base font-bold text-th-text-primary"
					>
						{title}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="touch-target -my-1.5 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary active:scale-95"
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
					className="fixed inset-0 z-[55] bg-th-bg-overlay"
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
