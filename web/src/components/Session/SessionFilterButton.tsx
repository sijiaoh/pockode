import { ListFilter } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import { useSessionStore } from "../../lib/sessionStore";
import ResponsivePanel from "../ui/ResponsivePanel";
import FilterOption from "./FilterOption";

export default function SessionFilterButton() {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const isDesktop = useIsDesktop();

	const showTaskSessions = useSessionStore((s) => s.showTaskSessions);
	const toggleShow = useSessionStore((s) => s.toggleShowTaskSessions);

	const handleClose = useCallback(() => setIsOpen(false), []);
	const handleToggle = useCallback(() => setIsOpen((v) => !v), []);

	return (
		<div className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={handleToggle}
				className="relative flex items-center justify-center rounded-md border min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 border-th-border bg-th-bg-tertiary text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary"
				aria-label="Filter sessions"
				aria-expanded={isOpen}
			>
				<ListFilter className="h-5 w-5" aria-hidden="true" />
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
						label="Show subtask sessions"
						description="Include sessions linked to subtasks in the list"
						checked={showTaskSessions}
						onChange={toggleShow}
					/>
				</div>
			</ResponsivePanel>
		</div>
	);
}
