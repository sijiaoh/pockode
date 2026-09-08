import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
	label: string;
	/** Given together for a collapsible group; the label area then toggles it. */
	isExpanded?: boolean;
	onToggle?: () => void;
	/** L5 icon buttons for the group as a whole. */
	actions?: ReactNode;
}

/**
 * A label on the list, not a header for the panel — that is the branch bar's
 * job, and it is the only row that should read like one.
 *
 * Sticky within the group it labels, so a long list keeps its count and its
 * actions reachable while it scrolls. Sticky resolves against the scroll
 * container rather than the transformed box `PullToRefresh` puts it in, so the
 * pull gesture carries the header along with the content.
 */
function GroupHeader({ label, isExpanded, onToggle, actions }: Props) {
	const text = (
		<span className="min-w-0 flex-1 truncate text-xs uppercase tracking-wide text-th-text-muted">
			{label}
		</span>
	);

	return (
		<div className="sticky top-0 z-10 flex min-h-[32px] items-center gap-2 bg-th-bg-secondary px-3">
			{onToggle ? (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={isExpanded}
					className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
				>
					{isExpanded ? (
						<ChevronDown
							className="h-3.5 w-3.5 shrink-0 text-th-text-muted"
							aria-hidden="true"
						/>
					) : (
						<ChevronRight
							className="h-3.5 w-3.5 shrink-0 text-th-text-muted"
							aria-hidden="true"
						/>
					)}
					{text}
				</button>
			) : (
				text
			)}
			{actions}
		</div>
	);
}

export default GroupHeader;
