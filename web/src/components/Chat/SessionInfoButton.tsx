import { useIsExpanded } from "@pockode/shared";
import { Info } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { SessionUsage } from "../../types/message";
import ResponsivePanel from "../ui/ResponsivePanel";
import SessionUsageSection from "./SessionUsageSection";
import SessionWorkSection from "./SessionWorkSection";

interface Props {
	/** Which session the panel describes; its sections read their own data. */
	sessionId: string;
	/** Undefined until the session's detail arrives; the panel says so. */
	usage?: SessionUsage;
	isForked: boolean;
	/** Absent when the embedder has no work pages to open. */
	onOpenWorkDetail?: (workId: string) => void;
}

/**
 * Facts about this session, behind one button on the action bar. Usage is one of
 * them and deliberately not the only one — the work this session runs sits above
 * it — which is why the button is named after the session rather than after
 * tokens: a control labelled "usage" would have to be renamed or duplicated the
 * first time anything else belongs in here.
 *
 * It carries no number, no percentage, no badge and no colour. The bar is the
 * session's controls and is already full at 360px, and a figure parked here
 * would re-label the button as a meter — the one thing a door to the next four
 * features must not become. The cost is that context pressure is a tap away
 * rather than a glance; announcing that without a tap is its own signal's job
 * (an inline warning above the input bar), not this button's.
 */
function SessionInfoButton({
	sessionId,
	usage,
	isForked,
	onOpenWorkDetail,
}: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const isExpanded = useIsExpanded();

	const handleClose = useCallback(() => setIsOpen(false), []);

	return (
		<div className="relative">
			{/* Never disabled and never waiting for data, unlike the two chips beside
			    it: a control that appeared after the first turn is one the user has
			    to discover twice. */}
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setIsOpen((v) => !v)}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				aria-label="Session info"
				className="group flex size-9 shrink-0 items-center justify-center rounded border border-th-border bg-th-bg-tertiary transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 hover:border-th-border-focus pointer-coarse:size-11"
			>
				<Info
					className="size-4 text-th-text-secondary group-hover:text-th-text-primary"
					aria-hidden="true"
				/>
			</button>

			<ResponsivePanel
				isOpen={isOpen}
				onClose={handleClose}
				title="Session info"
				triggerRef={triggerRef}
				isExpanded={isExpanded}
				desktopPosition="left"
				desktopPlacement="above"
			>
				{/* The panel supplies neither padding nor scrolling; each section owns
				    its own `px-3`. Sections are listed here and nowhere else — this
				    component owns their order and nothing about their contents. */}
				<div className="overflow-y-auto pb-2">
					{/* Before Usage: what this session is comes before what it has
					    spent. */}
					<SessionWorkSection
						sessionId={sessionId}
						onOpenWorkDetail={onOpenWorkDetail}
						onClose={handleClose}
					/>
					<SessionUsageSection usage={usage} isForked={isForked} />
				</div>
			</ResponsivePanel>
		</div>
	);
}

export default SessionInfoButton;
