import { ListFilter } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import { useSessionStore } from "../../lib/sessionStore";
import { BadgeDot } from "../ui";
import ResponsivePanel from "../ui/ResponsivePanel";
import FilterOption from "./FilterOption";

export default function SessionFilterButton() {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const isDesktop = useIsDesktop();

	const hideTaskSessions = useSessionStore((s) => s.hideTaskSessions);
	const toggleHide = useSessionStore((s) => s.toggleHideTaskSessions);

	const hasActiveFilter = hideTaskSessions;

	const handleClose = useCallback(() => setIsOpen(false), []);
	const handleToggle = useCallback(() => setIsOpen((v) => !v), []);

	const ariaLabel = hasActiveFilter
		? "Filter sessions (1 active)"
		: "Filter sessions";

	return (
		<div className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={handleToggle}
				className={`relative flex items-center justify-center rounded-md border min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
					hasActiveFilter
						? "border-th-accent/40 bg-th-bg-tertiary text-th-accent hover:border-th-accent hover:text-th-accent"
						: "border-th-border bg-th-bg-tertiary text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary"
				}`}
				aria-label={ariaLabel}
				aria-expanded={isOpen}
			>
				<ListFilter className="h-5 w-5" aria-hidden="true" />
				<BadgeDot show={hasActiveFilter} className="top-1 right-1" />
			</button>

			<ResponsivePanel
				isOpen={isOpen}
				onClose={handleClose}
				title="Filter sessions"
				triggerRef={triggerRef}
				isDesktop={isDesktop}
				desktopPosition="right"
				mobileMaxHeight="50dvh"
			>
				<div className="py-2">
					<FilterOption
						label="Hide task sessions"
						description="Sessions linked to tasks will be hidden from the list"
						checked={hideTaskSessions}
						onChange={toggleHide}
					/>
				</div>
			</ResponsivePanel>
		</div>
	);
}
