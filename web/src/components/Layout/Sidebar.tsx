import { useCoverPage } from "@pockode/shared";
import { useEffect, useId, useRef } from "react";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import ResizeHandle from "../ui/ResizeHandle";

const MIN_WIDTH = 280;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 320;

interface Props {
	/** On screen: the drawer open, or the column not collapsed. */
	isOpen: boolean;
	onClose: () => void;
	children: React.ReactNode;
	isExpanded: boolean;
}

function Sidebar({ isOpen, onClose, children, isExpanded }: Props) {
	// The handle is only on screen in the expanded tier and while the column is
	// not collapsed, so a viewport shrinking out of the tier or a collapse ends
	// the drag.
	const resize = useResizableWidth({
		storageKey: "pockode:sidebar-width",
		min: MIN_WIDTH,
		max: MAX_WIDTH,
		defaultWidth: DEFAULT_WIDTH,
		active: isExpanded && isOpen,
	});

	// Escape closes the drawer; the column is not an overlay and ignores it —
	// only its own button collapses it.
	// The press is marked handled, because the drawer opens from the session
	// header — which stays lit under the chat's answer panel — and that panel
	// waits until `window` to ask so this answer is in by then
	// (docs/answering-ui.md §4, "Who owns Escape"). Without the mark, one press
	// would close the drawer and a panel behind it the user cannot even see.
	useEffect(() => {
		if (isExpanded) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || !isOpen) return;
			e.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose, isExpanded]);

	// Only the drawer covers the page; the expanded tier's column is part of it.
	// Covering is what keeps the chat's interrupt off the press that closes the
	// drawer: it is a sibling `document` listener, and if it was registered
	// first it runs before the mark above is made.
	useCoverPage(isOpen && !isExpanded);

	// Focus goes to the panel rather than to its first control, as a `Sheet`'s
	// does to the sheet: landing inside the dialog reads its name, and the first
	// stop would only be whatever control the content happens to put first.
	// Handing focus back on close is `AppShell`'s, because only it saw the
	// opener: the page behind goes `inert` in the commit that opens the drawer,
	// which drops focus off the opener before any effect here could note it.
	const drawerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (isOpen && !isExpanded) {
			drawerRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen, isExpanded]);

	// The column takes focus the same way when it is expanded back — a change of
	// `isOpen` within the tier, which only the expand button makes. Mounting
	// with the stored state and crossing tiers are not presses, so they leave
	// focus where it was.
	const columnRef = useRef<HTMLElement>(null);
	const prevRef = useRef({ isOpen, isExpanded });
	useEffect(() => {
		const prev = prevRef.current;
		prevRef.current = { isOpen, isExpanded };
		if (isExpanded && prev.isExpanded && isOpen && !prev.isOpen) {
			columnRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen, isExpanded]);

	const columnId = useId();

	// Expanded: a column in the flex layout. Collapsed, it is hidden rather
	// than unmounted, for the same reason the drawer is: the open tab, its
	// scroll position and the file tree's expanded folders are still there
	// when it comes back. The width is left alone, so it comes back as wide.
	if (isExpanded) {
		return (
			// No height of its own: the row gives it, the way the chat panel
			// beside it takes its own. Restating `h-dvh` here made the column
			// outrun a row the shell had already shortened by its banners
			// (docs/responsive-ui.md § Who owns the scroll boundary).
			//
			// outline-none: focused on expand only to announce the region, as
			// the drawer's panel is on open.
			<aside
				ref={columnRef}
				id={columnId}
				aria-label="Sidebar"
				tabIndex={-1}
				className={`relative shrink-0 flex-col border-r border-th-border bg-th-bg-secondary outline-none ${isOpen ? "flex" : "hidden"}`}
				style={{ width: resize.width }}
			>
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
				<ResizeHandle
					resize={resize}
					label="Resize sidebar"
					controls={columnId}
				/>
			</aside>
		);
	}

	// Compact and regular: overlay drawer (use CSS hiding to preserve scroll position)
	//
	// A modal dialog: `AppShell` makes everything behind it `inert` while it is
	// open, so Tab and a screen reader stay inside without a trap of its own.
	// The backdrop is inside the dialog on purpose — it is the one close control
	// the drawer guarantees whatever content it holds, and a touch screen reader
	// has no Escape to reach for.
	return (
		<div
			className={isOpen ? undefined : "hidden"}
			role="dialog"
			aria-modal="true"
			aria-label="Sidebar"
		>
			<button
				type="button"
				className="fixed inset-0 z-40 bg-th-bg-overlay"
				onClick={onClose}
				aria-label="Close sidebar"
			/>

			{/* The viewport less 56px, up to 400px: the strip of chat left showing
			    says this is a drawer over it, is where a tap closes it, and shows
			    where that tap goes back to.
			    outline-none: focused on open only to announce the dialog, and a
			    ring around the whole panel would read as a control. */}
			<div
				ref={drawerRef}
				tabIndex={-1}
				className="fixed inset-y-0 left-0 z-50 flex w-[calc(100%-56px)] max-w-100 flex-col bg-th-bg-secondary outline-none"
			>
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
			</div>
		</div>
	);
}

export default Sidebar;
